import { MONETARY_SUBTYPES } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable, uuidv7 } from '@uk/core';
import type { Prisma, Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import { convert, type RateActor, type RateService, type ResolvedRate } from './fx';
import { ZERO, fmt, money } from './money';
import type { PostLineInput, PostingActor, PostingService } from './posting';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => isoDay(new Date(new Date(`${s}T00:00:00.000Z`).getTime() + n * 86_400_000));
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

// ───────────── Revaluation (DEC-018) ─────────────
export interface RevalItem { accountId: string; accountCode: string; accountName: string; currency: string; originalBalance: string; carryingBalance: string; rate: string; rateId: string; targetBalance: string; adjustment: string }
export interface RevalPreview { companyId: string; periodId: string; asAt: string; functionalCurrency: string; minorUnits: number; items: RevalItem[]; netAdjustment: string; unrealisedAccountId: string | null; missingRates: { currency: string; message: string }[] }

export class RevaluationService {
  constructor(private readonly rates: RateService, private readonly posting: PostingService, private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }

  /** Compares, per monetary account and foreign currency, the functional carrying amount with `original balance x closing rate`. Writes nothing. */
  async preview(tx: Tx, a: { organisationId: string; companyId: string; periodId: string; actor: RateActor; rates: Record<string, string>; lockPeriod?: boolean }): Promise<RevalPreview> {
    if (a.lockPeriod) await tx.$queryRaw`SELECT id FROM accounting_period WHERE id = ${a.periodId}::uuid FOR UPDATE`;
    const period = await tx.accountingPeriod.findFirst({ where: { id: a.periodId, companyId: a.companyId } });
    if (!period) throw notFound('Accounting period not found');
    const company = await tx.company.findUniqueOrThrow({ where: { id: a.companyId }, select: { baseCurrency: true } });
    const cur = await tx.currency.findUniqueOrThrow({ where: { code: company.baseCurrency } });
    const asAt = isoDay(period.endDate);
    const subtypes = [...MONETARY_SUBTYPES];
    const rows = await tx.$queryRaw<{ account_id: string; code: string; name: string; ccy: string; orig: string; carrying: string }[]>`
      SELECT l.account_id, a.code, a.name, coalesce(l.original_currency, l.adjusts_currency) AS ccy,
             coalesce(sum(l.original_debit - l.original_credit) FILTER (WHERE l.original_currency IS NOT NULL), 0)::text AS orig,
             sum(l.debit - l.credit)::text AS carrying
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id JOIN account a ON a.id = l.account_id AND a.organisation_id = l.organisation_id
       WHERE l.company_id = ${a.companyId}::uuid AND j.journal_date <= ${period.endDate}::date AND coalesce(l.original_currency, l.adjusts_currency) IS NOT NULL AND a.subtype = ANY(${subtypes}::text[])
       GROUP BY l.account_id, a.code, a.name, coalesce(l.original_currency, l.adjusts_currency)
       ORDER BY a.code, 4`;
    const settings = await tx.companyFxSetting.findFirst({ where: { companyId: a.companyId } });
    const resolved = new Map<string, ResolvedRate>(); const missing: { currency: string; message: string }[] = [];
    for (const ccy of [...new Set(rows.map((r) => r.ccy))].sort()) {
      try {
        resolved.set(ccy, await this.rates.resolveForPosting(tx, { organisationId: a.organisationId, companyId: a.companyId, actor: a.actor, from: ccy, to: company.baseCurrency, date: asAt, rateId: a.rates[ccy] }));
      } catch (e) { missing.push({ currency: ccy, message: (e as Error).message }); }
    }
    const items: RevalItem[] = []; let net = ZERO;
    for (const r of rows) {
      const rate = resolved.get(r.ccy); if (!rate) continue;
      const orig = money(r.orig), carrying = money(r.carrying);
      const target = convert(orig, rate.rate, cur.minorUnits), adjustment = target.minus(carrying);
      if (adjustment.isZero()) continue;
      net = net.plus(adjustment);
      items.push({ accountId: r.account_id, accountCode: r.code, accountName: r.name, currency: r.ccy, originalBalance: orig.toFixed(4), carryingBalance: fmt(carrying, cur.minorUnits), rate: rate.rate.toFixed(8), rateId: rate.id, targetBalance: fmt(target, cur.minorUnits), adjustment: fmt(adjustment, cur.minorUnits) });
    }
    return { companyId: a.companyId, periodId: a.periodId, asAt, functionalCurrency: company.baseCurrency, minorUnits: cur.minorUnits, items, netAdjustment: fmt(net, cur.minorUnits), unrealisedAccountId: settings?.unrealisedAccountId ?? null, missingRates: missing };
  }

  /**
   * Posts the revaluation as one journal (source FX_REVALUATION, period:manage) and records the run. Running it again with nothing new posted finds no
   * difference and does nothing, so it is idempotent per period; new activity later in the period gets its own delta journal. The auto-reversal is
   * dated the day after the period end: posted at once when that day falls in an OPEN period, otherwise it stays due (the period cannot be closed
   * past it until it is posted - see `dueReversals`).
   */
  async post(tx: Tx, a: { organisationId: string; companyId: string; periodId: string; actor: PostingActor & RateActor; rates: Record<string, string> }) {
    if (a.actor.kind === 'AI') throw forbidden('AI cannot post accounting entries; a person must post or approve them', 'ai_cannot_post');
    if (!(await a.actor.can('period:manage', a.companyId))) throw forbidden('Requires permission period:manage', 'permission_denied');
    const preview = await this.preview(tx, { ...a, lockPeriod: true });
    if (preview.missingRates.length > 0) throw unprocessable(`No closing rate for ${preview.missingRates.map((m) => m.currency).join(', ')}: ${preview.missingRates[0]!.message}`, 'exchange_rate_not_found', { missing: preview.missingRates });
    if (preview.items.length === 0) return { status: 'NOTHING_TO_DO' as const, preview, run: null, journalId: null, reversalJournalId: null };
    if (!preview.unrealisedAccountId) throw unprocessable('Designate the unrealised FX account in the FX settings before revaluing', 'fx_unrealised_account_missing');
    const runId = uuidv7();
    const lines: PostLineInput[] = preview.items.map((it) => {
      const adj = money(it.adjustment);
      return { accountId: it.accountId, debit: adj.isPositive() ? it.adjustment : '0', credit: adj.isPositive() ? '0' : adj.abs().toFixed(preview.minorUnits), adjustsCurrency: it.currency, description: `Revaluation of ${it.currency} balance at ${it.rate}` };
    });
    const net = money(preview.netAdjustment);
    if (!net.isZero()) {
      lines.push({ accountId: preview.unrealisedAccountId, debit: net.isNegative() ? net.abs().toFixed(preview.minorUnits) : '0', credit: net.isNegative() ? '0' : net.toFixed(preview.minorUnits), description: 'Unrealised foreign exchange difference' });
    }
    const posted = await this.posting.post(tx, { organisationId: a.organisationId, companyId: a.companyId, journalDate: preview.asAt, sourceType: 'FX_REVALUATION', sourceId: runId, sourceReference: `FXREVAL-${preview.asAt}`,
      description: `Foreign currency revaluation at ${preview.asAt}`, lines, idempotencyKey: `fxreval:${runId}`, actor: a.actor, reason: 'Period-end revaluation of foreign-currency monetary items' });
    const due = addDays(preview.asAt, 1);
    const rateInfo = Object.fromEntries(preview.items.map((it) => [it.currency, { rateId: it.rateId, rate: it.rate }]));
    await tx.fxRevaluationRun.create({ data: { id: runId, organisationId: a.organisationId, companyId: a.companyId, periodId: a.periodId, asAtDate: toDate(preview.asAt), status: 'POSTED', revaluationJournalId: posted.id,
      reversalDueDate: toDate(due), netAdjustment: net, rates: rateInfo, runByUserId: a.actor.userId } });
    await this.audit(tx, { action: 'fx.revaluation_posted', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'fx_revaluation_run', entityId: runId,
      after: { asAt: preview.asAt, journalId: posted.id, items: preview.items.length, netAdjustment: preview.netAdjustment, reversalDue: due }, metadata: { rates: rateInfo } });
    const reversed = await this.tryReverse(tx, { organisationId: a.organisationId, companyId: a.companyId, runId, actor: a.actor });
    const run = await tx.fxRevaluationRun.findUniqueOrThrow({ where: { id: runId } });
    return { status: 'POSTED' as const, preview, run: runView(run), journalId: posted.id, reversalJournalId: reversed?.id ?? null };
  }

  /** Posts the auto-reversal when its day is in an OPEN period; returns null (and leaves the run due) otherwise. */
  private async tryReverse(tx: Tx, a: { organisationId: string; companyId: string; runId: string; actor: PostingActor }) {
    const run = await tx.fxRevaluationRun.findFirst({ where: { id: a.runId, companyId: a.companyId } });
    if (!run || run.status !== 'POSTED') return null;
    const period = await tx.accountingPeriod.findFirst({ where: { companyId: a.companyId, startDate: { lte: run.reversalDueDate }, endDate: { gte: run.reversalDueDate } } });
    if (!period || period.status !== 'OPEN') return null;
    const rev = await this.posting.reverse(tx, { organisationId: a.organisationId, companyId: a.companyId, journalId: run.revaluationJournalId, journalDate: isoDay(run.reversalDueDate), reason: 'Automatic reversal of the period-end FX revaluation', actor: a.actor });
    await tx.fxRevaluationRun.update({ where: { id: run.id }, data: { status: 'REVERSED', reversalJournalId: rev.id, reversedAt: new Date() } });
    await this.audit(tx, { action: 'fx.revaluation_reversed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId ?? null, entityType: 'fx_revaluation_run', entityId: run.id,
      before: { status: 'POSTED' }, after: { status: 'REVERSED', reversalJournalId: rev.id }, metadata: { reversalDate: isoDay(run.reversalDueDate) } });
    return rev;
  }

  /** Posts a due auto-reversal on request, once the next period exists and is open. */
  async reverseDue(tx: Tx, a: { organisationId: string; companyId: string; runId: string; actor: PostingActor }) {
    const run = await tx.fxRevaluationRun.findFirst({ where: { id: a.runId, companyId: a.companyId } });
    if (!run) throw notFound('Revaluation run not found');
    if (run.status !== 'POSTED') throw conflict('This revaluation was already reversed', 'already_reversed');
    if (a.actor.kind !== 'USER') throw forbidden('Only a person can post the reversal', 'actor_invalid');
    const rev = await this.tryReverse(tx, a);
    if (!rev) throw unprocessable(`The reversal is dated ${isoDay(run.reversalDueDate)}; it can be posted once an OPEN accounting period covers that date`, 'no_open_period_for_reversal');
    return runView(await tx.fxRevaluationRun.findUniqueOrThrow({ where: { id: run.id } }));
  }

  /** Close control (DEC-018): does the period still carry foreign-currency monetary balances that are not at the closing rate, or without a rate to check them? */
  async isUnrevalued(tx: Tx, a: { organisationId: string; companyId: string; periodId: string; actor: RateActor }): Promise<boolean> {
    const p = await this.preview(tx, { ...a, rates: {} });
    return p.items.length > 0 || p.missingRates.length > 0;
  }

  /** Auto-reversals still to post whose date falls in or before the period (blocks closing a period that would skip them). */
  async dueReversals(tx: Tx, companyId: string, upTo: Date) {
    return tx.fxRevaluationRun.findMany({ where: { companyId, status: 'POSTED', reversalDueDate: { lte: upTo } }, orderBy: { createdAt: 'asc' } });
  }

  async listRuns(tx: Tx, companyId: string, q: { limit: number; cursor?: string; periodId?: string }) {
    const rows = await tx.fxRevaluationRun.findMany({ where: { companyId, ...(q.periodId ? { periodId: q.periodId } : {}), ...(q.cursor ? { id: { lt: q.cursor } } : {}) }, orderBy: { id: 'desc' }, take: q.limit + 1 });
    const page = rows.slice(0, q.limit);
    return { items: page.map(runView), nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null };
  }
}

export const runView = (r: { id: string; companyId: string; periodId: string; asAtDate: Date; status: string; revaluationJournalId: string; reversalJournalId: string | null; reversalDueDate: Date; netAdjustment: Prisma.Decimal; runByUserId: string; createdAt: Date; reversedAt: Date | null }) => ({
  id: r.id, companyId: r.companyId, periodId: r.periodId, asAt: isoDay(r.asAtDate), status: r.status, revaluationJournalId: r.revaluationJournalId, reversalJournalId: r.reversalJournalId,
  reversalDueDate: isoDay(r.reversalDueDate), netAdjustment: r.netAdjustment.toFixed(4), runByUserId: r.runByUserId, createdAt: r.createdAt, reversedAt: r.reversedAt,
});
