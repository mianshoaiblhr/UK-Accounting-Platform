import { PERIOD_TRANSITIONS, Events, type PeriodAction } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable } from '@uk/core';
import type { Tx } from '@uk/db';
import { auditRow, publishEvent } from '@uk/platform';
import type { RevaluationService } from './revaluation';

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const AUDIT_ACTION: Record<PeriodAction, string> = { close: 'period.closed', reopen: 'period.reopened', lock: 'period.locked', unlock: 'period.unlocked' };

export const periodView = (p: { id: string; companyId: string; startDate: Date; endDate: Date; status: string; statusChangedAt: Date | null; statusChangedByUserId: string | null; statusReason: string | null }) => ({
  id: p.id, companyId: p.companyId, startDate: isoDay(p.startDate), endDate: isoDay(p.endDate), status: p.status, statusChangedAt: p.statusChangedAt, statusChangedByUserId: p.statusChangedByUserId, statusReason: p.statusReason,
});

/**
 * Period states and close controls (ADR-47): OPEN <-> CLOSED -> LOCKED -> CLOSED. The database also enforces the transition graph and that a
 * signed-in user performs it. The change is a conditional update (a concurrent change loses), audited with before/after and reason, and published.
 */
export class PeriodService {
  constructor(private readonly opts: { captureDeviceMetadata?: boolean; fx?: RevaluationService } = {}) {}

  async transition(tx: Tx, a: { organisationId: string; companyId: string; periodId: string; action: PeriodAction; reason?: string; userId: string; acknowledgeUnrevaluedFx?: boolean; acknowledgeDraftDocuments?: boolean; can: (permission: string) => boolean | Promise<boolean> }) {
    const rule = PERIOD_TRANSITIONS[a.action];
    if (!(await a.can(rule.permission))) throw forbidden(`Requires permission ${rule.permission}`, 'permission_denied');
    const p = await tx.accountingPeriod.findFirst({ where: { id: a.periodId, companyId: a.companyId } });
    if (!p) throw notFound('Accounting period not found');
    if (p.status !== rule.from) throw conflict(`Cannot ${a.action} a period that is ${p.status.toLowerCase()} (it must be ${rule.from.toLowerCase()})`, 'invalid_period_state');
    if (rule.reasonRequired && !a.reason?.trim()) throw unprocessable(`A reason is required to ${a.action} a period`, 'reason_required');
    let drafts = 0;
    if (a.action === 'close') {
      await this.assertBalanced(tx, a.companyId, p.endDate);
      await this.assertFxControls(tx, a, p);
      const inPeriod = { companyId: a.companyId, status: 'DRAFT', issueDate: { gte: p.startDate, lte: p.endDate } };
      drafts = await tx.salesDocument.count({ where: inPeriod }) + await tx.purchaseDocument.count({ where: inPeriod });
      // close control (MAN-ACC-08, M5a/M6a): unposted sales and purchase documents dated in the period block the close unless acknowledged
      if (drafts > 0 && !a.acknowledgeDraftDocuments) throw conflict(`${drafts} draft sales or purchase document(s) are dated in this period and not approved. Approve or discard them, or close with acknowledgeDraftDocuments = true`, 'unposted_documents', { drafts });
    }
    const upd = await tx.accountingPeriod.updateMany({ where: { id: p.id, status: rule.from }, data: { status: rule.to, statusChangedAt: new Date(), statusChangedByUserId: a.userId, statusReason: a.reason?.trim() ?? null } });
    if (upd.count !== 1) throw conflict('The period changed concurrently', 'invalid_period_state');
    await tx.auditEvent.createMany({ data: [auditRow({ action: AUDIT_ACTION[a.action], organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.userId, entityType: 'accounting_period', entityId: p.id,
      before: { status: p.status }, after: { status: rule.to }, reason: a.reason, metadata: { startDate: isoDay(p.startDate), endDate: isoDay(p.endDate), ...(drafts > 0 ? { acknowledgedDraftDocuments: drafts } : {}) } }, this.opts.captureDeviceMetadata)] });
    await publishEvent(tx, Events.accountingPeriodStateChanged, { aggregateId: p.id, organisationId: a.organisationId, actorUserId: a.userId, payload: { periodId: p.id, companyId: a.companyId, from: rule.from, to: rule.to, action: a.action } });
    return periodView(await tx.accountingPeriod.findUniqueOrThrow({ where: { id: p.id } }));
  }

  /** Close controls (M3, DEC-018): an auto-reversal that is due may not be skipped, and foreign-currency monetary balances not at the closing rate need an explicit acknowledgement. */
  private async assertFxControls(tx: Tx, a: { organisationId: string; companyId: string; userId: string; acknowledgeUnrevaluedFx?: boolean; can: (permission: string) => boolean | Promise<boolean> }, p: { id: string; endDate: Date }) {
    const fx = this.opts.fx;
    if (!fx) return;
    const due = await fx.dueReversals(tx, a.companyId, p.endDate);
    if (due.length > 0) throw conflict(`A foreign-currency revaluation reversal dated ${isoDay(due[0]!.reversalDueDate)} is still to be posted; post it before closing this period (revaluation run ${due[0]!.id})`, 'fx_reversal_pending');
    if (!a.acknowledgeUnrevaluedFx && (await fx.isUnrevalued(tx, { organisationId: a.organisationId, companyId: a.companyId, periodId: p.id, actor: { userId: a.userId, can: (perm) => a.can(perm) } }))) {
      throw conflict('Foreign-currency monetary balances are not revalued at the closing rate (or have no rate). Run the revaluation, or close with acknowledgeUnrevaluedFx = true', 'fx_unrevalued_balances');
    }
  }

  /** Close control (M1): the ledger up to the period end balances. By construction it always does; asserting it makes a violated invariant loud, not silent. */
  private async assertBalanced(tx: Tx, companyId: string, endDate: Date) {
    const r = await tx.$queryRaw<{ d: string | null; c: string | null }[]>`
      SELECT sum(l.debit)::text AS d, sum(l.credit)::text AS c FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND j.journal_date <= ${endDate}::date`;
    if ((r[0]?.d ?? '0') !== (r[0]?.c ?? '0') && Number(r[0]?.d ?? 0) !== Number(r[0]?.c ?? 0)) throw unprocessable('The ledger does not balance; the period cannot be closed', 'ledger_unbalanced');
  }
}
