import { createHash } from 'node:crypto';
import { MANUAL_PUBLISHER, MAX_RATE_IMPORT_ROWS, RATE_LOOKUP_WINDOW_DAYS, type RateKind } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable, uuidv7 } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import { money, type Money } from './money';

/**
 * Foreign-currency foundation (M3; ADR-50, ADR-55; DEC-016 rate source, DEC-017 rounding, DEC-018 revaluation and realised FX).
 * Everything here is exact decimal arithmetic. Journals are still written only by the PostingService; this file never inserts a journal row.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const addDays = (s: string, n: number) => isoDay(new Date(toDate(s).getTime() + n * 86_400_000));
const CCY = /^[A-Z]{3}$/;

// ───────────── Conversion and rounding (DEC-017) ─────────────
/**
 * original x rate, rounded half-up (half away from zero) to the functional currency's minor units. The ONE conversion function: the
 * PostingService, revaluation and realised-FX code call it, and the database line guard re-proves it with PostgreSQL's round().
 */
export const convert = (original: Money, rate: Money, minorUnits: number): Money => original.mul(rate).toDecimalPlaces(minorUnits, Prisma.Decimal.ROUND_HALF_UP);

/** Largest rounding difference the posting may absorb: one minor unit per line (DEC-017). */
export const roundingTolerance = (lineCount: number, minorUnits: number): Money => money(1).div(money(10).pow(minorUnits)).mul(lineCount);

/**
 * Realised FX at settlement (DEC-018): the functional value carried for the settled original amount versus its value at the settlement rate.
 * A positive difference is a gain for an asset settlement (more functional currency received than carried) and a loss for a liability; the caller
 * (receipts in M5, payments in M6) chooses the account side. `carryingFunctional` is the whole balance, `settledOriginal / totalOriginal` the share.
 */
export function settle(a: { totalOriginal: Money; settledOriginal: Money; carryingFunctional: Money; settlementRate: Money; minorUnits: number }) {
  if (a.totalOriginal.isZero()) throw unprocessable('Nothing is outstanding to settle', 'nothing_to_settle');
  if (a.settledOriginal.isNegative() || a.settledOriginal.greaterThan(a.totalOriginal)) throw unprocessable('The settled amount must be between zero and the outstanding amount', 'invalid_amount');
  const full = a.settledOriginal.equals(a.totalOriginal);
  // a full settlement clears the carried balance exactly (no residue); a partial one prorates it, rounded half-up
  const carriedShare = full ? a.carryingFunctional : a.carryingFunctional.mul(a.settledOriginal).div(a.totalOriginal).toDecimalPlaces(a.minorUnits, Prisma.Decimal.ROUND_HALF_UP);
  const settlementFunctional = convert(a.settledOriginal, a.settlementRate, a.minorUnits);
  return { carriedShare, settlementFunctional, difference: settlementFunctional.minus(carriedShare) };
}

// ───────────── Rates ─────────────
export interface RateActor { userId: string; can(permission: string, companyId: string): boolean | Promise<boolean> }
export interface ResolvedRate { id: string; rate: Money; from: string; to: string; kind: string; publisher: string; series: string | null; verified: boolean; validFrom: string; validTo: string }
type RateRow = Awaited<ReturnType<Tx['exchangeRate']['findUniqueOrThrow']>>;

export const rateView = (r: RateRow) => ({
  id: r.id, fromCurrency: r.fromCurrency, toCurrency: r.toCurrency, kind: r.kind, validFrom: isoDay(r.validFrom), validTo: isoDay(r.validTo), rate: r.rate.toFixed(8),
  sourceKind: r.sourceKind, publisher: r.publisher, series: r.series, sourceUrl: r.sourceUrl, sourceRef: r.sourceRef, retrievedAt: r.retrievedAt, enteredByUserId: r.enteredByUserId,
  importBatchId: r.importBatchId, verificationStatus: r.verificationStatus, verifiedByUserId: r.verifiedByUserId, verifiedAt: r.verifiedAt, supersededById: r.supersededById, createdAt: r.createdAt,
});
export type RateView = ReturnType<typeof rateView>;

const toResolved = (r: RateRow): ResolvedRate => ({ id: r.id, rate: r.rate, from: r.fromCurrency, to: r.toCurrency, kind: r.kind, publisher: r.publisher, series: r.series, verified: r.verificationStatus === 'VERIFIED', validFrom: isoDay(r.validFrom), validTo: isoDay(r.validTo) });

export class RateService {
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }

  private async functional(tx: Tx, companyId: string): Promise<string> {
    const c = await tx.company.findUnique({ where: { id: companyId }, select: { baseCurrency: true } });
    if (!c) throw notFound('Company not found');
    return c.baseCurrency;
  }
  private async assertCurrency(tx: Tx, code: string) {
    if (!CCY.test(code) || !(await tx.currency.findUnique({ where: { code } }))) throw unprocessable(`${code} is not a known currency`, 'unknown_currency');
  }

  /** Eligible = not superseded, not dated after the day, and either covering the day or (DAILY) within the lookup window before it. */
  private eligible(r: RateRow, day: string): boolean {
    if (r.supersededById) return false;
    const from = isoDay(r.validFrom), to = isoDay(r.validTo);
    if (from > day) return false;
    if (to >= day) return true;                       // covers the day
    return r.kind === 'DAILY' && from >= addDays(day, -RATE_LOOKUP_WINDOW_DAYS);
  }

  async create(tx: Tx, a: { organisationId: string; companyId: string; actor: RateActor; fromCurrency: string; toCurrency?: string; kind: RateKind; validFrom: string; validTo?: string; rate: string; source: string }): Promise<RateView> {
    if (!(await a.actor.can('fx:rate-manage', a.companyId))) throw forbidden('Requires permission fx:rate-manage', 'permission_denied');
    const to = a.toCurrency ?? (await this.functional(tx, a.companyId));
    await this.assertCurrency(tx, a.fromCurrency); await this.assertCurrency(tx, to);
    const row = await this.insert(tx, { organisationId: a.organisationId, userId: a.actor.userId, from: a.fromCurrency, to, kind: a.kind, validFrom: a.validFrom, validTo: a.kind === 'DAILY' ? a.validFrom : a.validTo!, rate: a.rate, sourceKind: 'MANUAL', publisher: MANUAL_PUBLISHER, series: null, sourceRef: a.source.trim() });
    await this.audit(tx, { action: 'fx.rate_created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'exchange_rate', entityId: row.id,
      after: { from: row.fromCurrency, to: row.toCurrency, kind: row.kind, validFrom: isoDay(row.validFrom), validTo: isoDay(row.validTo), rate: row.rate.toFixed(8), source: row.sourceRef }, reason: a.source.trim() });
    return rateView(row);
  }

  private async insert(tx: Tx, a: { organisationId: string; userId: string; from: string; to: string; kind: string; validFrom: string; validTo: string; rate: string; sourceKind: 'MANUAL' | 'IMPORT'; publisher: string; series: string | null;
    sourceUrl?: string | null; sourceRef?: string | null; retrievedAt?: Date | null; importBatchId?: string | null; id?: string }): Promise<RateRow> {
    try {
      return await tx.exchangeRate.create({ data: { id: a.id, organisationId: a.organisationId, fromCurrency: a.from, toCurrency: a.to, kind: a.kind, validFrom: toDate(a.validFrom), validTo: toDate(a.validTo), rate: money(a.rate),
        sourceKind: a.sourceKind, publisher: a.publisher, series: a.series, sourceUrl: a.sourceUrl ?? null, sourceRef: a.sourceRef ?? null, retrievedAt: a.retrievedAt ?? null, enteredByUserId: a.userId, importBatchId: a.importBatchId ?? null } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('A current rate already exists for this currency pair, series and dates; supersede it with a reason instead', 'exchange_rate_exists');
      throw e;
    }
  }

  /** A correction never edits a rate: the old row is marked superseded and a new one carries the new number. Journals keep pointing at the rate they used. */
  async supersede(tx: Tx, a: { organisationId: string; companyId: string; actor: RateActor; id: string; rate: string; source: string; reason: string }): Promise<RateView> {
    if (!(await a.actor.can('fx:rate-manage', a.companyId))) throw forbidden('Requires permission fx:rate-manage', 'permission_denied');
    const old = await tx.exchangeRate.findFirst({ where: { id: a.id } });
    if (!old) throw notFound('Exchange rate not found');
    if (old.supersededById) throw conflict('This rate was already superseded', 'exchange_rate_superseded');
    const newId = uuidv7();
    await tx.exchangeRate.update({ where: { id: old.id }, data: { supersededById: newId } });            // reference checked at commit (deferred)
    const row = await this.insert(tx, { id: newId, organisationId: a.organisationId, userId: a.actor.userId, from: old.fromCurrency, to: old.toCurrency, kind: old.kind, validFrom: isoDay(old.validFrom), validTo: isoDay(old.validTo),
      rate: a.rate, sourceKind: 'MANUAL', publisher: old.publisher, series: old.series, sourceUrl: old.sourceUrl, sourceRef: a.source.trim() });
    await this.audit(tx, { action: 'fx.rate_superseded', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'exchange_rate', entityId: old.id,
      before: { rate: old.rate.toFixed(8), verification: old.verificationStatus }, after: { supersededBy: newId, rate: row.rate.toFixed(8) }, reason: a.reason, metadata: { source: a.source.trim() } });
    return rateView(row);
  }

  /** Second pair of eyes: the person who verifies a rate against its publisher is not the person who entered it. */
  async verify(tx: Tx, a: { organisationId: string; companyId: string; actor: RateActor; id: string; note?: string }): Promise<RateView> {
    if (!(await a.actor.can('fx:rate-manage', a.companyId))) throw forbidden('Requires permission fx:rate-manage', 'permission_denied');
    const r = await tx.exchangeRate.findFirst({ where: { id: a.id } });
    if (!r) throw notFound('Exchange rate not found');
    if (r.supersededById) throw conflict('A superseded rate cannot be verified', 'exchange_rate_superseded');
    if (r.verificationStatus === 'VERIFIED') throw conflict('This rate is already verified', 'already_verified');
    if (r.enteredByUserId === a.actor.userId) throw forbidden('A rate must be verified by someone other than the person who entered it', 'self_verification_not_allowed');
    const row = await tx.exchangeRate.update({ where: { id: r.id }, data: { verificationStatus: 'VERIFIED', verifiedByUserId: a.actor.userId, verifiedAt: new Date() } });
    await this.audit(tx, { action: 'fx.rate_verified', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'exchange_rate', entityId: r.id,
      before: { verification: 'UNVERIFIED' }, after: { verification: 'VERIFIED' }, reason: a.note ?? null });
    return rateView(row);
  }

  async list(tx: Tx, a: { limit: number; cursor?: string; from?: string; asOf?: string; includeSuperseded: boolean }) {
    const rows = await tx.exchangeRate.findMany({ where: { ...(a.from ? { fromCurrency: a.from } : {}), ...(a.includeSuperseded ? {} : { supersededById: null }), ...(a.cursor ? { id: { lt: a.cursor } } : {}),
      ...(a.asOf ? { validFrom: { lte: toDate(a.asOf) }, validTo: { gte: toDate(a.asOf) } } : {}) }, orderBy: { id: 'desc' }, take: a.limit + 1 });
    const page = rows.slice(0, a.limit);
    return { items: page.map(rateView), nextCursor: rows.length > a.limit ? page[page.length - 1]!.id : null };
  }

  async get(tx: Tx, id: string): Promise<RateView> {
    const r = await tx.exchangeRate.findFirst({ where: { id } });
    if (!r) throw notFound('Exchange rate not found');
    return rateView(r);
  }

  /** The company's chosen series for a currency, if it has one (`MANUAL` means manual rates only). */
  private async defaultSeries(tx: Tx, companyId: string, currency: string): Promise<{ publisher: string; series: string | null } | null> {
    const s = await tx.companyFxSetting.findFirst({ where: { companyId }, select: { defaultSeries: true } });
    const v = (s?.defaultSeries as Record<string, { publisher: string; series: string | null }> | undefined)?.[currency];
    return v ?? null;
  }
  private async blocksUnverified(tx: Tx, companyId: string) { return (await tx.ledgerPolicy.findFirst({ where: { companyId }, select: { fxBlockUnverifiedRates: true } }))?.fxBlockUnverifiedRates ?? false; }

  /** DEC-016 lookup: the rate for the day, else the latest earlier DAILY rate within 7 days, else refuse. Never a later rate. */
  async lookup(tx: Tx, a: { companyId: string; from: string; to: string; date: string }): Promise<ResolvedRate> {
    const rows = (await tx.exchangeRate.findMany({ where: { fromCurrency: a.from, toCurrency: a.to, supersededById: null, validFrom: { lte: toDate(a.date) } }, orderBy: { validFrom: 'desc' }, take: 200 })).filter((r) => this.eligible(r, a.date));
    if (rows.length === 0) throw unprocessable(`No ${a.from} to ${a.to} exchange rate for ${a.date} (or the ${RATE_LOOKUP_WINDOW_DAYS} days before). Enter a rate manually or import a series.`, 'exchange_rate_not_found', { from: a.from, to: a.to, date: a.date });
    const preferred = await this.defaultSeries(tx, a.companyId, a.from);
    const seriesKey = (r: RateRow) => `${r.publisher}|${r.series ?? ''}`;
    let pool = rows;
    if (preferred) {
      pool = rows.filter((r) => r.publisher === preferred.publisher && (r.series ?? null) === (preferred.series ?? null));
      if (pool.length === 0) throw unprocessable(`No rate from the company's chosen series (${preferred.publisher}${preferred.series ? ` / ${preferred.series}` : ''}) for ${a.from} on ${a.date}`, 'exchange_rate_not_found', { from: a.from, date: a.date });
    } else {
      const kinds = [...new Set(rows.map(seriesKey))];
      if (kinds.length > 1) throw unprocessable(`More than one rate series covers ${a.from} on ${a.date}; choose the company's default series or pass a rate id`, 'exchange_rate_ambiguous', { series: kinds.sort() });
    }
    // covering the day beats an earlier daily rate; among earlier ones the latest wins (rows are ordered by validFrom desc)
    const best = pool.find((r) => isoDay(r.validTo) >= a.date) ?? pool[0]!;
    if (best.verificationStatus !== 'VERIFIED' && (await this.blocksUnverified(tx, a.companyId))) {
      throw unprocessable('The company policy blocks postings that use an unverified exchange rate; verify the rate first', 'exchange_rate_unverified', { rateId: best.id });
    }
    return toResolved(best);
  }

  /** Posting path: an explicit rate id, a manual rate (stored and audited), or the lookup. */
  async resolveForPosting(tx: Tx, a: { organisationId: string; companyId: string; actor: RateActor; from: string; to: string; date: string; rateId?: string; manualRate?: { rate: string; source: string } }): Promise<ResolvedRate> {
    if (a.rateId) {
      const r = await tx.exchangeRate.findFirst({ where: { id: a.rateId } });
      if (!r || r.supersededById || r.fromCurrency !== a.from || r.toCurrency !== a.to || !this.eligible(r, a.date)) {
        throw unprocessable('The rate does not apply: it must be a current rate for this currency pair that covers the date (or is the latest daily rate within 7 days before it)', 'exchange_rate_not_applicable');
      }
      if (r.verificationStatus !== 'VERIFIED' && (await this.blocksUnverified(tx, a.companyId))) throw unprocessable('The company policy blocks postings that use an unverified exchange rate; verify the rate first', 'exchange_rate_unverified', { rateId: r.id });
      return toResolved(r);
    }
    if (a.manualRate) {
      if (!(await a.actor.can('fx:rate-manage', a.companyId))) throw forbidden('Entering a manual rate requires permission fx:rate-manage', 'permission_denied');
      const existing = await tx.exchangeRate.findFirst({ where: { fromCurrency: a.from, toCurrency: a.to, kind: 'DAILY', publisher: MANUAL_PUBLISHER, series: null, validFrom: toDate(a.date), supersededById: null } });
      if (existing) {
        if (!existing.rate.equals(money(a.manualRate.rate))) throw conflict(`A manual ${a.from} rate for ${a.date} already exists with a different value; supersede it explicitly`, 'exchange_rate_exists');
        return toResolved(existing);
      }
      const row = await this.insert(tx, { organisationId: a.organisationId, userId: a.actor.userId, from: a.from, to: a.to, kind: 'DAILY', validFrom: a.date, validTo: a.date, rate: a.manualRate.rate, sourceKind: 'MANUAL', publisher: MANUAL_PUBLISHER, series: null, sourceRef: a.manualRate.source.trim() });
      await this.audit(tx, { action: 'fx.rate_created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'exchange_rate', entityId: row.id,
        after: { from: a.from, to: a.to, kind: 'DAILY', validFrom: a.date, rate: row.rate.toFixed(8), source: row.sourceRef }, reason: a.manualRate.source.trim(), metadata: { via: 'journal posting' } });
      if (await this.blocksUnverified(tx, a.companyId)) throw unprocessable('The company policy blocks postings that use an unverified exchange rate; a new manual rate must be verified by a second person first', 'exchange_rate_unverified', { rateId: row.id });
      return toResolved(row);
    }
    return this.lookup(tx, { companyId: a.companyId, from: a.from, to: a.to, date: a.date });
  }

  // ───────────── Import (DEC-016): a file in, never a live fetch ─────────────
  async importCsv(tx: Tx, a: { organisationId: string; companyId: string; actor: RateActor; publisher: string; series?: string; sourceUrl?: string; retrievedAt: Date; toCurrency?: string; kind: RateKind; csv: string }) {
    if (!(await a.actor.can('fx:rate-manage', a.companyId))) throw forbidden('Requires permission fx:rate-manage', 'permission_denied');
    if (a.publisher.trim().toUpperCase() === MANUAL_PUBLISHER) throw unprocessable('MANUAL is reserved for manually entered rates', 'invalid_publisher');
    const defaultTo = a.toCurrency ?? (await this.functional(tx, a.companyId));
    const parsed = parseRateCsv(a.csv, { defaultTo, kind: a.kind });
    const known = new Set((await tx.currency.findMany({ select: { code: true } })).map((c) => c.code));
    const errors = [...parsed.errors];
    for (const r of parsed.rows) for (const c of [r.from, r.to]) if (!known.has(c)) errors.push({ line: r.line, message: `${c} is not a known currency` });
    const keyOf = (r: { from: string; to: string; kind: string; validFrom: string; validTo: string }) => `${r.from}|${r.to}|${r.kind}|${r.validFrom}|${r.validTo}`;
    const seen = new Set<string>();
    for (const r of parsed.rows) { const k = keyOf(r); if (seen.has(k)) errors.push({ line: r.line, message: 'Duplicate row in the file' }); seen.add(k); }
    const toInsert: typeof parsed.rows = []; let skipped = 0;
    if (errors.length === 0) {
      for (const r of parsed.rows) {
        const cur = await tx.exchangeRate.findFirst({ where: { fromCurrency: r.from, toCurrency: r.to, kind: r.kind, publisher: a.publisher, series: a.series ?? null, validFrom: toDate(r.validFrom), validTo: toDate(r.validTo), supersededById: null } });
        if (!cur) toInsert.push(r);
        else if (cur.rate.equals(money(r.rate))) skipped++;
        else errors.push({ line: r.line, message: `A different current rate exists (${cur.rate.toFixed(8)}); supersede it explicitly instead of importing over it` });
      }
    }
    if (errors.length > 0) throw unprocessable(`The rate file was rejected (${errors.length} problem${errors.length === 1 ? '' : 's'}); nothing was stored`, 'rate_import_invalid', { errors: errors.slice(0, 50), total: errors.length });
    const batch = uuidv7();
    for (const r of toInsert) {
      await this.insert(tx, { organisationId: a.organisationId, userId: a.actor.userId, from: r.from, to: r.to, kind: r.kind, validFrom: r.validFrom, validTo: r.validTo, rate: r.rate, sourceKind: 'IMPORT', publisher: a.publisher.trim(), series: a.series?.trim() ?? null,
        sourceUrl: a.sourceUrl ?? null, sourceRef: `import batch ${batch}`, retrievedAt: a.retrievedAt, importBatchId: batch });
    }
    const hash = createHash('sha256').update(a.csv).digest('hex');
    await this.audit(tx, { action: 'fx.rates_imported', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'exchange_rate_import', entityId: batch,
      after: { publisher: a.publisher, series: a.series ?? null, rows: toInsert.length, skippedIdentical: skipped, fileSha256: hash }, metadata: { sourceUrl: a.sourceUrl ?? null, retrievedAt: a.retrievedAt.toISOString() } });
    return { batchId: batch, imported: toInsert.length, skippedIdentical: skipped, status: 'UNVERIFIED' as const };
  }
}

// ───────────── CSV rate file (documented layout) ─────────────
export interface ParsedRateRow { line: number; from: string; to: string; kind: RateKind; validFrom: string; validTo: string; rate: string }
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RATE = /^(?!0+(\.0+)?$)\d{1,11}(\.\d{1,8})?$/;
const validDay = (s: string) => DATE.test(s) && isoDay(toDate(s)) === s;

/** Minimal RFC-4180 style splitter (quotes, doubled quotes, CRLF). */
export function splitCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((c) => c.trim() !== '')) rows.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/** Header `from,to,valid_from,valid_to,rate` (any order). `to` blank = the company's currency; `valid_to` blank = the same day (DAILY). Every problem is reported with its line. */
export function parseRateCsv(csv: string, o: { defaultTo: string; kind: RateKind }): { rows: ParsedRateRow[]; errors: { line: number; message: string }[] } {
  const errors: { line: number; message: string }[] = []; const out: ParsedRateRow[] = [];
  const table = splitCsv(csv.replace(/^\uFEFF/, ''));
  if (table.length === 0) return { rows: [], errors: [{ line: 1, message: 'The file is empty' }] };
  const header = table[0]!.map((h) => h.trim().toLowerCase());
  const col = (n: string) => header.indexOf(n);
  for (const need of ['from', 'valid_from', 'rate']) if (col(need) < 0) errors.push({ line: 1, message: `Missing column ${need}` });
  if (errors.length) return { rows: [], errors };
  if (table.length - 1 > MAX_RATE_IMPORT_ROWS) return { rows: [], errors: [{ line: 1, message: `At most ${MAX_RATE_IMPORT_ROWS} rows per file` }] };
  table.slice(1).forEach((cells, idx) => {
    const line = idx + 2; const get = (n: string) => (col(n) >= 0 ? (cells[col(n)] ?? '').trim() : '');
    const from = get('from').toUpperCase(), to = (get('to') || o.defaultTo).toUpperCase(), validFrom = get('valid_from'), rate = get('rate');
    let validTo = get('valid_to');
    if (!CCY.test(from)) errors.push({ line, message: 'from must be an ISO 4217 code' });
    if (!CCY.test(to)) errors.push({ line, message: 'to must be an ISO 4217 code' });
    if (CCY.test(from) && from === to) errors.push({ line, message: 'from and to must differ' });
    if (!validDay(validFrom)) errors.push({ line, message: 'valid_from must be a real date YYYY-MM-DD' });
    if (o.kind === 'DAILY') { if (validTo === '') validTo = validFrom; else if (validTo !== validFrom) errors.push({ line, message: 'a DAILY rate applies on one date; valid_to must be blank or equal valid_from' }); }
    else if (!validDay(validTo) || validTo < validFrom) errors.push({ line, message: 'a PERIOD rate needs valid_to on or after valid_from' });
    if (!RATE.test(rate)) errors.push({ line, message: 'rate must be a positive decimal with at most 8 decimal places' });
    out.push({ line, from, to, kind: o.kind, validFrom, validTo, rate });
  });
  return { rows: out, errors };
}

// ───────────── Company FX settings: designated accounts and default series ─────────────
export interface FxSettingsView { companyId: string; roundingAccountId: string | null; realisedAccountId: string | null; unrealisedAccountId: string | null; defaultSeries: Record<string, { publisher: string; series: string | null }>; isDefault: boolean; updatedAt: Date | null; updatedByUserId: string | null }

export class FxSettingsService {
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}

  async get(tx: Tx, companyId: string): Promise<FxSettingsView> {
    const s = await tx.companyFxSetting.findFirst({ where: { companyId } });
    if (!s) return { companyId, roundingAccountId: null, realisedAccountId: null, unrealisedAccountId: null, defaultSeries: {}, isDefault: true, updatedAt: null, updatedByUserId: null };
    return { companyId, roundingAccountId: s.roundingAccountId, realisedAccountId: s.realisedAccountId, unrealisedAccountId: s.unrealisedAccountId, defaultSeries: s.defaultSeries as FxSettingsView['defaultSeries'], isDefault: false, updatedAt: s.updatedAt, updatedByUserId: s.updatedByUserId };
  }

  /**
   * The three FX accounts must be profit-and-loss accounts of this company, not control accounts, active and distinct; the default series name a currency
   * and a publisher. Changing them needs `ledger:policy` and a reason and is audited before/after.
   */
  async set(tx: Tx, a: { organisationId: string; companyId: string; actor: RateActor & { kind: string }; roundingAccountId: string | null; realisedAccountId: string | null; unrealisedAccountId: string | null; defaultSeries: FxSettingsView['defaultSeries']; reason: string }): Promise<FxSettingsView> {
    if (a.actor.kind !== 'USER') throw forbidden('Only a person can change the FX settings', 'ai_cannot_post');
    if (!(await a.actor.can('ledger:policy', a.companyId))) throw forbidden('Requires permission ledger:policy', 'permission_denied');
    if (!(await tx.company.findUnique({ where: { id: a.companyId }, select: { id: true } }))) throw notFound('Company not found');
    const ids = [a.roundingAccountId, a.realisedAccountId, a.unrealisedAccountId].filter((x): x is string => !!x);
    if (new Set(ids).size !== ids.length) throw unprocessable('The rounding, realised and unrealised FX accounts must be three different accounts', 'invalid_fx_accounts');
    const accounts = await tx.account.findMany({ where: { companyId: a.companyId, id: { in: ids } } });
    if (accounts.length !== ids.length) throw unprocessable('An FX account does not exist in this company', 'unknown_account');
    for (const acc of accounts) {
      if (!['INCOME', 'EXPENSE'].includes(acc.type) || acc.isControl || acc.activeTo) throw unprocessable(`Account ${acc.code} cannot be an FX account: it must be an active income or expense account that is not a control account`, 'invalid_fx_accounts');
    }
    const known = new Set((await tx.currency.findMany({ select: { code: true } })).map((c) => c.code));
    const functional = (await tx.company.findUniqueOrThrow({ where: { id: a.companyId }, select: { baseCurrency: true } })).baseCurrency;
    for (const c of Object.keys(a.defaultSeries)) if (!known.has(c) || c === functional) throw unprocessable(`${c} cannot have a default rate series (it must be a known currency other than ${functional})`, 'unknown_currency');
    const before = await this.get(tx, a.companyId);
    const data = { roundingAccountId: a.roundingAccountId, realisedAccountId: a.realisedAccountId, unrealisedAccountId: a.unrealisedAccountId, defaultSeries: a.defaultSeries as Prisma.InputJsonValue, updatedByUserId: a.actor.userId };
    await tx.companyFxSetting.upsert({ where: { organisationId_companyId: { organisationId: a.organisationId, companyId: a.companyId } }, create: { organisationId: a.organisationId, companyId: a.companyId, ...data }, update: data });
    const after = await this.get(tx, a.companyId);
    const v = (x: FxSettingsView) => ({ roundingAccountId: x.roundingAccountId, realisedAccountId: x.realisedAccountId, unrealisedAccountId: x.unrealisedAccountId, defaultSeries: x.defaultSeries });
    await tx.auditEvent.createMany({ data: [auditRow({ action: 'fx.settings_changed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'company_fx_setting', entityId: a.companyId,
      before: v(before), after: v(after), reason: a.reason.trim() }, this.opts.captureDeviceMetadata)] });
    return after;
  }
}
