import { createHash } from 'node:crypto';
import { CLOSING_SOURCES, Events, JOURNAL_SOURCES, type ActorKind } from '@uk/contracts';
import { conflict, forbidden, getContext, notFound, unprocessable } from '@uk/core';
import type { Tx } from '@uk/db';
import { auditRow, publishEvent } from '@uk/platform';
import { RateService, convert, roundingTolerance } from './fx';
import { VatService, sourceVatSide, vatInGross, vatOnNet } from './vat';
import { ZERO, fmt, money, type Money } from './money';

/**
 * THE central PostingService (ADR-45, manifest control 1). It is the only code that writes `journal` / `journal_line`
 * (an architecture test enforces that) and the database refuses such inserts unless the transaction-local posting flag is set,
 * which only this class sets. Posted journals are immutable; corrections are reversal journals.
 *
 * One transaction, fixed order, every step a typed failure:
 *   actor -> permission -> source -> amounts -> idempotency -> period -> accounts -> balance -> extra validators (VAT slot) -> number -> insert -> audit -> event.
 */
export interface PostingActor {
  kind: ActorKind;
  userId?: string;
  /** Evaluated for the company through the central authoriser (or, for SYSTEM sources, by the owning module). */
  can(permission: string, companyId: string): boolean | Promise<boolean>;
}

export interface PostLineOriginal { currency: string; debit: string; credit: string; rate: string; rateId: string }
/**
 * `debit`/`credit` are in the currency of the journal (the transaction currency when `PostInput.currency` is foreign, otherwise the functional
 * currency). `original` and `adjustsCurrency` are set only by trusted code (reversals, revaluation): never by the API. `generated` marks the
 * visible FX-rounding line the service adds.
 */
export interface PostLineVat { taxCodeId: string; taxRateId: string; role: 'NET' | 'VAT' | 'RC_OUTPUT' | 'RC_INPUT'; taxPoint: string; netLineNo?: number; inclusive: boolean;
  /** Credit notes (DEC-029): the tax point of the supply being adjusted, whose rate version applies. */
  ratePoint?: string }
export interface PostLineInput { accountId: string; debit: string; credit: string; description?: string; original?: PostLineOriginal; adjustsCurrency?: string; generated?: boolean;
  /** API input: the VAT code of the line (M4b). The service turns it into `vat` facts and adds the VAT lines. */
  taxCodeId?: string;
  /** Resolved VAT facts (set by the service, or copied by a reversal). */
  vat?: PostLineVat;
  /** Trusted code only (credit notes, DEC-029): use this rate version, in force at `ratePoint` (the adjusted supply's tax point), instead of the one at the tax point. */
  vatRate?: { taxRateId: string; ratePoint: string } }

export interface PostInput {
  organisationId: string;
  companyId: string;
  journalDate: string; // YYYY-MM-DD
  sourceType: string;
  sourceId?: string | null;
  sourceReference?: string | null;
  description: string;
  /** Optional. Omitted or the company's own (functional) currency = a functional journal. A foreign currency (M3, DEC-016/017): line amounts are in it and are converted at the rate below. */
  currency?: string;
  /** Foreign currency only: a stored rate to use; otherwise the lookup rule applies. */
  rateId?: string;
  /** Foreign currency only: a manual rate, stored as an audited MANUAL exchange rate. */
  manualRate?: { rate: string; source: string };
  /** M4b: amounts on VAT-coded lines include VAT. */
  amountsIncludeVat?: boolean;
  /** M4b: tax point when it differs from the journal date. */
  taxPoint?: string;
  lines: PostLineInput[];
  /** A repeat with the same key and the same content returns the existing journal; the same key with different content is a conflict. */
  idempotencyKey: string;
  actor: PostingActor;
  reversesJournalId?: string | null;
  /** Free text kept on the audit event (e.g. why a journal is reversed). */
  reason?: string | null;
  /** Only for sources that `requiresRequest` (opening balance, control adjustment): the request being posted. Set by the RequestService; the actor is the approver. */
  request?: { id: string; requestedByUserId: string; selfApproved: boolean };
  /** DEC-037: why a person takes a cash-in-hand account below zero. Without it such a posting is refused; with it the reason is kept on the journal. */
  negativeCashReason?: string | null;
}

/** DEC-036/037: a bank or cash account this journal lowers that is below zero on the journal date or a later date, once the journal is posted. */
export interface BalanceWarning { accountId: string; accountCode: string; kind: 'BANK' | 'CASH'; lowestBalance: string; onDate: string; overridden: boolean }

export interface PostedJournal {
  id: string; journalNumber: number; journalDate: string; periodId: string; companyId: string; sourceType: string; sourceId: string | null;
  total: string; lineCount: number; reversesJournalId: string | null; replayed: boolean;
  /** Fresh postings only (a replay returns none). */
  balanceWarnings?: BalanceWarning[];
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
  private readonly rates: RateService;
  private readonly vat: VatService;
  constructor(private readonly opts: { captureDeviceMetadata?: boolean; validators?: PostingValidator[] } = {}) {
    this.rates = new RateService({ captureDeviceMetadata: opts.captureDeviceMetadata });
    this.vat = new VatService({ captureDeviceMetadata: opts.captureDeviceMetadata });
  }

  async post(tx: Tx, input: PostInput): Promise<PostedJournal> {
    const { actor } = input;
    // 1. actor: AI never posts (manifest control 10); a user needs an identity
    if (actor.kind === 'AI') throw forbidden('AI cannot post accounting entries; a person must post or approve them', 'ai_cannot_post');
    if (actor.kind === 'USER' && !actor.userId) throw forbidden('A user actor needs a user id', 'actor_invalid');
    const source = JOURNAL_SOURCES[input.sourceType];
    if (!source) throw unprocessable(`Unknown journal source ${input.sourceType}`, 'unknown_source');
    if (!source.actors.includes(actor.kind)) throw forbidden(`${input.sourceType} journals cannot be posted by a ${actor.kind.toLowerCase()} actor`, 'source_not_allowed_for_actor');
    // 2. permission, for this company. Opening balances / control adjustments are posted on a request: the requester held the source permission when
    //    asking (RequestService); the actor here is the approver (ledger:approve), or the requester when the company's policy exempted the request.
    if (source.requiresRequest) {
      const r = input.request;
      if (!r) throw forbidden(`${input.sourceType} journals can only be posted from an approved journal request`, 'request_required');
      if (!actor.userId) throw forbidden('Posting a request needs a signed-in person', 'actor_invalid');
      if (r.selfApproved ? actor.userId !== r.requestedByUserId : actor.userId === r.requestedByUserId) {
        throw forbidden(r.selfApproved ? 'A policy-exempt request is posted by its requester' : 'A request cannot be approved by the person who made it', 'self_approval_not_allowed');
      }
      const needed = r.selfApproved ? source.permission : 'ledger:approve';
      if (!(await actor.can(needed, input.companyId))) throw forbidden(`Requires permission ${needed}`, 'permission_denied');
      if (input.sourceId !== r.id) throw unprocessable('The source of a request journal is the request', 'source_reference_invalid');
    } else {
      if (input.request) throw unprocessable('Only request-based sources take a request', 'source_reference_invalid');
      if (!(await actor.can(source.permission, input.companyId))) throw forbidden(`Requires permission ${source.permission}`, 'permission_denied');
    }
    this.checkSourceReference(input, source);
    return this.postPrepared(tx, input, source);
  }

  /**
   * Foreign-currency journals (M3): amounts arrive in the transaction currency. The rate is resolved (explicit id, manual, or lookup), each line is
   * converted and rounded per line half-up by the one `convert` function, and a visible FX-rounding line absorbs a difference of up to one minor unit
   * per line (DEC-017). A replay of the same idempotency key returns the existing journal without touching rates.
   */
  private async toFunctional(tx: Tx, input: PostInput, source: (typeof JOURNAL_SOURCES)[string]): Promise<{ input: PostInput; hash?: string; replay?: PostedJournal }> {
    const company = await tx.company.findUnique({ where: { id: input.companyId }, select: { baseCurrency: true } });
    if (!company) throw notFound('Company not found');
    const foreign = !!input.currency && input.currency !== company.baseCurrency;
    if (!foreign) {
      if (input.rateId || input.manualRate) throw unprocessable('A rate applies only to foreign-currency journals', 'rate_not_applicable');
      return { input };
    }
    const ccy = input.currency!;
    // checked before anything is converted or a rate stored: conversion rebuilds the lines and must never drop a VAT code silently
    if (input.lines.some((l) => l.taxCodeId)) throw unprocessable('VAT on foreign-currency journals waits for the verified rule on the currency of VAT amounts (M4b limitation)', 'vat_foreign_currency_not_supported');
    if (source.requiresRequest) throw unprocessable("Opening balances and control adjustments are posted in the company's currency", 'foreign_currency_not_supported', { companyCurrency: company.baseCurrency, requested: ccy });
    if (input.lines.some((l) => l.original || l.adjustsCurrency || l.generated)) throw unprocessable('Lines of a foreign-currency journal carry only amounts in the transaction currency', 'invalid_amount');
    const [ocur, cur] = await Promise.all([tx.currency.findUnique({ where: { code: ccy } }), tx.currency.findUnique({ where: { code: company.baseCurrency } })]);
    if (!ocur) throw unprocessable(`${ccy} is not a known currency`, 'unknown_currency');
    if (!cur) throw unprocessable('Company base currency is not a known currency', 'currency_invalid');
    if (input.lines.length < 2) throw unprocessable('A journal needs at least two lines', 'too_few_lines');
    if (input.lines.length > MAX_LINES) throw unprocessable(`A journal is limited to ${MAX_LINES} lines`, 'too_many_lines');
    const date = toDate(input.journalDate);
    if (Number.isNaN(date.getTime()) || isoDay(date) !== input.journalDate) throw unprocessable('Invalid journal date', 'invalid_date');
    const amounts = input.lines.map((l, i) => {
      let debit: Money, credit: Money;
      try { debit = money(l.debit || '0'); credit = money(l.credit || '0'); } catch { throw unprocessable(`Line ${i + 1}: amounts must be decimal numbers`, 'invalid_amount'); }
      if (debit.isNegative() || credit.isNegative()) throw unprocessable(`Line ${i + 1}: amounts cannot be negative`, 'invalid_amount');
      if (debit.isZero() === credit.isZero()) throw unprocessable(`Line ${i + 1}: exactly one of debit and credit must be greater than zero`, 'invalid_amount');
      if (debit.decimalPlaces() > ocur.minorUnits || credit.decimalPlaces() > ocur.minorUnits) throw unprocessable(`Line ${i + 1}: ${ccy} amounts have at most ${ocur.minorUnits} decimal places`, 'invalid_amount');
      return { debit, credit };
    });
    const od = amounts.reduce((t, a) => t.plus(a.debit), ZERO), oc = amounts.reduce((t, a) => t.plus(a.credit), ZERO);
    if (!od.equals(oc)) throw unprocessable(`Debits (${fmt(od, ocur.minorUnits)} ${ccy}) must equal credits (${fmt(oc, ocur.minorUnits)} ${ccy})`, 'unbalanced_journal');
    // idempotency on what the caller sent (currency and original amounts), not on a rate that may have been updated since
    const hash = createHash('sha256').update(JSON.stringify({ c: input.companyId, d: input.journalDate, s: input.sourceType, i: input.sourceId ?? null, r: input.sourceReference ?? null, t: input.description.trim(), v: input.reversesJournalId ?? null,
      f: ccy, l: input.lines.map((l, i) => [l.accountId, amounts[i]!.debit.toFixed(4), amounts[i]!.credit.toFixed(4), l.description ?? null]) })).digest('hex');
    const existing = await tx.journal.findUnique({ where: { organisationId_companyId_idempotencyKey: { organisationId: input.organisationId, companyId: input.companyId, idempotencyKey: input.idempotencyKey } } });
    if (existing) {
      if (existing.contentHash !== hash) throw conflict('This idempotency key was already used for a different journal', 'idempotency_conflict');
      return { input, hash, replay: { ...this.view(existing, cur.minorUnits), replayed: true } };
    }
    if (!input.actor.userId && input.manualRate) throw forbidden('A manual rate needs a signed-in person', 'actor_invalid');
    const rate = await this.rates.resolveForPosting(tx, { organisationId: input.organisationId, companyId: input.companyId, actor: { userId: input.actor.userId ?? '', can: input.actor.can }, from: ccy, to: company.baseCurrency, date: input.journalDate, rateId: input.rateId, manualRate: input.manualRate });
    const lines: PostLineInput[] = input.lines.map((l, i) => {
      const a = amounts[i]!;
      const fd = convert(a.debit, rate.rate, cur.minorUnits), fc = convert(a.credit, rate.rate, cur.minorUnits);
      if (fd.isZero() && fc.isZero()) throw unprocessable(`Line ${i + 1}: the amount converts to zero in ${company.baseCurrency}`, 'invalid_amount');
      return { accountId: l.accountId, debit: fmt(fd, cur.minorUnits), credit: fmt(fc, cur.minorUnits), description: l.description,
        original: { currency: ccy, debit: fmt(a.debit, ocur.minorUnits), credit: fmt(a.credit, ocur.minorUnits), rate: rate.rate.toFixed(8), rateId: rate.id } };
    });
    const fd = lines.reduce((t, l) => t.plus(money(l.debit)), ZERO), fc = lines.reduce((t, l) => t.plus(money(l.credit)), ZERO);
    const diff = fd.minus(fc);
    if (!diff.isZero()) {
      if (diff.abs().greaterThan(roundingTolerance(lines.length, cur.minorUnits))) throw unprocessable(`The converted lines differ by ${fmt(diff.abs(), cur.minorUnits)}, more than the rounding tolerance (one minor unit per line)`, 'rounding_tolerance_exceeded');
      const fx = await tx.companyFxSetting.findFirst({ where: { companyId: input.companyId }, select: { roundingAccountId: true } });
      if (!fx?.roundingAccountId) throw unprocessable('Converting this journal leaves a rounding difference but the company has no FX rounding account; designate one in the FX settings', 'fx_rounding_account_missing');
      lines.push({ accountId: fx.roundingAccountId, debit: diff.isNegative() ? fmt(diff.abs(), cur.minorUnits) : '0', credit: diff.isNegative() ? '0' : fmt(diff, cur.minorUnits), description: 'FX rounding', generated: true });
    }
    return { input: { ...input, currency: undefined, rateId: undefined, manualRate: undefined, lines }, hash };
  }

  /**
   * Dry run for a journal request (steps 4-8 plus the control-account and opening-balance rules): everything that does not depend on the approval is
   * checked when the request is made, so an approver is never asked to approve something that could not post. Writes nothing.
   */
  async validateForRequest(tx: Tx, input: Omit<PostInput, 'request' | 'idempotencyKey' | 'actor'> & { actor?: PostingActor }): Promise<{ total: string; lines: PostLineInput[]; currency: string }> {
    const source = JOURNAL_SOURCES[input.sourceType];
    if (!source?.requiresRequest) throw unprocessable('Not a request-based journal source', 'unknown_source');
    if (!input.description?.trim()) throw unprocessable('A description is required', 'description_required');
    const base = await this.prepareAmounts(tx, input as PostInput);
    const led = await this.prepareLedger(tx, input as PostInput, source, base);
    return { total: fmt(led.debits, base.cur.minorUnits), currency: base.company.baseCurrency, lines: base.lines.map((l) => ({ accountId: l.accountId, debit: fmt(l.debit, base.cur.minorUnits), credit: fmt(l.credit, base.cur.minorUnits), description: l.description })) };
  }

  private checkSourceReference(input: PostInput, source: (typeof JOURNAL_SOURCES)[string]) {
    if (input.sourceType === 'REVERSAL') {
      if (!input.reversesJournalId || input.sourceId !== input.reversesJournalId) throw unprocessable('A reversal must name the journal it reverses as its source', 'source_reference_required');
    } else if (input.reversesJournalId) throw unprocessable('Only REVERSAL journals can reverse another journal', 'source_reference_invalid');
    else if (!source.requiresRequest && input.sourceType !== 'MANUAL' && !input.sourceId) throw unprocessable('A source transaction reference is required', 'source_reference_required');
    if (!input.description?.trim()) throw unprocessable('A description is required', 'description_required');
  }

  private async postPrepared(tx: Tx, rawInput: PostInput, source: (typeof JOURNAL_SOURCES)[string]): Promise<PostedJournal> {
    const { actor } = rawInput;
    const conv = await this.toFunctional(tx, rawInput, source);
    if (conv.replay) return conv.replay;
    const vatConv = await this.withVat(tx, conv.input, source);
    if (vatConv.replay) return vatConv.replay;
    const input = vatConv.input;
    const { company, cur, date, lines } = await this.prepareAmounts(tx, input);
    // 5. idempotency (before anything is written)
    const contentHash = conv.hash ?? vatConv.hash ?? createHash('sha256').update(JSON.stringify({
      c: input.companyId, d: input.journalDate, s: input.sourceType, i: input.sourceId ?? null, r: input.sourceReference ?? null, t: input.description.trim(), v: input.reversesJournalId ?? null,
      l: lines.map((l) => (l.original ? [l.accountId, l.debit.toFixed(4), l.credit.toFixed(4), l.description ?? null, l.original.currency, l.original.debit, l.original.credit] : [l.accountId, l.debit.toFixed(4), l.credit.toFixed(4), l.description ?? null])),
    })).digest('hex');
    const existing = await tx.journal.findUnique({ where: { organisationId_companyId_idempotencyKey: { organisationId: input.organisationId, companyId: input.companyId, idempotencyKey: input.idempotencyKey } } });
    if (existing) {
      if (existing.contentHash !== contentHash) throw conflict('This idempotency key was already used for a different journal', 'idempotency_conflict');
      return { ...this.view(existing, cur.minorUnits), replayed: true };
    }

    const { period, accounts, debits } = await this.prepareLedger(tx, input, source, { company, cur, date, lines });

    // 9. extra validators (the VAT validator joins in M4)
    const ctx: PostingContext = { tx, input, period, accounts: accounts as PostingContext['accounts'], lines };
    for (const v of this.opts.validators ?? []) await v(ctx);

    // 9b. a VAT period whose return the client approved is locked (V5-M1, DEC-090); the approval takes this lock exclusively, and the database
    // proves the refusal again at insert
    const taxPoints = [...new Set(lines.flatMap((l) => (l.vat ? [l.vat.taxPoint] : [])))];
    if (taxPoints.length) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${'vatreturn:' + input.companyId}, 0))`;
      for (const tp of taxPoints) {
        const locked = await tx.vatReturn.findFirst({ where: { companyId: input.companyId, lockedAt: { not: null }, periodFrom: { lte: toDate(tp) }, periodTo: { gte: toDate(tp) } }, select: { periodFrom: true, periodTo: true } });
        if (locked) throw unprocessable(`The VAT return for ${isoDay(locked.periodFrom)} to ${isoDay(locked.periodTo)} was approved: the tax point ${tp} is in a locked VAT period; record the correction in a later return`, 'vat_period_locked');
      }
    }

    // 9a. negative bank and cash (DEC-036, DEC-037): the database proves the cash refusal again at commit
    const balanceWarnings = await this.balanceCheck(tx, input, lines, accounts as Map<string, { id: string; code: string; subtype: string }>, cur.minorUnits);
    const negativeCash = balanceWarnings.filter((w) => w.kind === 'CASH');
    const cashOverride = negativeCash.length > 0 && actor.kind === 'USER' && !input.request;

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
        correlationId: getContext()?.correlationId, negativeCashReason: cashOverride ? input.negativeCashReason!.trim() : null,
        ...(input.request ? { requestId: input.request.id, requestedByUserId: input.request.requestedByUserId, approvedByUserId: actor.userId! } : {}),
      } });
      await tx.journalLine.createMany({ data: lines.map((l, i) => ({
        organisationId: input.organisationId, companyId: input.companyId, journalId: journal.id, lineNo: i + 1, accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description ?? null,
        ...(l.original ? { originalCurrency: l.original.currency, originalDebit: money(l.original.debit), originalCredit: money(l.original.credit), rate: money(l.original.rate), exchangeRateId: l.original.rateId } : {}),
        ...(l.adjustsCurrency ? { adjustsCurrency: l.adjustsCurrency } : {}),
        ...(l.vat ? { taxCodeId: l.vat.taxCodeId, taxRateId: l.vat.taxRateId, vatRole: l.vat.role, taxPoint: toDate(l.vat.taxPoint), vatNetLineNo: l.vat.netLineNo ?? null, vatInclusive: l.vat.inclusive,
          vatRatePoint: l.vat.ratePoint ? toDate(l.vat.ratePoint) : null } : {}),
      })) });
      await tx.auditEvent.createMany({ data: [auditRow({
        action: input.sourceType === 'REVERSAL' ? 'journal.reversed' : 'journal.posted', organisationId: input.organisationId, companyId: input.companyId, actorUserId: actor.userId ?? null,
        entityType: 'journal', entityId: journal.id, reason: input.reason ?? null,
        after: { journalNumber, journalDate: input.journalDate, sourceType: input.sourceType, total: fmt(debits, cur.minorUnits), lines: lines.length },
        metadata: { periodId: period.id, reverses: input.reversesJournalId ?? null, actorKind: actor.kind, ...(balanceWarnings.length > 0 ? { balanceWarnings, ...(cashOverride ? { negativeCashReason: input.negativeCashReason!.trim() } : {}) } : {}), ...(input.request ? { requestId: input.request.id, requestedBy: input.request.requestedByUserId, approvedBy: actor.userId, selfApproved: input.request.selfApproved } : {}) },
      }, this.opts.captureDeviceMetadata)] });
      await publishEvent(tx, Events.transactionPosted, { aggregateId: journal.id, organisationId: input.organisationId, actorUserId: actor.userId ?? null,
        payload: { journalId: journal.id, companyId: input.companyId, periodId: period.id, journalNumber, journalDate: input.journalDate, sourceType: input.sourceType, sourceId: input.sourceId ?? null, total: fmt(debits, cur.minorUnits), reversesJournalId: input.reversesJournalId ?? null } });
      return { ...this.view(journal, cur.minorUnits), replayed: false, balanceWarnings };
    } finally {
      // The switch is transaction-local, so it dies with the transaction anyway. When the database refused the insert the transaction is already
      // aborted and this statement would fail too - and hide the real error - so it is best-effort.
      await tx.$queryRaw`SELECT set_config('app.posting', 'off', true)`.catch(() => undefined);
    }
  }

  /**
   * VAT (M4b; DEC-021, DEC-025): each line with a VAT code gets the VERIFIED rate version that covers the tax point; the VAT is computed per line,
   * half-up (exclusive: on the net; inclusive: the VAT fraction of the gross) and added as a visible line on the company's output or input VAT account,
   * on the same side as the net line. Reverse charge adds equal output and input VAT lines. The database re-proves every VAT line at commit.
   */
  private async withVat(tx: Tx, input: PostInput, source: (typeof JOURNAL_SOURCES)[string]): Promise<{ input: PostInput; hash?: string; replay?: PostedJournal }> {
    const coded = input.lines.some((l) => l.taxCodeId);
    if (!coded) {
      if (input.amountsIncludeVat || input.taxPoint) throw unprocessable('VAT-inclusive amounts and a tax point apply only to lines with a VAT code', 'vat_not_applicable');
      return { input };
    }
    if (!source.vatCodes || source.requiresRequest || input.reversesJournalId) throw unprocessable('VAT codes are not used on this kind of entry', 'vat_not_applicable');
    if (input.lines.some((l) => l.original)) throw unprocessable('VAT on foreign-currency journals waits for the verified rule on the currency of VAT amounts (M4b limitation)', 'vat_foreign_currency_not_supported');
    if (input.lines.some((l) => l.vat || l.generated)) throw unprocessable('VAT lines are added by the service', 'invalid_amount');
    if (input.lines.some((l) => l.vatRate && !l.taxCodeId)) throw unprocessable('A pinned VAT rate needs a VAT code', 'invalid_amount');
    if (input.lines.some((l) => l.vatRate) && !['SALES_CREDIT_NOTE', 'PURCHASE_DEBIT_NOTE'].includes(input.sourceType)) throw unprocessable('Only a credit or debit note adjusts the VAT of an earlier supply', 'vat_not_applicable');
    const company = await tx.company.findUniqueOrThrow({ where: { id: input.companyId }, select: { baseCurrency: true } });
    const minor = (await tx.currency.findUnique({ where: { code: company.baseCurrency } }))?.minorUnits ?? 2;
    const settings = await tx.companyVatSetting.findFirst({ where: { companyId: input.companyId } });
    const taxPoint = input.taxPoint ?? input.journalDate;
    if (Number.isNaN(toDate(taxPoint).getTime()) || isoDay(toDate(taxPoint)) !== taxPoint) throw unprocessable('Invalid tax point', 'invalid_date');
    if (!settings?.registered || !settings.outputAccountId || !settings.inputAccountId) throw unprocessable('The company is not VAT registered: VAT codes cannot be used', 'not_vat_registered');
    if (settings.registeredFrom && taxPoint < isoDay(settings.registeredFrom)) throw unprocessable(`The tax point ${taxPoint} is before the VAT registration date`, 'not_vat_registered');
    // idempotency on what the caller sent; a later rate change must not turn a replay into a conflict
    const hash = createHash('sha256').update(JSON.stringify({ c: input.companyId, d: input.journalDate, s: input.sourceType, i: input.sourceId ?? null, r: input.sourceReference ?? null, t: input.description.trim(),
      v: { inc: !!input.amountsIncludeVat, tp: taxPoint }, l: input.lines.map((l) => [l.accountId, l.debit || '0', l.credit || '0', l.description ?? null, l.taxCodeId ?? null, ...(l.vatRate ? [l.vatRate.taxRateId, l.vatRate.ratePoint] : [])]) })).digest('hex');
    const existing = await tx.journal.findUnique({ where: { organisationId_companyId_idempotencyKey: { organisationId: input.organisationId, companyId: input.companyId, idempotencyKey: input.idempotencyKey } } });
    if (existing) {
      if (existing.contentHash !== hash) throw conflict('This idempotency key was already used for a different journal', 'idempotency_conflict');
      return { input, hash, replay: { ...this.view(existing, minor), replayed: true } };
    }
    const out: PostLineInput[] = [];
    const inclusive = !!input.amountsIncludeVat;
    for (const [i, l] of input.lines.entries()) {
      if (!l.taxCodeId) { out.push(l); continue; }
      const code = await tx.taxCode.findFirst({ where: { id: l.taxCodeId } });
      if (!code) throw unprocessable(`Line ${i + 1}: unknown VAT code`, 'unknown_tax_code');
      const rate = l.vatRate ? await this.pinnedRate(tx, code.id, l.vatRate, taxPoint, i) : await this.vat.rateFor(tx, code.id, taxPoint);
      let debit: Money, credit: Money;
      try { debit = money(l.debit || '0'); credit = money(l.credit || '0'); } catch { throw unprocessable(`Line ${i + 1}: amounts must be decimal numbers`, 'invalid_amount'); }
      if (debit.isNegative() || credit.isNegative() || debit.isZero() === credit.isZero()) throw unprocessable(`Line ${i + 1}: exactly one of debit and credit must be greater than zero`, 'invalid_amount');
      const isDebit = debit.greaterThan(0), entered = isDebit ? debit : credit;
      if (code.reverseCharge && inclusive) throw unprocessable(`Line ${i + 1}: a reverse-charge line is entered net`, 'reverse_charge_inclusive_not_supported');
      const vatAmt = code.reverseCharge || rate.rate.isZero() ? ZERO : inclusive ? vatInGross(entered, rate.rate, minor) : vatOnNet(entered, rate.rate, minor);
      const net = inclusive ? entered.minus(vatAmt) : entered;
      if (!net.greaterThan(0)) throw unprocessable(`Line ${i + 1}: the net amount must be greater than zero`, 'invalid_amount');
      const side = (amt: Money) => (isDebit ? { debit: fmt(amt, minor), credit: '0' } : { debit: '0', credit: fmt(amt, minor) });
      const facts = { taxCodeId: code.id, taxRateId: rate.id, taxPoint, inclusive, ...(l.vatRate ? { ratePoint: l.vatRate.ratePoint } : {}) };
      const netLineNo = out.length + 1;
      out.push({ accountId: l.accountId, description: l.description, ...side(net), vat: { ...facts, role: 'NET' } });
      // a document journal knows its direction (a sales credit note is still sales; a purchase debit note still purchases); otherwise a BOTH code follows the side
      const fixed = sourceVatSide(input.sourceType);
      const salesSide = fixed ? fixed === 'SALES' : code.direction === 'SALES' || (code.direction === 'BOTH' && !isDebit);
      if (vatAmt.greaterThan(0)) {
        out.push({ accountId: salesSide ? settings.outputAccountId : settings.inputAccountId, description: `VAT ${code.code} on line ${i + 1}`, ...side(vatAmt), generated: true, vat: { ...facts, role: 'VAT', netLineNo } });
      }
      if (code.reverseCharge && rate.rate.greaterThan(0)) {
        const rc = vatOnNet(net, rate.rate, minor);
        if (rc.greaterThan(0)) {
          // the pair follows the net line: a purchase (debit) accounts output VAT as a credit and input VAT as a debit; a credit (a debit note) mirrors both
          const rcAmt = fmt(rc, minor);
          out.push({ accountId: settings.outputAccountId, description: `Reverse charge output VAT ${code.code} on line ${i + 1}`, debit: isDebit ? '0' : rcAmt, credit: isDebit ? rcAmt : '0', generated: true, vat: { ...facts, inclusive: false, role: 'RC_OUTPUT', netLineNo } });
          out.push({ accountId: settings.inputAccountId, description: `Reverse charge input VAT ${code.code} on line ${i + 1}`, debit: isDebit ? rcAmt : '0', credit: isDebit ? '0' : rcAmt, generated: true, vat: { ...facts, inclusive: false, role: 'RC_INPUT', netLineNo } });
        }
      }
    }
    return { input: { ...input, amountsIncludeVat: false, taxPoint: undefined, lines: out }, hash };
  }

  /** DEC-029: a credit note uses the verified version its invoice used, which must cover the invoice's tax point (it may since have been superseded). */
  private async pinnedRate(tx: Tx, taxCodeId: string, pin: { taxRateId: string; ratePoint: string }, taxPoint: string, i: number) {
    const r = await tx.taxRate.findFirst({ where: { id: pin.taxRateId } });
    if (!r || r.taxCodeId !== taxCodeId) throw unprocessable(`Line ${i + 1}: the VAT rate of the adjusted supply belongs to another VAT code`, 'tax_rate_mismatch');
    if (r.verificationStatus !== 'VERIFIED') throw unprocessable(`Line ${i + 1}: the VAT rate of the adjusted supply is not verified`, 'tax_rate_unverified');
    if (pin.ratePoint > taxPoint) throw unprocessable(`Line ${i + 1}: an adjustment cannot precede the supply it adjusts`, 'invalid_date');
    if (pin.ratePoint < isoDay(r.effectiveFrom) || (r.effectiveTo && pin.ratePoint > isoDay(r.effectiveTo))) throw unprocessable(`Line ${i + 1}: the VAT rate was not in force at the adjusted supply's tax point`, 'tax_rate_not_effective');
    return { id: r.id, rate: r.rate };
  }

  private async prepareAmounts(tx: Tx, input: PostInput) {
    const company = await tx.company.findUnique({ where: { id: input.companyId }, select: { id: true, baseCurrency: true } });
    if (!company) throw notFound('Company not found');
    if (input.currency && input.currency !== company.baseCurrency) {
      throw unprocessable(`This kind of entry is posted in the company's currency, ${company.baseCurrency}`, 'foreign_currency_not_supported', { companyCurrency: company.baseCurrency, requested: input.currency });
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
      return { accountId: l.accountId, debit, credit, description: l.description, original: l.original, adjustsCurrency: l.adjustsCurrency, generated: l.generated, vat: l.vat };
    });

    return { company, cur, date, lines };
  }

  private async prepareLedger(tx: Tx, input: PostInput, source: (typeof JOURNAL_SOURCES)[string], base: { company: { baseCurrency: string }; cur: { minorUnits: number }; date: Date; lines: { accountId: string; debit: Money; credit: Money; original?: PostLineOriginal; generated?: boolean }[] }) {
    const { cur, date, lines } = base;
    // 5a. every posting takes the company's year-close lock shared, before any other lock; a year-end close takes it exclusively (V2-M3b, DEC-060),
    // so a posting either commits before the close reads the year's balances or sees the close and is refused at 7c
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${'yearclose:' + input.companyId}, 0))`;
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
    // the service's own lines (FX rounding, VAT) may sit on control accounts; everything a person typed may not
    const typed = new Set(lines.filter((l) => !l.generated).map((l) => l.accountId));
    for (const id of ids) {
      const a = accounts.get(id);
      if (!a) throw unprocessable('A line refers to an account that does not exist in this company', 'unknown_account');
      if ((a.activeFrom && date < a.activeFrom) || (a.activeTo && date > a.activeTo)) throw unprocessable(`Account ${a.code} is not active on ${input.journalDate}`, 'account_inactive');
      if (a.isControl && !source.controlAccounts && typed.has(id)) throw unprocessable(`Account ${a.code} is a control account; ${input.sourceType} journals cannot post to it (it is maintained by its sub-ledger)`, 'control_account_restricted');
      if (a.isControl && source.controlKinds && typed.has(id) && !source.controlKinds.includes(a.controlKind as never)) throw unprocessable(`Account ${a.code} is a ${a.controlKind ?? 'control'} account; ${input.sourceType} journals reach only ${source.controlKinds.join(', ')}`, 'control_account_restricted');
    }

    // 7c. a closed financial year takes no income or expense until its closing journal is reversed (DEC-060; the database refuses it again)
    if (!(CLOSING_SOURCES as readonly string[]).includes(input.sourceType) && found.some((a) => a.type === 'INCOME' || a.type === 'EXPENSE')) {
      const closed = await tx.yearEndClose.findFirst({ where: { companyId: input.companyId, status: 'POSTED', yearStart: { lte: date }, yearEnd: { gte: date } }, select: { yearStart: true, yearEnd: true } });
      if (closed) throw unprocessable(`The financial year ${isoDay(closed.yearStart)} to ${isoDay(closed.yearEnd)} is closed: income and expense cannot be posted into it until its closing journal is reversed`, 'year_closed');
    }

    // 7b. opening balances are the one source allowed onto control accounts, so they are fenced: dated at the very start of record keeping
    if (input.sourceType === 'OPENING_BALANCE') {
      const first = await tx.accountingPeriod.findFirst({ where: { companyId: input.companyId }, orderBy: { startDate: 'asc' }, select: { startDate: true } });
      if (!first || isoDay(first.startDate) !== input.journalDate) throw unprocessable(`Opening balances must be dated ${first ? isoDay(first.startDate) : 'the first day of the first accounting period'}`, 'opening_balance_date_invalid');
    }

    // 7a. the accounts designated for FX rounding and realised/unrealised FX belong to the system sources (revaluation, settlement), not to manual entries
    if (input.sourceType === 'MANUAL') {
      const fx = await tx.companyFxSetting.findFirst({ where: { companyId: input.companyId }, select: { roundingAccountId: true, realisedAccountId: true, unrealisedAccountId: true } });
      const reserved = new Set([fx?.roundingAccountId, fx?.realisedAccountId, fx?.unrealisedAccountId].filter(Boolean));
      // the visible FX-rounding line the service itself adds is the one legitimate use; everything a person typed is checked
      const hit = [...new Set(lines.filter((l) => !l.generated).map((l) => l.accountId))].find((id) => reserved.has(id));
      if (hit) throw unprocessable(`Account ${accounts.get(hit)!.code} is reserved for foreign-exchange postings; manual journals cannot use it`, 'system_account_restricted');
    }

    // 7c. a control adjustment exists to move a control account; anything else is a plain manual journal
    if (input.sourceType === 'CONTROL_ADJUSTMENT' && !ids.some((id) => accounts.get(id)!.isControl)) throw unprocessable('A control adjustment must touch at least one control account; use a manual journal otherwise', 'no_control_account');

    // 8. balance
    const debits = lines.reduce((s, l) => s.plus(l.debit), ZERO);
    const credits = lines.reduce((s, l) => s.plus(l.credit), ZERO);
    if (!debits.equals(credits)) throw unprocessable(`Debits (${fmt(debits, cur.minorUnits)}) must equal credits (${fmt(credits, cur.minorUnits)})`, 'unbalanced_journal');
    if (debits.isZero()) throw unprocessable('A journal cannot be zero', 'invalid_amount');

    return { period, accounts, debits };
  }

  /**
   * DEC-036/037. For every bank or cash account the journal lowers, the lowest balance on the journal date or any later date once this journal is
   * included (a back-dated payment can overdraw a later day). Cash in hand below zero is refused for a person unless a reason is given (an approved
   * journal request is its own authority; a system posting only warns); a bank account below zero is a warning (overdrafts exist).
   */
  private async balanceCheck(tx: Tx, input: PostInput, lines: { accountId: string; debit: Money; credit: Money; adjustsCurrency?: string }[], accounts: Map<string, { id: string; code: string; subtype: string }>, minor: number): Promise<BalanceWarning[]> {
    const delta = new Map<string, Money>();
    // a functional-only revaluation adjustment (and its reversal) revalues a balance; it moves no money, so it is never the posting that is refused
    for (const l of lines) if (!l.adjustsCurrency) delta.set(l.accountId, (delta.get(l.accountId) ?? ZERO).plus(l.debit).minus(l.credit));
    const out: BalanceWarning[] = [];
    for (const [id, d] of [...delta.entries()].sort(([x], [y]) => (x < y ? -1 : 1))) {
      const a = accounts.get(id)!;
      const kind = a.subtype === 'CURRENT_ASSET_CASH' ? 'CASH' : a.subtype === 'CURRENT_ASSET_BANK' ? 'BANK' : null;
      if (!kind || !d.isNegative()) continue;
      // the same per-account lock the commit-time check takes; postings of one company are already serialised by the journal number
      if (kind === 'CASH') await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'cash:' + id}, 0))`;
      const [r] = await tx.$queryRaw<{ opening: string | null; low_d: Date | null; low_bal: string | null }[]>`
        WITH mv AS (SELECT j.journal_date AS d, sum(l.debit - l.credit) AS amt FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
                     WHERE l.company_id = ${input.companyId}::uuid AND l.account_id = ${id}::uuid GROUP BY j.journal_date),
             run AS (SELECT d, sum(amt) OVER (ORDER BY d) AS bal FROM mv)
        SELECT (SELECT bal FROM run WHERE d <= ${input.journalDate}::date ORDER BY d DESC LIMIT 1)::text AS opening,
               (SELECT d FROM run WHERE d > ${input.journalDate}::date ORDER BY bal, d LIMIT 1) AS low_d,
               (SELECT min(bal) FROM run WHERE d > ${input.journalDate}::date)::text AS low_bal`;
      let low = money(r?.opening ?? '0').plus(d), on = input.journalDate;
      if (r?.low_bal !== null && r?.low_bal !== undefined && money(r.low_bal).plus(d).lessThan(low)) { low = money(r.low_bal).plus(d); on = isoDay(r.low_d!); }
      if (!low.isNegative()) continue;
      const overridden = kind === 'CASH' && input.actor.kind === 'USER' && !input.request;
      if (overridden && !input.negativeCashReason?.trim()) {
        throw unprocessable(`This takes cash account ${a.code} below zero (${fmt(low, minor)} on ${on}). Cash in hand cannot be negative: check for a missing receipt, or give a negativeCashReason if it is genuine`, 'negative_cash',
          { accountId: id, accountCode: a.code, lowestBalance: fmt(low, minor), onDate: on });
      }
      out.push({ accountId: id, accountCode: a.code, kind, lowestBalance: fmt(low, minor), onDate: on, overridden });
    }
    return out;
  }

  /**
   * Corrections are reversals (manifest control 3): a mirror journal in an OPEN period, dated on or after the original, linked both
   * ways, at most once per original; a reversal cannot itself be reversed (post a new journal instead).
   */
  async reverse(tx: Tx, a: { organisationId: string; companyId: string; journalId: string; journalDate?: string; reason: string; actor: PostingActor; negativeCashReason?: string }): Promise<PostedJournal> {
    const original = await tx.journal.findFirst({ where: { id: a.journalId, companyId: a.companyId }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    if (!original) throw notFound('Journal not found');
    if (original.sourceType === 'REVERSAL') throw unprocessable('A reversal cannot be reversed; post a new journal instead', 'cannot_reverse_reversal');
    if (JOURNAL_SOURCES[original.sourceType]?.subLedger) throw unprocessable(`A ${original.sourceType} journal belongs to its source document and is corrected there (for a sales invoice: a credit note), not reversed in the ledger`, 'subledger_journal');
    const already = await tx.journal.findFirst({ where: { reversesJournalId: original.id }, select: { id: true, journalNumber: true } });
    if (already) throw conflict(`Journal ${original.journalNumber} was already reversed by journal ${already.journalNumber}`, 'already_reversed');
    const date = a.journalDate ?? new Date().toISOString().slice(0, 10);
    if (date < isoDay(original.journalDate)) throw unprocessable('A reversal cannot be dated before the journal it reverses', 'reversal_before_original');
    return this.post(tx, {
      organisationId: a.organisationId, companyId: a.companyId, journalDate: date, sourceType: 'REVERSAL', sourceId: original.id, sourceReference: `J-${original.journalNumber}`,
      description: `Reversal of journal ${original.journalNumber}: ${original.description}`.slice(0, 500),
      lines: original.lines.map((l) => ({ accountId: l.accountId, debit: l.credit.toFixed(4), credit: l.debit.toFixed(4), description: l.description ?? undefined,
        ...(l.originalCurrency ? { original: { currency: l.originalCurrency, debit: l.originalCredit!.toFixed(4), credit: l.originalDebit!.toFixed(4), rate: l.rate!.toFixed(8), rateId: l.exchangeRateId! } } : {}),
        ...(l.adjustsCurrency ? { adjustsCurrency: l.adjustsCurrency } : {}),
        ...(l.taxRateId ? { vat: { taxCodeId: l.taxCodeId!, taxRateId: l.taxRateId, role: l.vatRole as PostLineVat['role'], taxPoint: isoDay(l.taxPoint!), netLineNo: l.vatNetLineNo ?? undefined, inclusive: !!l.vatInclusive,
          ...(l.vatRatePoint ? { ratePoint: isoDay(l.vatRatePoint) } : {}) } } : {}) })),
      idempotencyKey: `reversal:${original.id}`, actor: a.actor, reversesJournalId: original.id, reason: a.reason, negativeCashReason: a.negativeCashReason,
    });
  }

  private view(j: { id: string; journalNumber: number; journalDate: Date; periodId: string; companyId: string; sourceType: string; sourceId: string | null; total: Money; lineCount: number; reversesJournalId: string | null }, minor: number): Omit<PostedJournal, 'replayed'> {
    return { id: j.id, journalNumber: j.journalNumber, journalDate: isoDay(j.journalDate), periodId: j.periodId, companyId: j.companyId, sourceType: j.sourceType, sourceId: j.sourceId, total: fmt(j.total, minor), lineCount: j.lineCount, reversesJournalId: j.reversesJournalId };
  }
}
