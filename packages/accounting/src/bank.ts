import { randomUUID } from 'node:crypto';
import type { BankAccountDetails } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable, type FieldEncryption } from '@uk/core';
import type { Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import { fmt, money } from './money';
import { PostingService, type PostLineInput, type PostingActor } from './posting';

/**
 * Bank accounts and transfers (M7a; DEC-039, DEC-041). The ONLY writer of `bank_account` and `bank_transfer` (architecture-tested); the only code
 * that handles bank-account details in clear. Transfers post only through the PostingService (negative-cash rule included); the database proves
 * each transfer's journal and its mirror reversal. Statement imports and lines belong to the importer in the platform package (ADR-61).
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const MONEY_SUBTYPES = ['CURRENT_ASSET_BANK', 'CURRENT_ASSET_CASH'];

export interface BankActor extends PostingActor { userId: string }
type Row = Awaited<ReturnType<Tx['bankAccount']['findUniqueOrThrow']>>;
type TransferRow = Awaited<ReturnType<Tx['bankTransfer']['findUniqueOrThrow']>>;

/** Shown in lists: never more than the last digits. */
export function maskBankDetails(d: BankAccountDetails): string {
  const parts: string[] = [];
  if (d.sortCode && d.accountNumber) parts.push(`**-**-${d.sortCode.slice(4)} ****${d.accountNumber.slice(4)}`);
  if (d.iban) parts.push(`${d.iban.slice(0, 2)}** **** ${d.iban.slice(-4)}`);
  if (d.bic) parts.push(`BIC ${d.bic.slice(0, 4)}****`);
  return parts.join(' / ');
}

export class BankService {
  private readonly posting: PostingService;
  constructor(private readonly opts: { crypto?: FieldEncryption; captureDeviceMetadata?: boolean } = {}) {
    this.posting = new PostingService({ captureDeviceMetadata: opts.captureDeviceMetadata });
  }
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: BankActor, permission: string, companyId: string) {
    if (actor.kind !== 'USER' || !actor.userId) throw forbidden('Bank records are kept by people', 'ai_cannot_post');
    if (!(await actor.can(permission, companyId))) throw forbidden(`Requires permission ${permission}`, 'permission_denied');
  }
  private seal(id: string, d: BankAccountDetails) {
    if (!this.opts.crypto) throw unprocessable('Bank account details cannot be stored: no encryption key is configured', 'encryption_unavailable');
    return { accountDetailsEnc: this.opts.crypto.encrypt(JSON.stringify(d), `bank_account:${id}`), accountDetailsMasked: maskBankDetails(d) };
  }
  private async company(tx: Tx, companyId: string) {
    const c = await tx.company.findFirst({ where: { id: companyId }, select: { id: true, baseCurrency: true } });
    if (!c) throw notFound('Company not found');
    return c;
  }
  /** Charges and interest accounts (M7b posts to them): ordinary accounts of the company, not control accounts. */
  private async checkPostingAccounts(tx: Tx, companyId: string, ids: (string | null | undefined)[]) {
    for (const id of ids.filter((x): x is string => !!x)) {
      const a = await tx.account.findFirst({ where: { id, companyId } });
      if (!a) throw unprocessable('A charges or interest account does not exist in this company', 'unknown_account');
      if (a.isControl || MONEY_SUBTYPES.includes(a.subtype)) throw unprocessable(`Account ${a.code} cannot hold bank charges or interest (it is a control, bank or cash account)`, 'control_account_restricted');
    }
  }

  // ───── Bank accounts (DEC-039) ─────
  async create(tx: Tx, a: { organisationId: string; companyId: string; actor: BankActor; accountId: string; name: string; bankName?: string; currency?: string; details?: BankAccountDetails;
    statementOpeningDate: string; statementOpeningBalance: string; chargesAccountId?: string; interestReceivedAccountId?: string; interestPaidAccountId?: string }) {
    await this.need(a.actor, 'bank:manage', a.companyId);
    const company = await this.company(tx, a.companyId);
    const acc = await tx.account.findFirst({ where: { id: a.accountId, companyId: a.companyId } });
    if (!acc) throw unprocessable('The ledger account does not exist in this company', 'unknown_account');
    if (acc.subtype !== 'CURRENT_ASSET_BANK') throw unprocessable(`Account ${acc.code} is not a bank account (subtype CURRENT_ASSET_BANK); cash in hand has no statements`, 'not_a_bank_account');
    if (await tx.bankAccount.findFirst({ where: { accountId: acc.id } })) throw conflict(`Account ${acc.code} already has a bank account`, 'bank_account_exists');
    const currency = a.currency ?? company.baseCurrency;
    const cur = await tx.currency.findUnique({ where: { code: currency } });
    if (!cur) throw unprocessable(`${currency} is not a known currency`, 'unknown_currency');
    const opening = money(a.statementOpeningBalance);
    if (opening.decimalPlaces() > cur.minorUnits) throw unprocessable(`${currency} amounts have at most ${cur.minorUnits} decimal places`, 'invalid_amount');
    await this.checkPostingAccounts(tx, a.companyId, [a.chargesAccountId, a.interestReceivedAccountId, a.interestPaidAccountId]);
    const id = randomUUID();
    await tx.bankAccount.create({ data: {
      id, organisationId: a.organisationId, companyId: a.companyId, accountId: acc.id, name: a.name.trim(), bankName: a.bankName?.trim() ?? null, currency,
      ...(a.details ? this.seal(id, a.details) : {}), statementOpeningDate: toDate(a.statementOpeningDate), statementOpeningBalance: opening,
      chargesAccountId: a.chargesAccountId ?? null, interestReceivedAccountId: a.interestReceivedAccountId ?? null, interestPaidAccountId: a.interestPaidAccountId ?? null, createdByUserId: a.actor.userId,
    } });
    await this.audit(tx, { action: 'bank_account.created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'bank_account', entityId: id,
      after: { accountId: acc.id, name: a.name, currency, detailsMasked: a.details ? maskBankDetails(a.details) : null, statementOpeningDate: a.statementOpeningDate, statementOpeningBalance: fmt(opening, cur.minorUnits) } });
    return this.get(tx, a.companyId, id);
  }

  async update(tx: Tx, a: { organisationId: string; companyId: string; actor: BankActor; id: string; reason: string; name?: string; bankName?: string | null; details?: BankAccountDetails | null;
    statementOpeningDate?: string; statementOpeningBalance?: string; chargesAccountId?: string | null; interestReceivedAccountId?: string | null; interestPaidAccountId?: string | null }) {
    await this.need(a.actor, 'bank:manage', a.companyId);
    const b = await tx.bankAccount.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!b) throw notFound('Bank account not found');
    if (b.status !== 'ACTIVE') throw conflict('A closed bank account cannot change', 'bank_account_closed');
    if ((a.statementOpeningDate || a.statementOpeningBalance) && (await tx.bankStatementLine.count({ where: { bankAccountId: b.id, voided: false } })) > 0) {
      throw conflict('The statement opening point is fixed once statement lines exist (void the imports first)', 'bank_opening_fixed');
    }
    await this.checkPostingAccounts(tx, a.companyId, [a.chargesAccountId, a.interestReceivedAccountId, a.interestPaidAccountId]);
    const minor = (await tx.currency.findUnique({ where: { code: b.currency } }))?.minorUnits ?? 2;
    if (a.statementOpeningBalance && money(a.statementOpeningBalance).decimalPlaces() > minor) throw unprocessable(`${b.currency} amounts have at most ${minor} decimal places`, 'invalid_amount');
    const data = {
      ...(a.name !== undefined ? { name: a.name.trim() } : {}), ...(a.bankName !== undefined ? { bankName: a.bankName?.trim() ?? null } : {}),
      ...(a.details !== undefined ? (a.details ? this.seal(b.id, a.details) : { accountDetailsEnc: null, accountDetailsMasked: null }) : {}),
      ...(a.statementOpeningDate ? { statementOpeningDate: toDate(a.statementOpeningDate) } : {}), ...(a.statementOpeningBalance ? { statementOpeningBalance: money(a.statementOpeningBalance) } : {}),
      ...(a.chargesAccountId !== undefined ? { chargesAccountId: a.chargesAccountId } : {}), ...(a.interestReceivedAccountId !== undefined ? { interestReceivedAccountId: a.interestReceivedAccountId } : {}),
      ...(a.interestPaidAccountId !== undefined ? { interestPaidAccountId: a.interestPaidAccountId } : {}),
    };
    await tx.bankAccount.update({ where: { id: b.id }, data });
    const changed = Object.keys(data).map((k) => (k === 'accountDetailsEnc' ? 'details' : k)).filter((k) => k !== 'accountDetailsMasked');
    await this.audit(tx, { action: 'bank_account.updated', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'bank_account', entityId: b.id,
      after: { changed, ...(a.details !== undefined ? { detailsMasked: a.details ? maskBankDetails(a.details) : null } : {}) }, reason: a.reason });
    return this.get(tx, a.companyId, b.id);
  }

  async close(tx: Tx, a: { organisationId: string; companyId: string; actor: BankActor; id: string; reason: string }) {
    await this.need(a.actor, 'bank:manage', a.companyId);
    const b = await tx.bankAccount.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!b) throw notFound('Bank account not found');
    if (b.status === 'CLOSED') throw conflict('This bank account is already closed', 'bank_account_closed');
    if (await tx.bankStatementImport.findFirst({ where: { bankAccountId: b.id, status: 'QUEUED' } })) throw conflict('A statement import is still running for this account', 'bank_import_running');
    const [open] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM bank_statement_line WHERE bank_account_id = ${b.id}::uuid AND NOT voided AND matched_amount <> amount`;
    if ((open?.n ?? 0) > 0) throw conflict(`${open!.n} statement line(s) are not fully matched; reconcile them before closing the account`, 'bank_has_unmatched_lines', { lines: open!.n });
    await tx.bankAccount.update({ where: { id: b.id }, data: { status: 'CLOSED', closedAt: new Date(), closedByUserId: a.actor.userId, closedReason: a.reason.trim() } });
    await this.audit(tx, { action: 'bank_account.closed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'bank_account', entityId: b.id,
      before: { status: 'ACTIVE' }, after: { status: 'CLOSED' }, reason: a.reason });
    return this.get(tx, a.companyId, b.id);
  }

  /** The full details, for a holder of bank:manage; every read is audited. */
  async details(tx: Tx, a: { organisationId: string; companyId: string; actor: BankActor; id: string }) {
    await this.need(a.actor, 'bank:manage', a.companyId);
    const b = await tx.bankAccount.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!b) throw notFound('Bank account not found');
    if (!b.accountDetailsEnc) return { id: b.id, details: null };
    if (!this.opts.crypto) throw unprocessable('Bank account details cannot be read: no encryption key is configured', 'encryption_unavailable');
    const details = JSON.parse(this.opts.crypto.decrypt(b.accountDetailsEnc, `bank_account:${b.id}`)) as BankAccountDetails;
    await this.audit(tx, { action: 'bank_account.details_read', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'bank_account', entityId: b.id });
    return { id: b.id, details };
  }

  async get(tx: Tx, companyId: string, id: string) {
    const b = await tx.bankAccount.findFirst({ where: { id, companyId } });
    if (!b) throw notFound('Bank account not found');
    return this.view(tx, b);
  }
  async list(tx: Tx, companyId: string, q: { status?: string }) {
    const rows = await tx.bankAccount.findMany({ where: { companyId, ...(q.status ? { status: q.status } : {}) }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
    const items = [];
    for (const r of rows) items.push(await this.view(tx, r));
    return { items };
  }
  private async view(tx: Tx, b: Row) {
    const acc = await tx.account.findUniqueOrThrow({ where: { id: b.accountId }, select: { code: true, name: true } });
    const minor = (await tx.currency.findUnique({ where: { code: b.currency } }))?.minorUnits ?? 2;
    const company = await this.company(tx, b.companyId);
    const foreign = b.currency !== company.baseCurrency;
    // the ledger balance in the account's currency: original amounts of foreign lines, functional amounts otherwise
    const [led] = await tx.$queryRaw<{ bal: string | null }[]>`
      SELECT sum(CASE WHEN ${foreign} THEN coalesce(original_debit, 0) - coalesce(original_credit, 0) ELSE debit - credit END)::text AS bal
        FROM journal_line WHERE company_id = ${b.companyId}::uuid AND account_id = ${b.accountId}::uuid AND adjusts_currency IS NULL`;
    const [st] = await tx.$queryRaw<{ n: number; sum: string | null; last: Date | null; unmatched: number }[]>`
      SELECT count(*)::int AS n, sum(amount)::text AS sum, max(transaction_date) AS last, count(*) FILTER (WHERE matched_amount <> amount)::int AS unmatched
        FROM bank_statement_line WHERE bank_account_id = ${b.id}::uuid AND NOT voided`;
    return { id: b.id, companyId: b.companyId, accountId: b.accountId, accountCode: acc.code, accountName: acc.name, name: b.name, bankName: b.bankName, currency: b.currency,
      detailsMasked: b.accountDetailsMasked, statementOpeningDate: isoDay(b.statementOpeningDate), statementOpeningBalance: fmt(b.statementOpeningBalance, minor),
      chargesAccountId: b.chargesAccountId, interestReceivedAccountId: b.interestReceivedAccountId, interestPaidAccountId: b.interestPaidAccountId,
      ledgerBalance: fmt(money(led?.bal ?? '0'), minor),
      statement: { lines: st?.n ?? 0, balance: fmt(b.statementOpeningBalance.plus(money(st?.sum ?? '0')), minor), lastDate: st?.last ? isoDay(st.last) : null, unmatchedLines: st?.unmatched ?? 0 },
      status: b.status, closedAt: b.closedAt, closedReason: b.closedReason, createdByUserId: b.createdByUserId, createdAt: b.createdAt };
  }

  // ───── Transfers (DEC-041) ─────
  /** The currency an account holds: its bank account's currency, or the company's for cash in hand and unlinked bank accounts. */
  private async accountCurrency(tx: Tx, accountId: string, base: string) {
    return (await tx.bankAccount.findFirst({ where: { accountId }, select: { currency: true, status: true } })) ?? { currency: base, status: 'ACTIVE' };
  }
  async transfer(tx: Tx, a: { organisationId: string; companyId: string; actor: BankActor; fromAccountId: string; toAccountId: string; transferDate: string; amount: string; currency?: string; rateId?: string;
    reference?: string; description: string; duplicateOverrideReason?: string; negativeCashReason?: string }) {
    await this.need(a.actor, 'bank:transfer', a.companyId);
    const company = await this.company(tx, a.companyId);
    if (a.fromAccountId === a.toAccountId) throw unprocessable('Choose two different accounts', 'invalid_transfer');
    const accounts = await tx.account.findMany({ where: { companyId: a.companyId, id: { in: [a.fromAccountId, a.toAccountId] } } });
    const from = accounts.find((x) => x.id === a.fromAccountId), to = accounts.find((x) => x.id === a.toAccountId);
    if (!from || !to) throw unprocessable('Both accounts must exist in this company', 'unknown_account');
    for (const x of [from, to]) if (!MONEY_SUBTYPES.includes(x.subtype)) throw unprocessable(`Account ${x.code} is not a bank or cash account`, 'not_a_bank_account');
    const [fc, tc] = [await this.accountCurrency(tx, from.id, company.baseCurrency), await this.accountCurrency(tx, to.id, company.baseCurrency)];
    if (fc.status !== 'ACTIVE' || tc.status !== 'ACTIVE') throw conflict('A closed bank account cannot take part in a transfer', 'bank_account_closed');
    if (fc.currency !== tc.currency) throw unprocessable(`The accounts hold different currencies (${fc.currency} and ${tc.currency}); cross-currency transfers are not supported yet (DEC-041)`, 'cross_currency_transfer_not_supported');
    const currency = a.currency ?? fc.currency;
    if (currency !== fc.currency) throw unprocessable(`Both accounts hold ${fc.currency}`, 'currency_mismatch');
    if (a.rateId && currency === company.baseCurrency) throw unprocessable('A rate applies only to foreign-currency transfers', 'rate_not_applicable');
    const cur = await tx.currency.findUniqueOrThrow({ where: { code: currency } });
    const amount = money(a.amount);
    if (!amount.greaterThan(0) || amount.decimalPlaces() > cur.minorUnits) throw unprocessable(`The amount must be greater than zero with at most ${cur.minorUnits} decimal places`, 'invalid_amount');
    const dups = await tx.bankTransfer.findMany({ where: { companyId: a.companyId, status: 'POSTED', OR: [{ fromAccountId: from.id, toAccountId: to.id, transferDate: toDate(a.transferDate), amount }, ...(a.reference ? [{ reference: a.reference }] : [])] }, select: { id: true }, take: 5 });
    if (dups.length > 0 && !a.duplicateOverrideReason) throw conflict('Possible duplicate of a transfer already recorded (same accounts, date and amount, or the same reference); record it with a duplicateOverrideReason if it is genuine', 'possible_duplicate', { transfers: dups.map((d) => d.id) });
    const id = randomUUID();
    const amt = fmt(amount, cur.minorUnits);
    const j = await this.posting.post(tx, {
      organisationId: a.organisationId, companyId: a.companyId, journalDate: a.transferDate, sourceType: 'BANK_TRANSFER', sourceId: id, sourceReference: a.reference ?? null,
      description: `Transfer ${from.code} to ${to.code}: ${a.description}`.slice(0, 500),
      ...(currency !== company.baseCurrency ? { currency, ...(a.rateId ? { rateId: a.rateId } : {}) } : {}),
      lines: [
        { accountId: to.id, debit: amt, credit: '0', description: `Transfer from ${from.code}`.slice(0, 300) },
        { accountId: from.id, debit: '0', credit: amt, description: `Transfer to ${to.code}`.slice(0, 300) },
      ],
      idempotencyKey: `bank-transfer:${id}`, actor: a.actor, negativeCashReason: a.negativeCashReason,
    });
    await tx.bankTransfer.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, fromAccountId: from.id, toAccountId: to.id, transferDate: toDate(a.transferDate), currency, amount,
      reference: a.reference ?? null, description: a.description.trim(), journalId: j.id, duplicateOverrideReason: dups.length > 0 ? a.duplicateOverrideReason!.trim() : null, createdByUserId: a.actor.userId } });
    await this.audit(tx, { action: 'bank_transfer.recorded', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'bank_transfer', entityId: id,
      after: { from: from.code, to: to.code, transferDate: a.transferDate, currency, amount: amt, journalId: j.id }, reason: a.duplicateOverrideReason ?? null,
      metadata: { duplicateOverride: dups.length > 0, balanceWarnings: j.balanceWarnings ?? [] } });
    return { ...(await this.getTransfer(tx, a.companyId, id)), balanceWarnings: j.balanceWarnings ?? [] };
  }

  async reverseTransfer(tx: Tx, a: { organisationId: string; companyId: string; actor: BankActor; id: string; reason: string; date?: string; negativeCashReason?: string }) {
    await this.need(a.actor, 'bank:transfer', a.companyId);
    await tx.$queryRaw`SELECT id FROM bank_transfer WHERE id = ${a.id}::uuid FOR UPDATE`;
    const t = await tx.bankTransfer.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!t) throw notFound('Transfer not found');
    if (t.status !== 'POSTED') throw conflict('This transfer is already reversed', 'transfer_reversed');
    const date = a.date ?? isoDay(t.transferDate);
    if (date < isoDay(t.transferDate)) throw unprocessable('A reversal cannot precede the transfer', 'invalid_date');
    const posted = await tx.journalLine.findMany({ where: { journalId: t.journalId }, orderBy: { lineNo: 'asc' } });
    const j = await this.posting.post(tx, {
      organisationId: a.organisationId, companyId: a.companyId, journalDate: date, sourceType: 'BANK_TRANSFER_REVERSAL', sourceId: t.id, sourceReference: t.reference,
      description: `Reversal of transfer ${t.reference ?? t.id.slice(0, 8)}: ${a.reason.trim()}`.slice(0, 500),
      lines: posted.map((l): PostLineInput => ({ accountId: l.accountId, debit: l.credit.toFixed(4), credit: l.debit.toFixed(4), description: 'Transfer reversed',
        ...(l.originalCurrency ? { original: { currency: l.originalCurrency, debit: l.originalCredit!.toFixed(4), credit: l.originalDebit!.toFixed(4), rate: l.rate!.toFixed(8), rateId: l.exchangeRateId! } } : {}) })),
      idempotencyKey: `bank-transfer-reversal:${t.id}`, actor: a.actor, reason: a.reason, negativeCashReason: a.negativeCashReason,
    });
    await tx.bankTransfer.update({ where: { id: t.id }, data: { status: 'REVERSED', reversalJournalId: j.id, reversedByUserId: a.actor.userId, reversedAt: new Date(), reversedReason: a.reason.trim() } });
    await this.audit(tx, { action: 'bank_transfer.reversed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'bank_transfer', entityId: t.id,
      before: { status: 'POSTED' }, after: { status: 'REVERSED', journalId: j.id, date }, reason: a.reason, metadata: { balanceWarnings: j.balanceWarnings ?? [] } });
    return { ...(await this.getTransfer(tx, a.companyId, t.id)), balanceWarnings: j.balanceWarnings ?? [] };
  }

  async getTransfer(tx: Tx, companyId: string, id: string) {
    const t = await tx.bankTransfer.findFirst({ where: { id, companyId } });
    if (!t) throw notFound('Transfer not found');
    return this.transferView(t, (await tx.currency.findUnique({ where: { code: t.currency } }))?.minorUnits ?? 2);
  }
  private transferView(t: TransferRow, minor: number) {
    return { id: t.id, companyId: t.companyId, fromAccountId: t.fromAccountId, toAccountId: t.toAccountId, transferDate: isoDay(t.transferDate), currency: t.currency, amount: fmt(t.amount, minor),
      reference: t.reference, description: t.description, journalId: t.journalId, duplicateOverrideReason: t.duplicateOverrideReason, status: t.status,
      reversalJournalId: t.reversalJournalId, reversedByUserId: t.reversedByUserId, reversedAt: t.reversedAt, reversedReason: t.reversedReason, createdByUserId: t.createdByUserId, createdAt: t.createdAt };
  }
  async listTransfers(tx: Tx, companyId: string, q: { accountId?: string; status?: string; from?: string; to?: string; limit: number; cursor?: string }) {
    const rows = await tx.bankTransfer.findMany({
      where: { companyId, ...(q.accountId ? { OR: [{ fromAccountId: q.accountId }, { toAccountId: q.accountId }] } : {}), ...(q.status ? { status: q.status } : {}),
        ...(q.from || q.to ? { transferDate: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } } : {}) },
      orderBy: [{ transferDate: 'desc' }, { id: 'desc' }], take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = [];
    for (const r of rows.slice(0, q.limit)) items.push(this.transferView(r, (await tx.currency.findUnique({ where: { code: r.currency } }))?.minorUnits ?? 2));
    return { items, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }
}

