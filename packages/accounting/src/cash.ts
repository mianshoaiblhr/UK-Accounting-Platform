import { randomUUID } from 'node:crypto';
import { Events, type CashDirection } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable } from '@uk/core';
import type { Tx } from '@uk/db';
import { auditRow, publishEvent } from '@uk/platform';
import { ZERO, fmt, money, type Money } from './money';
import { PostingService, type BalanceWarning, type PostLineInput, type PostLineVat, type PostingActor } from './posting';
import { VatService, vatInGross, vatOnNet } from './vat';

/**
 * Cash transactions (M6c; DEC-036, DEC-037): money in or out of a bank or cash account without a source document, with VAT per line. The ONLY writer
 * of `cash_transaction` and `cash_transaction_line` (architecture-tested). It never writes the ledger: the PostingService posts the journal (and adds
 * the VAT lines), refuses cash in hand below zero without a reason, and the database re-proves the totals, the lifecycle and every reversal at commit.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const BANK_SUBTYPES = ['CURRENT_ASSET_BANK', 'CURRENT_ASSET_CASH'];

export interface CashActor extends PostingActor { userId: string }
export interface CashLineInput { description: string; accountId: string; amount: string; taxCodeId?: string }
type Row = Awaited<ReturnType<Tx['cashTransaction']['findUniqueOrThrow']>>;
type LineRow = Awaited<ReturnType<Tx['cashTransactionLine']['findUniqueOrThrow']>>;

export class CashService {
  private readonly posting: PostingService;
  private readonly vat: VatService;
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {
    this.posting = new PostingService({ captureDeviceMetadata: opts.captureDeviceMetadata });
    this.vat = new VatService({ captureDeviceMetadata: opts.captureDeviceMetadata });
  }
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: CashActor, permission: string, companyId: string) {
    if (actor.kind !== 'USER' || !actor.userId) throw forbidden('Cash transactions are recorded by people', 'ai_cannot_post');
    if (!(await actor.can(permission, companyId))) throw forbidden(`Requires permission ${permission}`, 'permission_denied');
  }
  private async company(tx: Tx, companyId: string) {
    const c = await tx.company.findFirst({ where: { id: companyId }, select: { id: true, baseCurrency: true } });
    if (!c) throw notFound('Company not found');
    return c;
  }

  private async bankAccount(tx: Tx, companyId: string, id: string, date: string) {
    const a = await tx.account.findFirst({ where: { id, companyId } });
    if (!a) throw unprocessable('The bank or cash account does not exist in this company', 'unknown_account');
    if (!BANK_SUBTYPES.includes(a.subtype)) throw unprocessable(`Account ${a.code} is not a bank or cash account`, 'not_a_bank_account');
    const d = toDate(date);
    if ((a.activeFrom && d < a.activeFrom) || (a.activeTo && d > a.activeTo)) throw unprocessable(`Account ${a.code} is not active on ${date}`, 'account_inactive');
    return a;
  }

  /** Each line goes to a non-control account that is not a bank or cash account (a transfer is M7) or a VAT/FX account; its VAT code fits the direction. */
  private async checkLines(tx: Tx, a: { companyId: string; date: string; direction: CashDirection; inclusive: boolean; lines: CashLineInput[] }) {
    const vat = await tx.companyVatSetting.findFirst({ where: { companyId: a.companyId } });
    const fx = await tx.companyFxSetting.findFirst({ where: { companyId: a.companyId } });
    const reserved = new Set([vat?.outputAccountId, vat?.inputAccountId, fx?.roundingAccountId, fx?.realisedAccountId, fx?.unrealisedAccountId].filter(Boolean) as string[]);
    const accounts = new Map((await tx.account.findMany({ where: { companyId: a.companyId, id: { in: [...new Set(a.lines.map((l) => l.accountId))] } } })).map((x) => [x.id, x]));
    const d = toDate(a.date);
    for (const [i, l] of a.lines.entries()) {
      const acc = accounts.get(l.accountId);
      if (!acc) throw unprocessable(`Line ${i + 1}: the account does not exist in this company`, 'unknown_account');
      if (BANK_SUBTYPES.includes(acc.subtype)) throw unprocessable(`Line ${i + 1}: ${acc.code} is a bank or cash account; transfers between them come with the bank module (M7)`, 'transfer_not_supported');
      if (acc.isControl) throw unprocessable(`Line ${i + 1}: ${acc.code} is a control account, maintained by its sub-ledger (record a customer receipt or a supplier payment instead)`, 'control_account_restricted');
      if (reserved.has(acc.id)) throw unprocessable(`Line ${i + 1}: ${acc.code} is reserved for VAT or foreign-exchange postings`, 'system_account_restricted');
      if ((acc.activeFrom && d < acc.activeFrom) || (acc.activeTo && d > acc.activeTo)) throw unprocessable(`Line ${i + 1}: account ${acc.code} is not active on ${a.date}`, 'account_inactive');
      if (l.taxCodeId) {
        const code = await tx.taxCode.findFirst({ where: { id: l.taxCodeId } });
        if (!code) throw unprocessable(`Line ${i + 1}: unknown VAT code`, 'unknown_tax_code');
        if (a.direction === 'PAYMENT' && code.direction === 'SALES') throw unprocessable(`Line ${i + 1}: ${code.code} is a sales VAT code; money out uses purchases codes`, 'tax_code_direction');
        if (a.direction === 'RECEIPT' && code.direction === 'PURCHASES') throw unprocessable(`Line ${i + 1}: ${code.code} is a purchases VAT code; money in uses sales codes`, 'tax_code_direction');
        if (code.reverseCharge && a.direction === 'RECEIPT') throw unprocessable(`Line ${i + 1}: reverse charge applies to purchases, not to money in`, 'tax_code_direction');
        if (code.reverseCharge && a.inclusive) throw unprocessable(`Line ${i + 1}: a reverse-charge line is entered net`, 'reverse_charge_inclusive_not_supported');
      }
    }
  }

  /** Per-line amounts, the PostingService's arithmetic (verified rates only). Reverse charge adds no VAT to what was paid; the pair is posted. */
  private async compute(tx: Tx, lines: CashLineInput[], inclusive: boolean, taxPoint: string, minor: number) {
    const out: { net: Money; vat: Money; entered: Money }[] = [];
    for (const [i, l] of lines.entries()) {
      const entered = money(l.amount);
      if (entered.decimalPlaces() > minor) throw unprocessable(`Line ${i + 1}: amounts have at most ${minor} decimal places`, 'invalid_amount');
      let vat = ZERO;
      if (l.taxCodeId) {
        const code = await tx.taxCode.findFirstOrThrow({ where: { id: l.taxCodeId } });
        const rate = (await this.vat.rateFor(tx, l.taxCodeId, taxPoint)).rate;
        if (!rate.isZero() && !code.reverseCharge) vat = inclusive ? vatInGross(entered, rate, minor) : vatOnNet(entered, rate, minor);
      }
      const net = inclusive ? entered.minus(vat) : entered;
      if (!net.greaterThan(0)) throw unprocessable(`Line ${i + 1}: the net amount must be greater than zero`, 'invalid_amount');
      out.push({ net, vat, entered });
    }
    const net = out.reduce((t, x) => t.plus(x.net), ZERO), vat = out.reduce((t, x) => t.plus(x.vat), ZERO);
    return { lines: out, net, vat, gross: net.plus(vat) };
  }

  async record(tx: Tx, a: { organisationId: string; companyId: string; actor: CashActor; direction: CashDirection; transactionDate: string; taxPoint?: string; bankAccountId: string; contactId?: string;
    counterparty?: string; reference?: string; description: string; currency?: string; amountsIncludeVat: boolean; lines: CashLineInput[]; duplicateOverrideReason?: string; negativeCashReason?: string }) {
    await this.need(a.actor, 'cash:record', a.companyId);
    const company = await this.company(tx, a.companyId);
    if (a.currency && a.currency !== company.baseCurrency) {
      throw unprocessable(`Cash transactions are recorded in the company's currency, ${company.baseCurrency}; foreign-currency bank accounts come with M7 and VAT on foreign currency with M5c`, 'foreign_currency_not_supported');
    }
    if (a.lines.length === 0) throw unprocessable('A cash transaction needs at least one line', 'too_few_lines');
    if (a.taxPoint && !a.lines.some((l) => l.taxCodeId)) throw unprocessable('A tax point applies only to lines with a VAT code', 'vat_not_applicable');
    const bank = await this.bankAccount(tx, a.companyId, a.bankAccountId, a.transactionDate);
    if (a.contactId) {
      const c = await tx.contact.findFirst({ where: { id: a.contactId, OR: [{ companyId: null }, { companyId: a.companyId }] }, select: { id: true } });
      if (!c) throw notFound('Contact not found');
    }
    await this.checkLines(tx, { companyId: a.companyId, date: a.transactionDate, direction: a.direction, inclusive: a.amountsIncludeVat, lines: a.lines });
    const minor = (await tx.currency.findUnique({ where: { code: company.baseCurrency } }))?.minorUnits ?? 2;
    const taxPoint = a.taxPoint ?? a.transactionDate;
    const amounts = await this.compute(tx, a.lines, a.amountsIncludeVat, taxPoint, minor);
    const dups = await tx.cashTransaction.findMany({ where: { companyId: a.companyId, bankAccountId: a.bankAccountId, direction: a.direction, status: 'POSTED',
      OR: [{ transactionDate: toDate(a.transactionDate), grossTotal: amounts.gross }, ...(a.reference ? [{ reference: a.reference }] : [])] }, select: { id: true }, take: 5 });
    if (dups.length > 0 && !a.duplicateOverrideReason) {
      throw conflict('Possible duplicate of a cash transaction already recorded (same account, direction, date and total, or the same reference); record it with a duplicateOverrideReason if it is genuine', 'possible_duplicate', { transactions: dups.map((d) => d.id) });
    }
    const id = randomUUID();
    const out = a.direction === 'PAYMENT';
    const side = (amt: string) => (out ? { debit: amt, credit: '0' } : { debit: '0', credit: amt });
    const g = fmt(amounts.gross, minor);
    const who = a.counterparty ?? (a.contactId ? (await tx.contact.findFirstOrThrow({ where: { id: a.contactId }, select: { name: true } })).name : null);
    const coded = a.lines.some((l) => l.taxCodeId);
    const j = await this.posting.post(tx, {
      organisationId: a.organisationId, companyId: a.companyId, journalDate: a.transactionDate, sourceType: out ? 'CASH_PAYMENT' : 'CASH_RECEIPT', sourceId: id, sourceReference: a.reference ?? null,
      description: `${out ? 'Money out' : 'Money in'}${who ? ` - ${who}` : ''}: ${a.description}`.slice(0, 500),
      ...(coded ? { amountsIncludeVat: a.amountsIncludeVat, taxPoint } : {}),
      lines: [
        { accountId: bank.id, debit: out ? '0' : g, credit: out ? g : '0', description: a.description.slice(0, 300) },
        ...a.lines.map((l, i): PostLineInput => ({ accountId: l.accountId, ...side(fmt(amounts.lines[i]!.entered, minor)), description: l.description.slice(0, 300), ...(l.taxCodeId ? { taxCodeId: l.taxCodeId } : {}) })),
      ],
      idempotencyKey: `cash:${id}`, actor: a.actor, negativeCashReason: a.negativeCashReason,
    });
    const negativeCashOverride = (j.balanceWarnings ?? []).some((w) => w.kind === 'CASH' && w.overridden);
    await tx.cashTransaction.create({ data: {
      id, organisationId: a.organisationId, companyId: a.companyId, direction: a.direction, transactionDate: toDate(a.transactionDate), taxPoint: a.taxPoint ? toDate(a.taxPoint) : null,
      bankAccountId: bank.id, contactId: a.contactId ?? null, counterparty: a.counterparty ?? null, reference: a.reference ?? null, description: a.description.trim(), currency: company.baseCurrency,
      amountsIncludeVat: a.amountsIncludeVat, netTotal: amounts.net, vatTotal: amounts.vat, grossTotal: amounts.gross, journalId: j.id,
      duplicateOverrideReason: dups.length > 0 ? a.duplicateOverrideReason!.trim() : null, createdByUserId: a.actor.userId,
    } });
    await tx.cashTransactionLine.createMany({ data: a.lines.map((l, i) => ({
      organisationId: a.organisationId, companyId: a.companyId, transactionId: id, lineNo: i + 1, description: l.description.trim(), accountId: l.accountId, taxCodeId: l.taxCodeId ?? null,
      amount: amounts.lines[i]!.entered, net: amounts.lines[i]!.net, vat: amounts.lines[i]!.vat,
    })) });
    await this.audit(tx, { action: 'cash_transaction.recorded', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'cash_transaction', entityId: id,
      after: { direction: a.direction, transactionDate: a.transactionDate, bankAccountId: bank.id, gross: g, vat: fmt(amounts.vat, minor), journalId: j.id },
      reason: a.duplicateOverrideReason ?? (negativeCashOverride ? a.negativeCashReason! : null),
      metadata: { duplicateOverride: dups.length > 0, negativeCashOverride, balanceWarnings: j.balanceWarnings ?? [] } });
    await publishEvent(tx, Events.cashTransactionRecorded, { aggregateId: id, organisationId: a.organisationId, actorUserId: a.actor.userId,
      payload: { transactionId: id, companyId: a.companyId, direction: a.direction, transactionDate: a.transactionDate, bankAccountId: bank.id, currency: company.baseCurrency, gross: g, vat: fmt(amounts.vat, minor), journalId: j.id, negativeCashOverride } });
    return { ...(await this.get(tx, a.companyId, id)), balanceWarnings: j.balanceWarnings ?? [] };
  }

  /**
   * The exact mirror of the posted journal, line by line and in the same order (VAT facts and rate versions included, so each VAT line still points at
   * its net line); the database proves the mirror. The tax point stays the original's, as for a ledger reversal (DEC-037; see the known limitations).
   */
  async reverse(tx: Tx, a: { organisationId: string; companyId: string; actor: CashActor; id: string; reason: string; date?: string; negativeCashReason?: string }) {
    await this.need(a.actor, 'cash:record', a.companyId);
    await tx.$queryRaw`SELECT id FROM cash_transaction WHERE id = ${a.id}::uuid FOR UPDATE`;
    const t = await tx.cashTransaction.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!t) throw notFound('Cash transaction not found');
    if (t.status !== 'POSTED') throw conflict('This cash transaction is already reversed', 'cash_transaction_reversed');
    const date = a.date ?? isoDay(t.transactionDate);
    if (date < isoDay(t.transactionDate)) throw unprocessable('A reversal cannot precede the transaction', 'invalid_date');
    const posted = await tx.journalLine.findMany({ where: { journalId: t.journalId }, orderBy: { lineNo: 'asc' } });
    const j = await this.posting.post(tx, {
      organisationId: a.organisationId, companyId: a.companyId, journalDate: date, sourceType: t.direction === 'PAYMENT' ? 'CASH_PAYMENT_REVERSAL' : 'CASH_RECEIPT_REVERSAL', sourceId: t.id, sourceReference: t.reference,
      description: `Reversal of ${t.direction === 'PAYMENT' ? 'money out' : 'money in'} ${t.reference ?? t.id.slice(0, 8)}: ${a.reason.trim()}`.slice(0, 500),
      lines: posted.map((l): PostLineInput => ({ accountId: l.accountId, debit: l.credit.toFixed(4), credit: l.debit.toFixed(4), description: (l.description ?? 'Reversed').slice(0, 300),
        ...(l.taxRateId ? { vat: { taxCodeId: l.taxCodeId!, taxRateId: l.taxRateId, role: l.vatRole as PostLineVat['role'], taxPoint: isoDay(l.taxPoint!), netLineNo: l.vatNetLineNo ?? undefined, inclusive: !!l.vatInclusive } } : {}) })),
      idempotencyKey: `cash-reversal:${t.id}`, actor: a.actor, reason: a.reason, negativeCashReason: a.negativeCashReason,
    });
    await tx.cashTransaction.update({ where: { id: t.id }, data: { status: 'REVERSED', reversalJournalId: j.id, reversedByUserId: a.actor.userId, reversedAt: new Date(), reversedReason: a.reason.trim() } });
    await this.audit(tx, { action: 'cash_transaction.reversed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'cash_transaction', entityId: t.id,
      before: { status: 'POSTED' }, after: { status: 'REVERSED', journalId: j.id, date }, reason: a.reason, metadata: { balanceWarnings: j.balanceWarnings ?? [] } });
    return { ...(await this.get(tx, a.companyId, t.id)), balanceWarnings: j.balanceWarnings ?? [] };
  }

  async get(tx: Tx, companyId: string, id: string) {
    const t = await tx.cashTransaction.findFirst({ where: { id, companyId } });
    if (!t) throw notFound('Cash transaction not found');
    const minor = (await tx.currency.findUnique({ where: { code: t.currency } }))?.minorUnits ?? 2;
    const lines = await tx.cashTransactionLine.findMany({ where: { transactionId: t.id }, orderBy: { lineNo: 'asc' } });
    return { ...this.view(t, minor), lines: lines.map((l) => this.lineView(l, minor)) };
  }
  private lineView(l: LineRow, minor: number) {
    return { lineNo: l.lineNo, description: l.description, accountId: l.accountId, taxCodeId: l.taxCodeId, amount: fmt(l.amount, minor), net: fmt(l.net, minor), vat: fmt(l.vat, minor), gross: fmt(l.net.plus(l.vat), minor) };
  }
  private view(t: Row, minor: number) {
    return { id: t.id, companyId: t.companyId, direction: t.direction, transactionDate: isoDay(t.transactionDate), taxPoint: t.taxPoint ? isoDay(t.taxPoint) : null, bankAccountId: t.bankAccountId,
      contactId: t.contactId, counterparty: t.counterparty, reference: t.reference, description: t.description, currency: t.currency, amountsIncludeVat: t.amountsIncludeVat,
      net: fmt(t.netTotal, minor), vat: fmt(t.vatTotal, minor), gross: fmt(t.grossTotal, minor), journalId: t.journalId, duplicateOverrideReason: t.duplicateOverrideReason, status: t.status,
      reversalJournalId: t.reversalJournalId, reversedByUserId: t.reversedByUserId, reversedAt: t.reversedAt, reversedReason: t.reversedReason, createdByUserId: t.createdByUserId, createdAt: t.createdAt };
  }
  async list(tx: Tx, companyId: string, q: { direction?: CashDirection; status?: string; bankAccountId?: string; contactId?: string; from?: string; to?: string; limit: number; cursor?: string }) {
    const company = await this.company(tx, companyId);
    const minor = (await tx.currency.findUnique({ where: { code: company.baseCurrency } }))?.minorUnits ?? 2;
    const rows = await tx.cashTransaction.findMany({
      where: { companyId, ...(q.direction ? { direction: q.direction } : {}), ...(q.status ? { status: q.status } : {}), ...(q.bankAccountId ? { bankAccountId: q.bankAccountId } : {}), ...(q.contactId ? { contactId: q.contactId } : {}),
        ...(q.from || q.to ? { transactionDate: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } } : {}) },
      orderBy: [{ transactionDate: 'desc' }, { id: 'desc' }], take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    return { items: rows.slice(0, q.limit).map((r) => this.view(r, minor)), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }
}

export type { BalanceWarning };
