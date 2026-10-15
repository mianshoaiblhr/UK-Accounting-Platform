import { randomUUID } from 'node:crypto';
import { conflict, forbidden, notFound, unprocessable } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow, statementLineView } from '@uk/platform';
import { CashService } from './cash';
import { ZERO, fmt, money, type Money } from './money';
import type { PostingActor } from './posting';

/**
 * Bank reconciliation (M7b; DEC-042). The ONLY writer of `bank_match` and `bank_reconciliation` (architecture-tested). A match links a statement
 * line to a ledger entry on the bank account for an amount in the account currency; the database proves both sides and moves the statement line's
 * matched part. Suggestions are computed on request and never match or post. Charges and interest are posted from a statement line as cash
 * transactions (CashService, so the PostingService and every cash rule apply) and matched in the same transaction.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const daysBetween = (a: string, b: string) => Math.round((toDate(a).getTime() - toDate(b).getTime()) / 86_400_000);
const OVERRIDE_DAYS = 14;
const SUGGEST_DAYS = 7;
const BUCKETS = [['0-7', 7], ['8-30', 30], ['31-60', 60], ['61+', Number.POSITIVE_INFINITY]] as const;
const CHARGE_WORDS = /\b(CHARGES?|FEES?|COMMISSION)\b/i;
const INTEREST_WORDS = /\b(INTEREST|INT PAID|GROSS INT)\b/i;
const norm = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export interface ReconcileActor extends PostingActor { userId: string }
type BankRow = Awaited<ReturnType<Tx['bankAccount']['findUniqueOrThrow']>> & { minor: number };
interface LedgerRow { id: string; journal_id: string; journal_number: number; journal_date: Date; source_type: string; source_reference: string | null; description: string | null; value: string | null; used: string; used_by_date: string }

export class ReconciliationService {
  private readonly cash: CashService;
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {
    this.cash = new CashService(opts);
  }
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: ReconcileActor, permission: string, companyId: string) {
    if (actor.kind !== 'USER' || !actor.userId) throw forbidden('Bank reconciliation is done by people', 'ai_cannot_post');
    if (!(await actor.can(permission, companyId))) throw forbidden(`Requires permission ${permission}`, 'permission_denied');
  }
  private async bank(tx: Tx, companyId: string, id: string): Promise<BankRow> {
    const b = await tx.bankAccount.findFirst({ where: { id, companyId } });
    if (!b) throw notFound('Bank account not found');
    return { ...b, minor: (await tx.currency.findUnique({ where: { code: b.currency } }))?.minorUnits ?? 2 };
  }
  private async statementLine(tx: Tx, companyId: string, id: string) {
    const l = await tx.bankStatementLine.findFirst({ where: { id, companyId } });
    if (!l) throw notFound('Statement line not found');
    return l;
  }

  /** Ledger entries on the bank account after the statement opening date (earlier ones are in the opening balance), valued in the account currency. */
  private ledger(tx: Tx, b: BankRow, o: { asOf?: string; ids?: string[] } = {}) {
    const asOf = o.asOf ?? '9999-12-31';
    return tx.$queryRaw<LedgerRow[]>`
      SELECT jl.id, jl.journal_id, j.journal_number, j.journal_date, j.source_type, j.source_reference, jl.description,
             bank_line_value(jl.organisation_id, jl.id, ${b.currency}::char(3))::text AS value,
             coalesce((SELECT sum(m.amount) FROM bank_match m WHERE m.journal_line_id = jl.id AND m.status = 'ACTIVE'), 0)::text AS used,
             coalesce((SELECT sum(m.amount) FROM bank_match m JOIN bank_statement_line s ON s.id = m.statement_line_id
                        WHERE m.journal_line_id = jl.id AND m.status = 'ACTIVE' AND s.transaction_date <= ${asOf}::date), 0)::text AS used_by_date
        FROM journal_line jl JOIN journal j ON j.id = jl.journal_id AND j.organisation_id = jl.organisation_id
       WHERE jl.company_id = ${b.companyId}::uuid AND jl.account_id = ${b.accountId}::uuid AND jl.adjusts_currency IS NULL
         AND j.journal_date > ${isoDay(b.statementOpeningDate)}::date AND j.journal_date <= ${asOf}::date
         ${o.ids ? Prisma.sql`AND jl.id = ANY(${o.ids}::uuid[])` : Prisma.empty}
       ORDER BY j.journal_date, j.journal_number, jl.line_no`;
  }
  private async latestSignOff(tx: Tx, bankAccountId: string) {
    return tx.bankReconciliation.findFirst({ where: { bankAccountId }, orderBy: [{ asAt: 'desc' }, { signedAt: 'desc' }] });
  }

  // ───── Matching (V1-REC-01, V1-REC-02, V1-REC-05) ─────
  async match(tx: Tx, a: { organisationId: string; companyId: string; actor: ReconcileActor; statementLineId: string; journalLineId: string; amount?: string; overrideReason?: string; fromSuggestion?: boolean; kind?: 'POSTED_FROM_STATEMENT' }) {
    await this.need(a.actor, 'bank:reconcile', a.companyId);
    await tx.$queryRaw`SELECT id FROM bank_statement_line WHERE id = ${a.statementLineId}::uuid FOR UPDATE`;
    const s = await this.statementLine(tx, a.companyId, a.statementLineId);
    if (s.voided) throw conflict('This statement line belongs to a voided import', 'statement_line_void');
    const b = await this.bank(tx, a.companyId, s.bankAccountId);
    if (b.status !== 'ACTIVE') throw conflict('The bank account is closed', 'bank_account_closed');
    const [l] = await this.ledger(tx, b, { ids: [a.journalLineId] });
    if (!l) {
      const jl = await tx.journalLine.findFirst({ where: { id: a.journalLineId, companyId: a.companyId }, select: { accountId: true } });
      if (!jl) throw notFound('Ledger entry not found');
      if (jl.accountId !== b.accountId) throw unprocessable('The ledger entry is not on this bank account', 'not_on_bank_account');
      throw unprocessable('The ledger entry is dated on or before the statement opening date, so it is already in the opening balance', 'before_statement_opening');
    }
    if (l.value === null) throw unprocessable(`The ledger entry is not in the account's currency (${b.currency})`, 'currency_mismatch');
    const value = money(l.value), restL = value.minus(money(l.used)), restS = s.amount.minus(s.matchedAmount);
    if (value.isNegative() !== s.amount.isNegative()) throw unprocessable('Money in matches a debit to the bank account, money out a credit', 'direction_mismatch');
    if (restS.isZero()) throw conflict('This statement line is already fully matched', 'already_matched');
    if (restL.isZero()) throw conflict('This ledger entry is already fully matched', 'already_matched');
    let amt: Money = restS.abs().lessThan(restL.abs()) ? restS : restL;
    if (a.amount) {
      const asked = money(a.amount).abs();
      if (asked.isZero() || asked.decimalPlaces() > b.minor) throw unprocessable(`The amount must be greater than zero with at most ${b.minor} decimal places`, 'invalid_amount');
      if (asked.greaterThan(restS.abs()) || asked.greaterThan(restL.abs())) throw unprocessable(`The amount is more than is left to match (statement ${fmt(restS.abs(), b.minor)}, ledger ${fmt(restL.abs(), b.minor)})`, 'match_exceeds_outstanding');
      amt = s.amount.isNegative() ? asked.negated() : asked;
    }
    const gap = Math.abs(daysBetween(isoDay(s.transactionDate), isoDay(l.journal_date)));
    if (gap > OVERRIDE_DAYS && !a.overrideReason?.trim()) {
      throw unprocessable(`The bank date and the ledger date are ${gap} days apart (more than ${OVERRIDE_DAYS}); give an overrideReason to match them`, 'override_reason_required', { days: gap });
    }
    const id = randomUUID();
    const kind = a.kind ?? (a.fromSuggestion ? 'SUGGESTION' : 'MANUAL');
    await tx.bankMatch.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, bankAccountId: b.id, statementLineId: s.id, journalLineId: l.id, journalId: l.journal_id, amount: amt,
      kind, overrideReason: gap > OVERRIDE_DAYS ? a.overrideReason!.trim() : null, createdByUserId: a.actor.userId } });
    await this.audit(tx, { action: 'bank_match.created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'bank_match', entityId: id,
      after: { statementLineId: s.id, journalLineId: l.id, journalNumber: l.journal_number, amount: fmt(amt, b.minor), kind, daysApart: gap }, reason: gap > OVERRIDE_DAYS ? a.overrideReason! : null,
      metadata: { override: gap > OVERRIDE_DAYS } });
    return this.lineDetail(tx, a.companyId, s.id);
  }

  async unmatch(tx: Tx, a: { organisationId: string; companyId: string; actor: ReconcileActor; matchId: string; reason: string }) {
    await this.need(a.actor, 'bank:reconcile', a.companyId);
    const m = await tx.bankMatch.findFirst({ where: { id: a.matchId, companyId: a.companyId } });
    if (!m) throw notFound('Match not found');
    if (m.status !== 'ACTIVE') throw conflict('This match was already undone', 'match_undone');
    const s = await this.statementLine(tx, a.companyId, m.statementLineId);
    const j = await tx.journal.findUniqueOrThrow({ where: { id: m.journalId }, select: { journalDate: true } });
    const signed = await this.latestSignOff(tx, m.bankAccountId);
    const earliest = isoDay(s.transactionDate) < isoDay(j.journalDate) ? isoDay(s.transactionDate) : isoDay(j.journalDate);
    const afterSignOff = !!signed && earliest <= isoDay(signed.asAt);
    await tx.bankMatch.update({ where: { id: m.id }, data: { status: 'UNMATCHED', unmatchedByUserId: a.actor.userId, unmatchedAt: new Date(), unmatchReason: a.reason.trim(), afterSignOff } });
    await this.audit(tx, { action: 'bank_match.undone', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'bank_match', entityId: m.id,
      before: { status: 'ACTIVE' }, after: { status: 'UNMATCHED' }, reason: a.reason, metadata: { afterSignOff, signOffId: afterSignOff ? signed!.id : null, signOffAsAt: afterSignOff ? isoDay(signed!.asAt) : null } });
    return this.lineDetail(tx, a.companyId, s.id);
  }

  /** V1-BANK-07/08: post what is left of a statement line as a cash transaction dated on the line's date, and match it in the same transaction. */
  async postFromStatement(tx: Tx, a: { organisationId: string; companyId: string; actor: ReconcileActor; statementLineId: string; kind: 'CHARGE' | 'INTEREST' | 'OTHER'; accountId?: string; taxCodeId?: string;
    description?: string; negativeCashReason?: string; duplicateOverrideReason?: string }) {
    await this.need(a.actor, 'bank:reconcile', a.companyId);
    const s = await this.statementLine(tx, a.companyId, a.statementLineId);
    if (s.voided) throw conflict('This statement line belongs to a voided import', 'statement_line_void');
    const b = await this.bank(tx, a.companyId, s.bankAccountId);
    const company = await tx.company.findUniqueOrThrow({ where: { id: a.companyId }, select: { baseCurrency: true } });
    if (b.currency !== company.baseCurrency) throw unprocessable('Posting from a foreign-currency statement comes with VAT on foreign currency (M5c); record the entry and match it', 'foreign_currency_not_supported');
    const rest = s.amount.minus(s.matchedAmount);
    if (rest.isZero()) throw conflict('This statement line is already fully matched', 'already_matched');
    const accountId = a.accountId ?? (a.kind === 'CHARGE' ? b.chargesAccountId : a.kind === 'INTEREST' ? (rest.isNegative() ? b.interestPaidAccountId : b.interestReceivedAccountId) : null);
    if (!accountId) throw unprocessable(a.kind === 'OTHER' ? 'Give the account to post to' : `Set the bank account's ${a.kind === 'CHARGE' ? 'charges' : 'interest'} account, or give an account`, 'account_required');
    const description = (a.description ?? s.description).slice(0, 300);
    const t = await this.cash.record(tx, {
      organisationId: a.organisationId, companyId: a.companyId, actor: a.actor, direction: rest.isNegative() ? 'PAYMENT' : 'RECEIPT', transactionDate: isoDay(s.transactionDate), bankAccountId: b.accountId,
      reference: s.reference?.slice(0, 100), description: `${a.kind === 'CHARGE' ? 'Bank charge' : a.kind === 'INTEREST' ? 'Bank interest' : 'From statement'}: ${s.description}`.slice(0, 500),
      amountsIncludeVat: true, lines: [{ description, accountId, amount: fmt(rest.abs(), b.minor), ...(a.taxCodeId ? { taxCodeId: a.taxCodeId } : {}) }],
      duplicateOverrideReason: a.duplicateOverrideReason, negativeCashReason: a.negativeCashReason,
    });
    const bankLine = await tx.journalLine.findFirstOrThrow({ where: { journalId: t.journalId, lineNo: 1 }, select: { id: true } });
    const line = await this.match(tx, { organisationId: a.organisationId, companyId: a.companyId, actor: a.actor, statementLineId: s.id, journalLineId: bankLine.id, kind: 'POSTED_FROM_STATEMENT' });
    return { cashTransaction: t, line };
  }

  async lineDetail(tx: Tx, companyId: string, id: string) {
    const s = await this.statementLine(tx, companyId, id);
    const b = await this.bank(tx, companyId, s.bankAccountId);
    const matches = await tx.bankMatch.findMany({ where: { statementLineId: s.id }, orderBy: { createdAt: 'asc' } });
    const journals = new Map((await tx.journal.findMany({ where: { id: { in: [...new Set(matches.map((m) => m.journalId))] } }, select: { id: true, journalNumber: true, journalDate: true, sourceType: true } })).map((j) => [j.id, j]));
    return { ...statementLineView(s, b.minor), matches: matches.map((m) => ({ id: m.id, journalLineId: m.journalLineId, journalId: m.journalId, journalNumber: journals.get(m.journalId)?.journalNumber ?? null,
      journalDate: journals.get(m.journalId) ? isoDay(journals.get(m.journalId)!.journalDate) : null, sourceType: journals.get(m.journalId)?.sourceType ?? null, amount: fmt(m.amount, b.minor), kind: m.kind,
      overrideReason: m.overrideReason, status: m.status, unmatchReason: m.unmatchReason, afterSignOff: m.afterSignOff, createdByUserId: m.createdByUserId, createdAt: m.createdAt, unmatchedAt: m.unmatchedAt })) };
  }

  // ───── Suggestions (V1-REC-04): deterministic, never acted on by themselves ─────
  async suggestions(tx: Tx, companyId: string, bankAccountId: string, q: { from?: string; to?: string; limit: number }) {
    const b = await this.bank(tx, companyId, bankAccountId);
    const lines = (await tx.bankStatementLine.findMany({ where: { bankAccountId: b.id, voided: false, ...(q.from || q.to ? { transactionDate: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } } : {}) },
      orderBy: [{ transactionDate: 'asc' }, { createdAt: 'asc' }, { lineNo: 'asc' }] })).filter((l) => !l.matchedAmount.equals(l.amount)).slice(0, q.limit);
    const ledger = (await this.ledger(tx, b)).filter((l) => l.value !== null && !money(l.value).minus(money(l.used)).isZero());
    const scored = lines.map((s) => {
      const rest = s.amount.minus(s.matchedAmount), date = isoDay(s.transactionDate), text = norm(`${s.description} ${s.reference ?? ''}`);
      const candidates = ledger.filter((l) => money(l.value!).minus(money(l.used)).equals(rest) && Math.abs(daysBetween(date, isoDay(l.journal_date))) <= SUGGEST_DAYS).map((l) => {
        const gap = Math.abs(daysBetween(date, isoDay(l.journal_date))), ref = norm(l.source_reference);
        const refHit = ref.length >= 3 && text.includes(ref);
        return { journalLineId: l.id, journalId: l.journal_id, journalNumber: l.journal_number, date: isoDay(l.journal_date), sourceType: l.source_type, reference: l.source_reference, description: l.description,
          amount: fmt(money(l.value!).minus(money(l.used)), b.minor), score: 100 - gap * 5 + (refHit ? 50 : 0), reasons: ['same amount', gap === 0 ? 'same date' : `${gap} day(s) apart`, ...(refHit ? ['reference in the bank narrative'] : [])] };
      }).sort((x, y) => y.score - x.score || x.date.localeCompare(y.date)).slice(0, 5);
      const proposal = candidates.length > 0 ? null
        : CHARGE_WORDS.test(s.description) && rest.isNegative() ? { kind: 'CHARGE' as const, accountId: b.chargesAccountId }
        : INTEREST_WORDS.test(s.description) ? { kind: 'INTEREST' as const, accountId: rest.isNegative() ? b.interestPaidAccountId : b.interestReceivedAccountId } : null;
      return { statementLineId: s.id, date, description: s.description, reference: s.reference, unmatched: fmt(rest, b.minor), candidates, proposal };
    });
    // the same ledger entry proposed as the best match for two statement lines is ambiguous for both
    const top = new Map<string, number>();
    for (const x of scored) if (x.candidates[0]) top.set(x.candidates[0].journalLineId, (top.get(x.candidates[0].journalLineId) ?? 0) + 1);
    return { bankAccountId: b.id, currency: b.currency, items: scored.map((x) => ({ ...x,
      ambiguous: (x.candidates.length > 1 && x.candidates[0]!.score === x.candidates[1]!.score) || (x.candidates[0] ? (top.get(x.candidates[0].journalLineId) ?? 0) > 1 : false) })),
      notice: 'Suggestions only: nothing is matched or posted until a person accepts one.' };
  }

  // ───── Unmatched items with ageing (V1-BANK-05, V1-REC-03) and the proof (V1-MOD-18) ─────
  async unmatched(tx: Tx, companyId: string, bankAccountId: string, q: { asOf?: string }) {
    const b = await this.bank(tx, companyId, bankAccountId);
    const asOf = q.asOf ?? isoDay(new Date());
    const stmt = await tx.$queryRaw<{ id: string; transaction_date: Date; description: string; reference: string | null; amount: string; matched: string }[]>`
      SELECT s.id, s.transaction_date, s.description, s.reference, s.amount::text AS amount,
             coalesce((SELECT sum(m.amount) FROM bank_match m JOIN journal j ON j.id = m.journal_id WHERE m.statement_line_id = s.id AND m.status = 'ACTIVE' AND j.journal_date <= ${asOf}::date), 0)::text AS matched
        FROM bank_statement_line s WHERE s.bank_account_id = ${b.id}::uuid AND NOT s.voided AND s.transaction_date <= ${asOf}::date ORDER BY s.transaction_date, s.created_at, s.line_no`;
    const statement = stmt.map((s) => ({ id: s.id, date: isoDay(s.transaction_date), description: s.description, reference: s.reference, amount: money(s.amount), open: money(s.amount).minus(money(s.matched)) }))
      .filter((s) => !s.open.isZero());
    const ledger = (await this.ledger(tx, b, { asOf })).filter((l) => l.value !== null).map((l) => ({ id: l.id, journalId: l.journal_id, journalNumber: l.journal_number, date: isoDay(l.journal_date), sourceType: l.source_type,
      reference: l.source_reference, description: l.description, amount: money(l.value!), open: money(l.value!).minus(money(l.used_by_date)) })).filter((l) => !l.open.isZero());
    const age = <T extends { date: string; open: Money; amount: Money }>(items: T[]) => {
      const buckets = Object.fromEntries(BUCKETS.map(([k]) => [k, { count: 0, total: ZERO }])) as Record<string, { count: number; total: Money }>;
      for (const i of items) { const d = daysBetween(asOf, i.date); const k = BUCKETS.find(([, max]) => d <= max)![0]; buckets[k]!.count++; buckets[k]!.total = buckets[k]!.total.plus(i.open); }
      return { count: items.length, total: fmt(items.reduce((t, i) => t.plus(i.open), ZERO), b.minor),
        buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, { count: v.count, total: fmt(v.total, b.minor) }])),
        items: items.map(({ amount, open, ...i }) => ({ ...i, amount: fmt(amount, b.minor), unmatched: fmt(open, b.minor), ageDays: daysBetween(asOf, i.date) })) };
    };
    return { bankAccountId: b.id, currency: b.currency, asOf, statement: age(statement), ledger: age(ledger) };
  }

  async report(tx: Tx, companyId: string, bankAccountId: string, q: { asOf?: string }) {
    const b = await this.bank(tx, companyId, bankAccountId);
    const asOf = q.asOf ?? isoDay(new Date());
    const open = isoDay(b.statementOpeningDate);
    const [st] = await tx.$queryRaw<{ sum: string | null }[]>`SELECT sum(amount)::text AS sum FROM bank_statement_line WHERE bank_account_id = ${b.id}::uuid AND NOT voided AND transaction_date <= ${asOf}::date`;
    const [ld] = await tx.$queryRaw<{ total: string | null; opening: string | null }[]>`
      SELECT sum(v)::text AS total, sum(v) FILTER (WHERE d <= ${open}::date)::text AS opening FROM (
        SELECT bank_line_value(jl.organisation_id, jl.id, ${b.currency}::char(3)) AS v, j.journal_date AS d
          FROM journal_line jl JOIN journal j ON j.id = jl.journal_id AND j.organisation_id = jl.organisation_id
         WHERE jl.company_id = ${b.companyId}::uuid AND jl.account_id = ${b.accountId}::uuid AND jl.adjusts_currency IS NULL AND j.journal_date <= ${asOf}::date) x`;
    const un = await this.unmatched(tx, companyId, bankAccountId, { asOf });
    const statementBalance = b.statementOpeningBalance.plus(money(st?.sum ?? '0')), ledgerBalance = money(ld?.total ?? '0');
    const us = money(un.statement.total), ul = money(un.ledger.total);
    const difference = statementBalance.minus(us).minus(ledgerBalance.minus(ul));
    const signed = await this.latestSignOff(tx, b.id);
    return { bankAccountId: b.id, currency: b.currency, asOf,
      statementBalance: fmt(statementBalance, b.minor), unmatchedStatement: un.statement.total, adjustedStatement: fmt(statementBalance.minus(us), b.minor),
      ledgerBalance: fmt(ledgerBalance, b.minor), unmatchedLedger: un.ledger.total, adjustedLedger: fmt(ledgerBalance.minus(ul), b.minor), difference: fmt(difference, b.minor),
      opening: { date: open, statement: fmt(b.statementOpeningBalance, b.minor), ledger: fmt(money(ld?.opening ?? '0'), b.minor) },
      reconciled: difference.isZero(), unmatchedStatementLines: un.statement.count, unmatchedLedgerLines: un.ledger.count,
      lastSignOff: signed ? { id: signed.id, asAt: isoDay(signed.asAt), signedByUserId: signed.signedByUserId, signedAt: signed.signedAt } : null,
      explanation: 'Statement balance less items on the statement not yet in the books, against ledger balance less items in the books not yet on the statement. A difference means the opening points disagree.' };
  }

  async signOff(tx: Tx, a: { organisationId: string; companyId: string; actor: ReconcileActor; bankAccountId: string; asOf: string; bankClosingBalance: string; notes?: string }) {
    await this.need(a.actor, 'bank:reconcile', a.companyId);
    const b = await this.bank(tx, a.companyId, a.bankAccountId);
    const signed = await this.latestSignOff(tx, b.id);
    if (signed && isoDay(signed.asAt) > a.asOf) throw conflict(`A reconciliation is already signed off as at ${isoDay(signed.asAt)}, after ${a.asOf}`, 'reconciled_later');
    const r = await this.report(tx, a.companyId, b.id, { asOf: a.asOf });
    const closing = money(a.bankClosingBalance);
    if (!closing.equals(money(r.statementBalance))) {
      throw unprocessable(`The bank's closing balance ${fmt(closing, b.minor)} is not the imported statement balance ${r.statementBalance} as at ${a.asOf}: a statement is missing or incomplete`, 'statement_incomplete', { statementBalance: r.statementBalance, bankClosingBalance: fmt(closing, b.minor) });
    }
    if (!r.reconciled) throw unprocessable(`The reconciliation does not prove: difference ${r.difference}`, 'reconciliation_difference', { difference: r.difference, opening: r.opening });
    const id = randomUUID();
    await tx.bankReconciliation.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, bankAccountId: b.id, asAt: toDate(a.asOf), bankClosingBalance: closing,
      statementBalance: money(r.statementBalance), ledgerBalance: money(r.ledgerBalance), unmatchedStatement: money(r.unmatchedStatement), unmatchedLedger: money(r.unmatchedLedger), difference: money(r.difference),
      unmatchedStatementLines: r.unmatchedStatementLines, unmatchedLedgerLines: r.unmatchedLedgerLines, notes: a.notes?.trim() ?? null, signedByUserId: a.actor.userId } });
    await this.audit(tx, { action: 'bank_reconciliation.signed_off', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'bank_reconciliation', entityId: id,
      after: { bankAccountId: b.id, asOf: a.asOf, statementBalance: r.statementBalance, ledgerBalance: r.ledgerBalance, unmatchedStatement: r.unmatchedStatement, unmatchedLedger: r.unmatchedLedger } });
    return { ...r, signOff: { id, asAt: a.asOf, signedByUserId: a.actor.userId } };
  }

  async listSignOffs(tx: Tx, companyId: string, bankAccountId: string) {
    const b = await this.bank(tx, companyId, bankAccountId);
    const rows = await tx.bankReconciliation.findMany({ where: { bankAccountId: b.id }, orderBy: [{ asAt: 'desc' }, { signedAt: 'desc' }] });
    return { items: rows.map((r) => ({ id: r.id, asAt: isoDay(r.asAt), bankClosingBalance: fmt(r.bankClosingBalance, b.minor), statementBalance: fmt(r.statementBalance, b.minor), ledgerBalance: fmt(r.ledgerBalance, b.minor),
      unmatchedStatement: fmt(r.unmatchedStatement, b.minor), unmatchedLedger: fmt(r.unmatchedLedger, b.minor), unmatchedStatementLines: r.unmatchedStatementLines, unmatchedLedgerLines: r.unmatchedLedgerLines,
      notes: r.notes, signedByUserId: r.signedByUserId, signedAt: r.signedAt })) };
  }
}
