import { createHash } from 'node:crypto';
import { Events, JOURNAL_SOURCES, type ActorKind } from '@uk/contracts';
import { conflict, forbidden, getContext, notFound, unprocessable } from '@uk/core';
import type { Tx } from '@uk/db';
import { auditRow, publishEvent } from '@uk/platform';
import { ZERO, fmt, money, type Money } from './money';

/**
 * THE central PostingService (ADR-45, manifest control 1). It is the only code that writes `journal` / `journal_line`
 * (an architecture test enforces that) and the database refuses such inserts unless the transaction-local posting flag is set,
 * which only this class sets. Posted journals are immutable; corrections are reversal journals.
 *
 * One transaction, fixed order, every step a typed failure:
 *   actor -> permission -> source -> amounts -> idempotency -> period -> accounts -> balance -> extra validators (VAT in M2) -> number -> insert -> audit -> event.
 */
export interface PostingActor {
  kind: ActorKind;
  userId?: string;
  /** Evaluated for the company through the central authoriser (or, for SYSTEM sources, by the owning module). */
  can(permission: string, companyId: string): boolean | Promise<boolean>;
}

export interface PostLineInput { accountId: string; debit: string; credit: string; description?: string }

export interface PostInput {
  organisationId: string;
  companyId: string;
  journalDate: string; // YYYY-MM-DD
  sourceType: string;
  sourceId?: string | null;
  sourceReference?: string | null;
  description: string;
  /** Optional. Only the company's own (functional) currency is supported until milestone M3 (DEC-009); anything else is refused. */
  currency?: string;
  lines: PostLineInput[];
  /** A repeat with the same key and the same content returns the existing journal; the same key with different content is a conflict. */
  idempotencyKey: string;
  actor: PostingActor;
  reversesJournalId?: string | null;
  /** Free text kept on the audit event (e.g. why a journal is reversed). */
  reason?: string | null;
}

export interface PostedJournal {
  id: string; journalNumber: number; journalDate: string; periodId: string; companyId: string; sourceType: string; sourceId: string | null;
  total: string; lineCount: number; reversesJournalId: string | null; replayed: boolean;
}

/** Context handed to extra validators (the VAT validator joins in M2). */
export interface PostingContext {
  tx: Tx; input: PostInput; period: { id: string; startDate: Date; endDate: Date };
  accounts: Map<string, { id: string; code: string; type: string; isControl: boolean; controlKind: string | null; taxTreatment: string }>;
  lines: { accountId: string; debit: Money; credit: Money; description?: string }[];
}
export type PostingValidator = (ctx: PostingContext) => Promise<void>;

const MAX_LINES = 500;
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export class PostingService {
  constructor(private readonly opts: { captureDeviceMetadata?: boolean; validators?: PostingValidator[] } = {}) {}

  async post(tx: Tx, input: PostInput): Promise<PostedJournal> {
    const { actor } = input;
    // 1. actor: AI never posts (manifest control 10); a user needs an identity
    if (actor.kind === 'AI') throw forbidden('AI cannot post accounting entries; a person must post or approve them', 'ai_cannot_post');
    if (actor.kind === 'USER' && !actor.userId) throw forbidden('A user actor needs a user id', 'actor_invalid');
    const source = JOURNAL_SOURCES[input.sourceType];
    if (!source) throw unprocessable(`Unknown journal source ${input.sourceType}`, 'unknown_source');
    if (!source.actors.includes(actor.kind)) throw forbidden(`${input.sourceType} journals cannot be posted by a ${actor.kind.toLowerCase()} actor`, 'source_not_allowed_for_actor');
    // 2. permission, for this company
    if (!(await actor.can(source.permission, input.companyId))) throw forbidden(`Requires permission ${source.permission}`, 'permission_denied');
    // 3. source reference
    if (input.sourceType === 'REVERSAL') {
      if (!input.reversesJournalId || input.sourceId !== input.reversesJournalId) throw unprocessable('A reversal must name the journal it reverses as its source', 'source_reference_required');
    } else if (input.reversesJournalId) throw unprocessable('Only REVERSAL journals can reverse another journal', 'source_reference_invalid');
    else if (input.sourceType !== 'MANUAL' && input.sourceType !== 'OPENING_BALANCE' && !input.sourceId) throw unprocessable('A source transaction reference is required', 'source_reference_required');
    if (!input.description?.trim()) throw unprocessable('A description is required', 'description_required');

    // 4. company, currency, amounts
    const company = await tx.company.findUnique({ where: { id: input.companyId }, select: { id: true, baseCurrency: true } });
    if (!company) throw notFound('Company not found');
    if (input.currency && input.currency !== company.baseCurrency) {
      throw unprocessable(`Foreign-currency postings are not supported yet (planned: milestone M3, decision DEC-009). Post in the company's currency, ${company.baseCurrency}.`, 'foreign_currency_not_supported', { companyCurrency: company.baseCurrency, requested: input.currency });
    }
    const cur = await tx.currency.findUnique({ where: { code: company.baseCurrency } });
    if (!cur) throw unprocessable('Company base currency is not a known currency', 'currency_invalid');
    if (input.lines.length < 2) throw unprocessable('A journal needs at least two lines', 'too_few_lines');
    if (input.lines.length > MAX_LINES) throw unprocessable(`A journal is limited to ${MAX_LINES} lines`, 'too_many_lines');
    const date = toDate(input.journalDate);
    if (Number.isNaN(date.getTime()) || isoDay(date) !== input.journalDate) throw unprocessable('Invalid journal date', 'invalid_date');
    const lines = input.lines.map((l, i) => {
      let debit: Money, credit: Money;
      try { debit = money(l.debit || '0'); credit = money(l.credit || '0'); } catch { throw unprocessable(`Line ${i + 1}: amounts must be decimal numbers`, 'invalid_amount'); }
      if (debit.isNegative() || credit.isNegative()) throw unprocessable(`Line ${i + 1}: amounts cannot be negative`, 'invalid_amount');
      if (debit.isZero() === credit.isZero()) throw unprocessable(`Line ${i + 1}: exactly one of debit and credit must be greater than zero`, 'invalid_amount');
      if (debit.decimalPlaces() > cur.minorUnits || credit.decimalPlaces() > cur.minorUnits) throw unprocessable(`Line ${i + 1}: ${company.baseCurrency} amounts have at most ${cur.minorUnits} decimal places`, 'invalid_amount');
      return { accountId: l.accountId, debit, credit, description: l.description };
    });

    // 5. idempotency (before anything is written)
    const contentHash = createHash('sha256').update(JSON.stringify({
      c: input.companyId, d: input.journalDate, s: input.sourceType, i: input.sourceId ?? null, r: input.sourceReference ?? null, t: input.description.trim(), v: input.reversesJournalId ?? null,
      l: lines.map((l) => [l.accountId, l.debit.toFixed(4), l.credit.toFixed(4), l.description ?? null]),
    })).digest('hex');
    const existing = await tx.journal.findUnique({ where: { organisationId_companyId_idempotencyKey: { organisationId: input.organisationId, companyId: input.companyId, idempotencyKey: input.idempotencyKey } } });
    if (existing) {
      if (existing.contentHash !== contentHash) throw conflict('This idempotency key was already used for a different journal', 'idempotency_conflict');
      return { ...this.view(existing, cur.minorUnits), replayed: true };
    }

    // 6. period
    const periodRef = await tx.accountingPeriod.findFirst({ where: { companyId: input.companyId, startDate: { lte: date }, endDate: { gte: date } }, select: { id: true } });
    if (!periodRef) throw unprocessable(`No accounting period covers ${input.journalDate}`, 'no_period');
    // Lock the period row for the rest of this transaction: a concurrent close/lock (an UPDATE of the row) waits for this posting to commit, and a
    // close that committed first is seen here. Without it a journal could land in a period that was closed a moment earlier.
    await tx.$queryRaw`SELECT id FROM accounting_period WHERE id = ${periodRef.id}::uuid FOR SHARE`;
    const period = await tx.accountingPeriod.findUniqueOrThrow({ where: { id: periodRef.id } });
    if (period.status !== 'OPEN') throw unprocessable(`The accounting period ${isoDay(period.startDate)} to ${isoDay(period.endDate)} is ${period.status.toLowerCase()}`, period.status === 'LOCKED' ? 'period_locked' : 'period_closed');

    // 7. accounts
    const ids = [...new Set(lines.map((l) => l.accountId))];
    const found = await tx.account.findMany({ where: { companyId: input.companyId, id: { in: ids } } });
    const accounts = new Map(found.map((a) => [a.id, a]));
    for (const id of ids) {
      const a = accounts.get(id);
      if (!a) throw unprocessable('A line refers to an account that does not exist in this company', 'unknown_account');
      if ((a.activeFrom && date < a.activeFrom) || (a.activeTo && date > a.activeTo)) throw unprocessable(`Account ${a.code} is not active on ${input.journalDate}`, 'account_inactive');
      if (a.isControl && !source.controlAccounts) throw unprocessable(`Account ${a.code} is a control account; ${input.sourceType} journals cannot post to it (it is maintained by its sub-ledger)`, 'control_account_restricted');
    }

    // 7b. opening balances are the one source allowed onto control accounts, so they are fenced: dated at the very start of record keeping
    if (input.sourceType === 'OPENING_BALANCE') {
      const first = await tx.accountingPeriod.findFirst({ where: { companyId: input.companyId }, orderBy: { startDate: 'asc' }, select: { startDate: true } });
      if (!first || isoDay(first.startDate) !== input.journalDate) throw unprocessable(`Opening balances must be dated ${first ? isoDay(first.startDate) : 'the first day of the first accounting period'}`, 'opening_balance_date_invalid');
    }

    // 8. balance
    const debits = lines.reduce((s, l) => s.plus(l.debit), ZERO);
    const credits = lines.reduce((s, l) => s.plus(l.credit), ZERO);
    if (!debits.equals(credits)) throw unprocessable(`Debits (${fmt(debits, cur.minorUnits)}) must equal credits (${fmt(credits, cur.minorUnits)})`, 'unbalanced_journal');
    if (debits.isZero()) throw unprocessable('A journal cannot be zero', 'invalid_amount');

    // 9. extra validators (VAT treatment arrives with the VAT foundation)
    const ctx: PostingContext = { tx, input, period, accounts: accounts as PostingContext['accounts'], lines };
    for (const v of this.opts.validators ?? []) await v(ctx);

    // 10. number, insert (only here may the posting flag be on), audit, event
    await tx.$queryRaw`SELECT set_config('app.posting', 'on', true)`;
    try {
      const seq = await tx.$queryRaw<{ last_number: number }[]>`
        INSERT INTO ledger_sequence (organisation_id, company_id, last_number) VALUES (${input.organisationId}::uuid, ${input.companyId}::uuid, 1)
        ON CONFLICT (organisation_id, company_id) DO UPDATE SET last_number = ledger_sequence.last_number + 1 RETURNING last_number`;
      const journalNumber = seq[0]!.last_number;
      const journal = await tx.journal.create({ data: {
        organisationId: input.organisationId, companyId: input.companyId, periodId: period.id, journalNumber, journalDate: date,
        sourceType: input.sourceType, sourceId: input.sourceId ?? null, sourceReference: input.sourceReference ?? null, description: input.description.trim(),
        currency: company.baseCurrency, total: debits, lineCount: lines.length, actorType: actor.kind, postedByUserId: actor.userId ?? null,
        idempotencyKey: input.idempotencyKey, contentHash, reversesJournalId: input.reversesJournalId ?? null,
        correlationId: getContext()?.correlationId,
      } });
      await tx.journalLine.createMany({ data: lines.map((l, i) => ({
        organisationId: input.organisationId, companyId: input.companyId, journalId: journal.id, lineNo: i + 1, accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description ?? null,
      })) });
      await tx.auditEvent.createMany({ data: [auditRow({
        action: input.sourceType === 'REVERSAL' ? 'journal.reversed' : 'journal.posted', organisationId: input.organisationId, companyId: input.companyId, actorUserId: actor.userId ?? null,
        entityType: 'journal', entityId: journal.id, reason: input.reason ?? null,
        after: { journalNumber, journalDate: input.journalDate, sourceType: input.sourceType, total: fmt(debits, cur.minorUnits), lines: lines.length },
        metadata: { periodId: period.id, reverses: input.reversesJournalId ?? null, actorKind: actor.kind },
      }, this.opts.captureDeviceMetadata)] });
      await publishEvent(tx, Events.transactionPosted, { aggregateId: journal.id, organisationId: input.organisationId, actorUserId: actor.userId ?? null,
        payload: { journalId: journal.id, companyId: input.companyId, periodId: period.id, journalNumber, journalDate: input.journalDate, sourceType: input.sourceType, sourceId: input.sourceId ?? null, total: fmt(debits, cur.minorUnits), reversesJournalId: input.reversesJournalId ?? null } });
      return { ...this.view(journal, cur.minorUnits), replayed: false };
    } finally {
      await tx.$queryRaw`SELECT set_config('app.posting', 'off', true)`;
    }
  }

  /**
   * Corrections are reversals (manifest control 3): a mirror journal in an OPEN period, dated on or after the original, linked both
   * ways, at most once per original; a reversal cannot itself be reversed (post a new journal instead).
   */
  async reverse(tx: Tx, a: { organisationId: string; companyId: string; journalId: string; journalDate?: string; reason: string; actor: PostingActor }): Promise<PostedJournal> {
    const original = await tx.journal.findFirst({ where: { id: a.journalId, companyId: a.companyId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    if (!original) throw notFound('Journal not found');
    if (original.sourceType === 'REVERSAL') throw unprocessable('A reversal cannot be reversed; post a new journal instead', 'cannot_reverse_reversal');
    const already = await tx.journal.findFirst({ where: { reversesJournalId: original.id }, select: { id: true, journalNumber: true } });
    if (already) throw conflict(`Journal ${original.journalNumber} was already reversed by journal ${already.journalNumber}`, 'already_reversed');
    const date = a.journalDate ?? new Date().toISOString().slice(0, 10);
    if (date < isoDay(original.journalDate)) throw unprocessable('A reversal cannot be dated before the journal it reverses', 'reversal_before_original');
    return this.post(tx, {
      organisationId: a.organisationId, companyId: a.companyId, journalDate: date, sourceType: 'REVERSAL', sourceId: original.id, sourceReference: `J-${original.journalNumber}`,
      description: `Reversal of journal ${original.journalNumber}: ${original.description}`.slice(0, 500),
      lines: original.lines.map((l) => ({ accountId: l.accountId, debit: l.credit.toFixed(4), credit: l.debit.toFixed(4), description: l.description ?? undefined })),
      idempotencyKey: `reversal:${original.id}`, actor: a.actor, reversesJournalId: original.id, reason: a.reason,
    });
  }

  private view(j: { id: string; journalNumber: number; journalDate: Date; periodId: string; companyId: string; sourceType: string; sourceId: string | null; total: Money; lineCount: number; reversesJournalId: string | null }, minor: number): Omit<PostedJournal, 'replayed'> {
    return { id: j.id, journalNumber: j.journalNumber, journalDate: isoDay(j.journalDate), periodId: j.periodId, companyId: j.companyId, sourceType: j.sourceType, sourceId: j.sourceId, total: fmt(j.total, minor), lineCount: j.lineCount, reversesJournalId: j.reversesJournalId };
  }
}
