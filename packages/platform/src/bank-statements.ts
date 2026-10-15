import { createHash, randomUUID } from 'node:crypto';
import { Events, STATEMENT_IMPORT_MAX_ROWS, type StatementMapping } from '@uk/contracts';
import { conflict, notFound, unprocessable } from '@uk/core';
import { Prisma, type Database, type Tx } from '@uk/db';
import { auditRow } from './audit';
import { publishEvent } from './outbox';

/**
 * Bank statement import (M7a; DEC-040, ADR-61). The ONLY writer of `bank_statement_import` and `bank_statement_line` (architecture-tested). It parses
 * and stages what the bank says; it never posts and may not import the accounting package. A file is imported all or nothing: one invalid row fails
 * the import and nothing is stored. Overlapping statements import cleanly: a line whose fingerprint already exists for the account is skipped.
 */
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MAX_ERRORS = 100;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export interface RowError { row: number; message: string }
export interface StatementRow { sourceRow: number; date: string; description: string; reference: string | null; amount: string; balance: string | null }

/** RFC 4180: quoted fields, doubled quotes, delimiters and line breaks inside quotes, CRLF or LF, an optional byte-order mark. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false, i = 0;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < s.length) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } quoted = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += c === '\r' && s[i + 1] === '\n' ? 2 : 1; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Bytes to text: UTF-8 when valid, otherwise Windows-1252/Latin-1 (what many UK bank exports use for "£"). */
export function decodeStatement(data: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return new TextDecoder('windows-1252').decode(data); }
}

export function parseStatementDate(raw: string, format: StatementMapping['dateFormat']): string | null {
  const v = raw.trim();
  let y: number, m: number, d: number, mm: RegExpMatchArray | null;
  switch (format) {
    case 'DD/MM/YYYY': if (!(mm = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return null; [d, m, y] = [+mm[1]!, +mm[2]!, +mm[3]!]; break;
    case 'DD/MM/YY': if (!(mm = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/))) return null; [d, m, y] = [+mm[1]!, +mm[2]!, 2000 + +mm[3]!]; break;
    case 'DD-MM-YYYY': if (!(mm = v.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/))) return null; [d, m, y] = [+mm[1]!, +mm[2]!, +mm[3]!]; break;
    case 'MM/DD/YYYY': if (!(mm = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))) return null; [m, d, y] = [+mm[1]!, +mm[2]!, +mm[3]!]; break;
    case 'YYYY-MM-DD': if (!(mm = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return null; [y, m, d] = [+mm[1]!, +mm[2]!, +mm[3]!]; break;
    case 'DD MMM YYYY': {
      if (!(mm = v.match(/^(\d{1,2})[ -]([A-Za-z]{3,9})[ -](\d{4})$/))) return null;
      const idx = MONTHS.indexOf(mm[2]!.slice(0, 3).toUpperCase());
      if (idx < 0) return null;
      [d, m, y] = [+mm[1]!, idx + 1, +mm[3]!]; break;
    }
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return isoDay(dt);
}

/** "1,234.56", "£1,234.56", "-12.00", "(12.00)", "12.00-" -> a signed decimal string; "" -> null; anything else -> undefined (invalid). */
export function parseStatementAmount(raw: string, minor: number): string | null | undefined {
  let v = raw.trim();
  if (v === '') return null;
  let neg = false;
  if (/^\(.*\)$/.test(v)) { neg = true; v = v.slice(1, -1); }
  v = v.replace(/[£$€\s]/g, '').replace(/,/g, '');
  if (v.startsWith('-')) { neg = !neg; v = v.slice(1); } else if (v.startsWith('+')) v = v.slice(1);
  if (v.endsWith('-')) { neg = !neg; v = v.slice(0, -1); }
  if (!/^\d+(\.\d+)?$/.test(v)) return undefined;
  const [int, frac = ''] = v.split('.');
  if (frac.length > minor) return undefined;
  const scaled = BigInt(int! + frac.padEnd(minor, '0'));
  return toDecimal(neg ? -scaled : scaled, minor);
}
const toDecimal = (scaled: bigint, minor: number) => {
  const neg = scaled < 0n, abs = (neg ? -scaled : scaled).toString().padStart(minor + 1, '0');
  return `${neg ? '-' : ''}${minor ? `${abs.slice(0, -minor)}.${abs.slice(-minor)}` : abs}`;
};
const toScaled = (dec: string, minor: number) => { const neg = dec.startsWith('-'); const [i, f = ''] = (neg ? dec.slice(1) : dec).split('.'); const v = BigInt(i! + f.padEnd(minor, '0')); return neg ? -v : v; };

/**
 * Turns parsed CSV rows into statement lines in date order, or row errors. Everything is checked before anything is stored (all or nothing):
 * columns exist, dates valid and within [openingDate, today], amounts valid with the account's decimals and non-zero, and - when a running-balance
 * column is mapped - every balance equals the previous one plus the amount, in the file's order (oldest first or newest first, either is accepted).
 */
export function parseStatement(rows: string[][], mapping: StatementMapping, o: { minor: number; today: string; openingDate?: string }): { lines: StatementRow[]; errors: RowError[]; rowsRead: number } {
  const errors: RowError[] = [];
  const err = (row: number, message: string) => { if (errors.length < MAX_ERRORS) errors.push({ row, message }); };
  const header = mapping.hasHeader ? (rows[0] ?? []).map((h) => h.trim().toLowerCase()) : null;
  const colIndex = (c: string | number | undefined, name: string): number | undefined => {
    if (c === undefined) return undefined;
    if (typeof c === 'number') return c - 1;
    if (!header) { err(1, `Column "${c}" is named, but the file has no header row: give its position (1, 2, ...) instead`); return -1; }
    const i = header.indexOf(c.trim().toLowerCase());
    if (i < 0) err(1, `The ${name} column "${c}" is not in the header row`);
    return i;
  };
  const cols = {
    date: colIndex(mapping.dateColumn, 'date')!, description: colIndex(mapping.descriptionColumn, 'description')!, reference: colIndex(mapping.referenceColumn, 'reference'),
    amount: colIndex(mapping.amountColumn, 'amount'), moneyIn: colIndex(mapping.moneyInColumn, 'money-in'), moneyOut: colIndex(mapping.moneyOutColumn, 'money-out'), balance: colIndex(mapping.balanceColumn, 'balance'),
  };
  if (errors.length > 0) return { lines: [], errors, rowsRead: 0 };
  const body = rows.map((r, i) => ({ r, n: i + 1 })).slice(mapping.hasHeader ? 1 : 0).filter(({ r }) => r.some((f) => f.trim() !== ''));
  if (body.length === 0) return { lines: [], errors: [{ row: 1, message: 'The file has no statement lines' }], rowsRead: 0 };
  if (body.length > STATEMENT_IMPORT_MAX_ROWS) return { lines: [], errors: [{ row: 1, message: `A statement holds at most ${STATEMENT_IMPORT_MAX_ROWS} lines; split the file` }], rowsRead: body.length };
  const cell = (r: string[], i: number | undefined) => (i === undefined || i < 0 ? '' : (r[i] ?? '').trim());
  const parsed: (StatementRow & { scaled: bigint; balScaled: bigint | null })[] = [];
  for (const { r, n } of body) {
    const before = errors.length;
    const date = parseStatementDate(cell(r, cols.date), mapping.dateFormat);
    if (!date) err(n, `"${cell(r, cols.date)}" is not a date in the format ${mapping.dateFormat}`);
    else if (date > o.today) err(n, `${date} is in the future`);
    else if (o.openingDate && date < o.openingDate) err(n, `${date} is before the account's statement opening date ${o.openingDate}`);
    const description = cell(r, cols.description).replace(/\s+/g, ' ');
    if (!description) err(n, 'The description is empty');
    let amount: string | null | undefined;
    if (cols.amount !== undefined) {
      amount = parseStatementAmount(cell(r, cols.amount), o.minor);
      if (amount && mapping.invertSign) amount = amount.startsWith('-') ? amount.slice(1) : `-${amount}`;
      if (amount === null) err(n, 'The amount is empty');
    } else {
      const inn = parseStatementAmount(cell(r, cols.moneyIn), o.minor), out = parseStatementAmount(cell(r, cols.moneyOut), o.minor);
      if (inn === undefined || out === undefined) amount = undefined;
      else {
        const i = inn && toScaled(inn, o.minor) !== 0n ? inn : null, x = out && toScaled(out, o.minor) !== 0n ? out : null;
        if (i?.startsWith('-') || x?.startsWith('-')) { err(n, 'Money-in and money-out amounts are given without a sign'); amount = null; }
        else if (i && x) { err(n, 'Both money in and money out are filled in'); amount = null; }
        else if (!i && !x) { err(n, 'Neither money in nor money out is filled in'); amount = null; }
        else amount = i ?? `-${x}`;
      }
    }
    if (amount === undefined) err(n, `The amount is not a number with at most ${o.minor} decimal places`);
    else if (amount !== null && toScaled(amount, o.minor) === 0n) err(n, 'The amount is zero');
    let balance: string | null = null;
    if (cols.balance !== undefined) {
      const b = parseStatementAmount(cell(r, cols.balance), o.minor);
      if (b === undefined || b === null) err(n, 'The balance is missing or not a number');
      else balance = b;
    }
    if (errors.length > before || !date || !amount) continue;
    parsed.push({ sourceRow: n, date, description: description.slice(0, 500), reference: cell(r, cols.reference).slice(0, 200) || null, amount, balance,
      scaled: toScaled(amount, o.minor), balScaled: balance === null ? null : toScaled(balance, o.minor) });
  }
  if (errors.length > 0) return { lines: [], errors, rowsRead: body.length };

  let ordered = parsed;
  if (cols.balance !== undefined) {
    const holds = (seq: typeof parsed) => seq.findIndex((x, i) => i > 0 && x.balScaled !== seq[i - 1]!.balScaled! + x.scaled);
    const asc = holds(parsed), desc = holds([...parsed].reverse());
    if (asc === -1) ordered = parsed;
    else if (desc === -1) ordered = [...parsed].reverse();
    else {
      const bad = parsed[0]!.date > parsed[parsed.length - 1]!.date ? [...parsed].reverse()[desc]! : parsed[asc]!;
      return { lines: [], errors: [{ row: bad.sourceRow, message: 'The running balance does not equal the previous balance plus this amount: the file or the column mapping is wrong' }], rowsRead: body.length };
    }
    const out = ordered.findIndex((x, i) => i > 0 && x.date < ordered[i - 1]!.date);
    if (out >= 0) return { lines: [], errors: [{ row: ordered[out]!.sourceRow, message: 'The lines are not in date order, so the running balance cannot be checked' }], rowsRead: body.length };
  } else {
    if (parsed[0]!.date > parsed[parsed.length - 1]!.date) ordered = [...parsed].reverse();
    ordered = ordered.map((x, i) => ({ x, i })).sort((a, b) => (a.x.date < b.x.date ? -1 : a.x.date > b.x.date ? 1 : a.i - b.i)).map(({ x }) => x);
  }
  return { lines: ordered.map(({ scaled: _s, balScaled: _b, ...l }) => l), errors: [], rowsRead: body.length };
}

/** The line's identity at the bank: identical lines in one file are told apart by their occurrence number, so two genuine identical payments both stay. */
export function fingerprintLines(bankAccountId: string, lines: StatementRow[]): string[] {
  const seen = new Map<string, number>();
  return lines.map((l) => {
    const key = [l.date, l.amount, l.description.toUpperCase(), (l.reference ?? '').toUpperCase()].join('\u0001');
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return createHash('sha256').update([bankAccountId, key, String(n)].join('\u0001')).digest('hex');
  });
}

export interface StatementStorage { getObject(key: string): Promise<Buffer> }

export class BankStatementService {
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }

  /** Records the request (QUEUED). The caller enqueues `bank.statement.import` after the transaction commits and then calls {@link attachJob}. */
  async request(tx: Tx, a: { organisationId: string; companyId: string; userId: string; bankAccountId: string; documentId: string; versionId: string; mapping: StatementMapping; duplicateOverrideReason?: string }) {
    const bank = await tx.bankAccount.findFirst({ where: { id: a.bankAccountId, companyId: a.companyId } });
    if (!bank) throw notFound('Bank account not found');
    if (bank.status !== 'ACTIVE') throw conflict('Statements are imported into an active bank account', 'bank_account_closed');
    const v = await tx.documentVersion.findFirst({ where: { id: a.versionId, documentId: a.documentId }, include: { document: { select: { companyId: true } } } });
    if (!v) throw notFound('Document version not found');
    if (v.document.companyId !== a.companyId) throw unprocessable('The statement must be a document of this company', 'document_company_mismatch');
    if (v.status !== 'AVAILABLE' || !v.sha256) throw conflict(`The document is ${v.status.toLowerCase()}; only a scanned, available file can be imported`, 'document_not_available');
    const earlier = await tx.bankStatementImport.findMany({ where: { bankAccountId: bank.id, fileSha256: v.sha256, status: { in: ['QUEUED', 'COMPLETED'] } }, select: { id: true }, take: 5 });
    if (earlier.length > 0 && !a.duplicateOverrideReason) {
      throw conflict('This file was already imported into this bank account; give a duplicateOverrideReason to import it again (lines already present are skipped either way)', 'statement_already_imported', { imports: earlier.map((x) => x.id) });
    }
    const id = randomUUID();
    await tx.bankStatementImport.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, bankAccountId: bank.id, documentId: a.documentId, documentVersionId: v.id,
      fileSha256: v.sha256, mapping: a.mapping as unknown as Prisma.InputJsonValue, duplicateOverrideReason: earlier.length > 0 ? a.duplicateOverrideReason!.trim() : null, requestedByUserId: a.userId } });
    await this.audit(tx, { action: 'bank_statement.import_requested', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.userId, entityType: 'bank_statement_import', entityId: id,
      after: { bankAccountId: bank.id, documentVersionId: v.id, sha256: v.sha256 }, reason: a.duplicateOverrideReason ?? null, metadata: { duplicateFile: earlier.length > 0 } });
    return this.getImport(tx, a.companyId, id);
  }

  async attachJob(tx: Tx, importId: string, jobId: string) {
    await tx.bankStatementImport.updateMany({ where: { id: importId, status: 'QUEUED', jobId: null }, data: { jobId } });
  }

  /** The worker's step (job `bank.statement.import`). Idempotent: an import that is no longer QUEUED is left alone. Returns the outcome for the job record. */
  async process(db: Database, storage: StatementStorage, a: { organisationId: string; userId?: string; importId: string; progress?: (p: number, m?: string) => Promise<void> }) {
    const ctx = { organisationId: a.organisationId, userId: a.userId };
    const progress = a.progress ?? (async () => undefined);
    const prep = await db.tenant(ctx, async (tx) => {
      const imp = await tx.bankStatementImport.findUnique({ where: { id: a.importId } });
      if (!imp || imp.status !== 'QUEUED') return null;
      const v = await tx.documentVersion.findUnique({ where: { id: imp.documentVersionId } });
      const bank = await tx.bankAccount.findUniqueOrThrow({ where: { id: imp.bankAccountId } });
      const minor = (await tx.currency.findUnique({ where: { code: bank.currency } }))?.minorUnits ?? 2;
      return { imp, v, bank, minor };
    });
    if (!prep) return { skipped: true };
    const { imp, v, bank, minor } = prep;
    const fail = async (errors: RowError[], rowsRead = 0) => {
      await db.tenant(ctx, async (tx) => {
        await tx.bankStatementImport.update({ where: { id: imp.id }, data: { status: 'FAILED', errors: errors as unknown as Prisma.InputJsonValue, rowsRead, completedAt: new Date() } });
        await this.audit(tx, { action: 'bank_statement.import_failed', organisationId: a.organisationId, companyId: imp.companyId, actorUserId: imp.requestedByUserId, entityType: 'bank_statement_import', entityId: imp.id,
          metadata: { errors: errors.length, firstError: errors[0] ?? null } });
      });
      return { status: 'FAILED', errors: errors.length };
    };
    if (!v || v.status !== 'AVAILABLE') return fail([{ row: 0, message: 'The document is no longer available' }]);
    await progress(10, 'reading');
    const data = await storage.getObject(v.storageKey);
    if (createHash('sha256').update(data).digest('hex') !== imp.fileSha256) return fail([{ row: 0, message: 'The stored file does not match the file that was requested' }]);
    const mapping = imp.mapping as unknown as StatementMapping;
    await progress(30, 'checking');
    const parsed = parseStatement(parseCsv(decodeStatement(data), mapping.delimiter), mapping, { minor, today: isoDay(new Date()), openingDate: isoDay(bank.statementOpeningDate) });
    if (parsed.errors.length > 0) return fail(parsed.errors, parsed.rowsRead);
    await progress(60, 'storing');
    const prints = fingerprintLines(bank.id, parsed.lines);
    return db.tenant(ctx, async (tx) => {
      const existing = new Set<string>();
      for (let i = 0; i < prints.length; i += 1000) {
        for (const r of await tx.bankStatementLine.findMany({ where: { bankAccountId: bank.id, voided: false, fingerprint: { in: prints.slice(i, i + 1000) } }, select: { fingerprint: true } })) existing.add(r.fingerprint);
      }
      const fresh = parsed.lines.map((l, i) => ({ l, fp: prints[i]! })).filter((x) => !existing.has(x.fp));
      for (let i = 0; i < fresh.length; i += 1000) {
        await tx.bankStatementLine.createMany({ data: fresh.slice(i, i + 1000).map(({ l, fp }, k) => ({
          organisationId: a.organisationId, companyId: imp.companyId, bankAccountId: bank.id, importId: imp.id, lineNo: i + k + 1, sourceRow: l.sourceRow,
          transactionDate: new Date(`${l.date}T00:00:00.000Z`), description: l.description, reference: l.reference, amount: new Prisma.Decimal(l.amount), balance: l.balance === null ? null : new Prisma.Decimal(l.balance), fingerprint: fp,
        })) });
      }
      const sum = parsed.lines.reduce((t, l) => t.plus(l.amount), new Prisma.Decimal(0));
      const last = parsed.lines[parsed.lines.length - 1]!;
      const closing = last.balance === null ? null : new Prisma.Decimal(last.balance);
      const out = { rowsRead: parsed.rowsRead, rowsImported: fresh.length, rowsDuplicate: parsed.lines.length - fresh.length, firstDate: parsed.lines[0]!.date, lastDate: last.date };
      await tx.bankStatementImport.update({ where: { id: imp.id }, data: { status: 'COMPLETED', ...out, errors: Prisma.DbNull, firstDate: new Date(`${out.firstDate}T00:00:00.000Z`), lastDate: new Date(`${out.lastDate}T00:00:00.000Z`),
        closingBalance: closing, openingBalance: closing ? closing.minus(sum) : null, completedAt: new Date() } });
      await this.audit(tx, { action: 'bank_statement.imported', organisationId: a.organisationId, companyId: imp.companyId, actorUserId: imp.requestedByUserId, entityType: 'bank_statement_import', entityId: imp.id, after: out });
      await publishEvent(tx, Events.bankStatementImported, { aggregateId: imp.id, organisationId: a.organisationId, actorUserId: imp.requestedByUserId,
        payload: { importId: imp.id, companyId: imp.companyId, bankAccountId: bank.id, ...out } });
      await progress(100, 'COMPLETED');
      return { status: 'COMPLETED', ...out };
    });
  }

  /** DEC-040: a wrongly mapped import is voided while none of its lines is matched; its lines stay visible as void and their fingerprints are released. */
  async void(tx: Tx, a: { organisationId: string; companyId: string; userId: string; importId: string; reason: string }) {
    await tx.$queryRaw`SELECT id FROM bank_statement_import WHERE id = ${a.importId}::uuid FOR UPDATE`;
    const imp = await tx.bankStatementImport.findFirst({ where: { id: a.importId, companyId: a.companyId } });
    if (!imp) throw notFound('Statement import not found');
    if (imp.status !== 'COMPLETED') throw conflict(`A ${imp.status.toLowerCase()} import cannot be voided`, 'import_not_completed');
    const matched = await tx.bankStatementLine.count({ where: { importId: imp.id, NOT: { matchedAmount: 0 } } });
    if (matched > 0) throw conflict(`${matched} line(s) of this import are matched; unmatch them first`, 'import_has_matches');
    await tx.bankStatementImport.update({ where: { id: imp.id }, data: { status: 'VOID', voidedByUserId: a.userId, voidedAt: new Date(), voidReason: a.reason.trim() } });
    await this.audit(tx, { action: 'bank_statement.import_voided', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.userId, entityType: 'bank_statement_import', entityId: imp.id,
      before: { status: 'COMPLETED' }, after: { status: 'VOID' }, reason: a.reason });
    return this.getImport(tx, a.companyId, imp.id);
  }

  async getImport(tx: Tx, companyId: string, id: string) {
    const i = await tx.bankStatementImport.findFirst({ where: { id, companyId } });
    if (!i) throw notFound('Statement import not found');
    return this.importView(i);
  }
  private importView(i: Awaited<ReturnType<Tx['bankStatementImport']['findUniqueOrThrow']>>) {
    return { id: i.id, companyId: i.companyId, bankAccountId: i.bankAccountId, documentId: i.documentId, documentVersionId: i.documentVersionId, fileSha256: i.fileSha256, mapping: i.mapping,
      status: i.status, jobId: i.jobId, rowsRead: i.rowsRead, rowsImported: i.rowsImported, rowsDuplicate: i.rowsDuplicate, errors: (i.errors as RowError[] | null) ?? [],
      firstDate: i.firstDate ? isoDay(i.firstDate) : null, lastDate: i.lastDate ? isoDay(i.lastDate) : null, openingBalance: i.openingBalance?.toFixed(2) ?? null, closingBalance: i.closingBalance?.toFixed(2) ?? null,
      duplicateOverrideReason: i.duplicateOverrideReason, requestedByUserId: i.requestedByUserId, requestedAt: i.requestedAt, completedAt: i.completedAt,
      voidedByUserId: i.voidedByUserId, voidedAt: i.voidedAt, voidReason: i.voidReason };
  }
  async listImports(tx: Tx, companyId: string, bankAccountId: string, q: { limit: number; cursor?: string }) {
    const rows = await tx.bankStatementImport.findMany({ where: { companyId, bankAccountId }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}) });
    return { items: rows.slice(0, q.limit).map((r) => this.importView(r)), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  async listLines(tx: Tx, companyId: string, bankAccountId: string, q: { status?: 'UNMATCHED' | 'PARTIAL' | 'MATCHED' | 'VOID'; importId?: string; from?: string; to?: string; limit: number; cursor?: string }) {
    const bank = await tx.bankAccount.findFirst({ where: { id: bankAccountId, companyId } });
    if (!bank) throw notFound('Bank account not found');
    const minor = (await tx.currency.findUnique({ where: { code: bank.currency } }))?.minorUnits ?? 2;
    const statusWhere: Prisma.BankStatementLineWhereInput = q.status === 'VOID' ? { voided: true } : q.status === 'UNMATCHED' ? { voided: false, matchedAmount: 0 } : q.status ? { voided: false, NOT: { matchedAmount: 0 } } : {};
    const rows = await tx.bankStatementLine.findMany({
      where: { companyId, bankAccountId, ...statusWhere, ...(q.importId ? { importId: q.importId } : {}),
        ...(q.from || q.to ? { transactionDate: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00.000Z`) } : {}), ...(q.to ? { lte: new Date(`${q.to}T00:00:00.000Z`) } : {}) } } : {}) },
      orderBy: [{ transactionDate: 'asc' }, { createdAt: 'asc' }, { lineNo: 'asc' }], take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const view = rows.slice(0, q.limit).map((l) => statementLineView(l, minor)).filter((l) => !q.status || l.status === q.status);
    return { currency: bank.currency, items: view, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }
}

export function statementLineView(l: Awaited<ReturnType<Tx['bankStatementLine']['findUniqueOrThrow']>>, minor: number) {
  const status = l.voided ? 'VOID' : l.matchedAmount.isZero() ? 'UNMATCHED' : l.matchedAmount.equals(l.amount) ? 'MATCHED' : 'PARTIAL';
  return { id: l.id, bankAccountId: l.bankAccountId, importId: l.importId, lineNo: l.lineNo, sourceRow: l.sourceRow, date: isoDay(l.transactionDate), description: l.description, reference: l.reference,
    amount: l.amount.toFixed(minor), balance: l.balance?.toFixed(minor) ?? null, matched: l.matchedAmount.toFixed(minor), unmatched: l.amount.minus(l.matchedAmount).toFixed(minor), status };
}
