import { YEAR_END_OWN_RECORD_STEPS, YEAR_END_STEPS, YEAR_END_STEP_DEPENDS, packageProblems, yearEndStepStates, type StepControl, type StepState } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable } from '@uk/core';
import type { Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import { accountsFingerprint, assertYearOpen, type AccountsDocumentService } from './accounts-document';
import type { FixedAssetService } from './fixed-assets';
import { money, type Money } from './money';
import type { PostingActor } from './posting';
import type { ReviewService } from './review';
import type { SizeTestService } from './size-test';
import type { VatService } from './vat';
import type { YearEndService } from './year-end';

/**
 * V2-M6b (DEC-069; v2-plan section 5i): the 14-step year-end workflow of a framework year. Each step reads its status from an existing control
 * (nothing is recomputed here); a preparer signs a step off when its control is ready and the steps it depends on are done; a sign-off lapses
 * when its control stops being ready. What is stored is each sign-off and reopen, written once with the control at the time. Steps 12 to 14
 * (V2-M6c, DEC-070) are done through their own records - the partner review, the client approval and the package - read here, never written.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const addDays = (s: string, n: number) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
type Ctx = { organisationId: string; companyId: string; actor: PostingActor };
export interface Control { status: StepControl | null; summary: string; details: Record<string, unknown> }
/** A partner review or client approval as the workflow reads it (DEC-070). */
export interface ApprovalRecord { id: string; stage: string; fingerprint: string; note: string | null; directorContactId: string | null; approvedOn: Date | null; evidenceDocumentId: string | null; byUserId: string; at: Date }
/** The workflow's state with what steps 11 to 14 read, for the approval service (DEC-070). */
export interface WorkflowState {
  fw: { id: string; yearStart: Date; yearEnd: Date; versionId: string; entitySize: string; lockedAt: Date | null };
  controls: Record<number, Control>;
  rows: { step: number; action: string; byUserId: string }[];
  state: Record<number, StepState>;
  read: {
    fingerprint: string | null; reviews: ApprovalRecord[]; approval: ApprovalRecord | null; pkg: { id: string; fingerprint: string } | null;
    doc: { complete: boolean; verified: boolean; companyName: string; companyNumber: string | null; currency: string; standard: unknown; [k: string]: unknown };
    size: { verified: boolean; fits: boolean | null; notices: string[]; [k: string]: unknown };
  };
}
const READY = (summary: string, details: Record<string, unknown> = {}): Control => ({ status: 'READY', summary, details });
const ATTENTION = (summary: string, details: Record<string, unknown> = {}): Control => ({ status: 'ATTENTION', summary, details });

/** The part of the VAT workpaper's reconciliation difference its listed explanations do not account for. */
export function unexplainedVatDifference(r: { difference: string; explainedBy: { amount: string; reason: string }[] }): Money {
  // non-VAT postings and tax points outside the period sit in the account movement; VAT lines whose journal is dated outside sit in the lines
  return r.explainedBy.reduce((t, e) => (e.reason.startsWith('Tax point in the period') ? t.plus(e.amount) : t.minus(e.amount)), money(r.difference));
}

export class YearEndWorkflowService {
  constructor(private readonly review: ReviewService, private readonly assets: FixedAssetService, private readonly yearEnd: YearEndService, private readonly vat: VatService,
    private readonly document: AccountsDocumentService, private readonly sizes: SizeTestService, private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }

  /** The control of every step, with what steps 12 to 14 are read from: the accounts, their fingerprint and the approval records (DEC-070). */
  private async controls(tx: Tx, companyId: string, fw: { id: string; yearStart: Date; yearEnd: Date }) {
    const start = isoDay(fw.yearStart), end = isoDay(fw.yearEnd);
    const c: Record<number, Control> = {};
    // 1: the periods cover the year; nothing waits in draft or for approval inside it
    const periods = await tx.accountingPeriod.findMany({ where: { companyId, startDate: { lte: fw.yearEnd }, endDate: { gte: fw.yearStart } }, orderBy: { startDate: 'asc' } });
    let covered = start, gap = periods.length === 0;
    for (const p of periods) { if (isoDay(p.startDate) > covered) gap = true; const after = addDays(isoDay(p.endDate), 1); if (after > covered) covered = after; }
    if (covered <= end) gap = true;
    const inYear = { companyId, status: 'DRAFT', issueDate: { gte: fw.yearStart, lte: fw.yearEnd } };
    const [draftSales, draftPurchases, pendingRequests] = await Promise.all([tx.salesDocument.count({ where: inYear }), tx.purchaseDocument.count({ where: inYear }),
      tx.journalRequest.count({ where: { companyId, status: 'PENDING', journalDate: { gte: fw.yearStart, lte: fw.yearEnd } } })]);
    const d1 = { periodsCoverYear: !gap, draftSales, draftPurchases, pendingRequests, periods: periods.map((p) => ({ start: isoDay(p.startDate), end: isoDay(p.endDate), status: p.status })) };
    const needs1 = [...(gap ? ['the accounting periods do not cover the whole year'] : []), ...(draftSales ? [`${draftSales} draft sales document(s) dated in the year`] : []),
      ...(draftPurchases ? [`${draftPurchases} draft purchase document(s) dated in the year`] : []), ...(pendingRequests ? [`${pendingRequests} journal request(s) waiting for approval`] : [])];
    c[1] = needs1.length ? ATTENTION(`Bookkeeping cut-off: ${needs1.join('; ')}`, d1) : READY('The periods cover the year; nothing is waiting in draft or for approval. The periods are locked at approval (V2-M6c).', d1);

    // 2, 3, 4, 7, 9, 10: the review checklist (V2-M6a)
    const cl = await this.review.checklist(tx, companyId, { yearStart: start });
    const ctl = (code: string) => cl.controls.find((x) => x.code === code)!;
    const fromReview = (code: string, title: string): Control => {
      const x = ctl(code);
      return x.status === 'CLEAR' || x.status === 'SIGNED_OFF' ? READY(`${title}: review control ${code} is ${x.status.toLowerCase().replace('_', ' ')}`, { control: code, status: x.status })
        : ATTENTION(`${title}: review control ${code} is ${x.status.toLowerCase().replace('_', ' ')}`, { control: code, status: x.status, counts: x.counts });
    };
    c[2] = fromReview('RC-08', 'Bank reconciliation');
    const parties = (party: 'customer' | 'supplier', title: string): Control => {
      const x = ctl('RC-05');
      if (x.status === 'NOT_EVALUATED') return ATTENTION(`${title}: review control RC-05 is not evaluated (the old-item setting is not set)`, { control: 'RC-05', status: x.status });
      const flags = x.flags.filter((f) => f.subject.type === party), open = flags.filter((f) => f.state !== 'SIGNED_OFF');
      return open.length ? ATTENTION(`${title}: ${open.length} old item flag(s) not signed off`, { control: 'RC-05', flags: flags.length, notSignedOff: open.length })
        : READY(`${title}: ${flags.length ? 'every old item flag is signed off' : 'nothing is overdue beyond the setting'}`, { control: 'RC-05', flags: flags.length });
    };
    c[3] = parties('customer', 'Receivables');
    c[4] = parties('supplier', 'Payables');
    c[7] = fromReview('RC-06', 'Director balances');
    c[9] = fromReview('RC-07', 'Suspense');
    c[10] = cl.complete ? READY('The review checklist is complete: every control evaluated and every flag signed off', { complete: true })
      : ATTENTION('The review checklist is not complete', { complete: false, controls: cl.controls.map((x) => ({ code: x.code, status: x.status })) });

    // 5: the fixed-asset register reconciles; an active asset needs a live run as at the year end
    const reg = await this.assets.register(tx, companyId, end);
    const active = await tx.fixedAsset.count({ where: { companyId, status: { in: ['ACTIVE', 'DISPOSED'] }, acquiredOn: { lte: fw.yearEnd }, OR: [{ disposedOn: null }, { disposedOn: { gt: fw.yearEnd } }] } });
    const run = await tx.depreciationRun.findFirst({ where: { companyId, asAt: fw.yearEnd, status: 'POSTED' } });
    const d5 = { reconciled: reg.reconciled, activeAssets: active, yearEndRun: !!run };
    c[5] = !reg.reconciled ? ATTENTION('The fixed-asset register does not reconcile to the ledger at the year end', d5)
      : active && !run ? ATTENTION('No live depreciation run as at the year end', d5) : READY(active ? 'The register reconciles and is depreciated to the year end' : 'No fixed assets in use at the year end', d5);

    // 6: the year-end register reconciles
    const ye = await this.yearEnd.register(tx, companyId, end);
    c[6] = ye.reconciled ? READY('Accruals, prepayments, deferred income and provisions reconcile to the ledger at the year end', { reconciled: true })
      : ATTENTION('The year-end register does not reconcile to the ledger at the year end', { reconciled: false, reconciliation: ye.reconciliation.filter((r) => !r.reconciled).map((r) => ({ code: r.code, difference: r.difference })) });

    // 8: VAT, when registered for any part of the year
    const vs = await this.vat.getSettings(tx, companyId);
    if (!vs.registered || (vs.registeredFrom && vs.registeredFrom > end)) c[8] = { status: 'NOT_APPLICABLE', summary: 'The company is not VAT registered in the year', details: { registered: false } };
    else {
      const wp = await this.vat.workpaper(tx, companyId, { from: vs.registeredFrom && vs.registeredFrom > start ? vs.registeredFrom : start, to: end });
      const un = unexplainedVatDifference(wp.reconciliation);
      const d8 = { difference: wp.reconciliation.difference, explained: wp.reconciliation.explainedBy.length, unexplained: un.toFixed(2) };
      c[8] = un.isZero() ? READY('The VAT accounts reconcile to the VAT lines for the year; every difference is explained', d8) : ATTENTION(`An unexplained VAT difference of ${un.toFixed(2)}`, d8);
    }

    // 11: the accounts document is complete and the size test is verified and fits
    const doc = await this.document.document(tx, companyId, { yearStart: start });
    const size = await this.sizes.test(tx, companyId, { yearStart: start });
    const d11 = { documentComplete: doc.complete, documentProblems: doc.problems.length, sizeVerified: size.verified, qualifiesAs: size.qualifiesAs, chosen: size.chosen, fits: size.fits };
    const needs11 = [...(doc.complete ? [] : ['the accounts document is not complete']), ...(size.verified ? [] : ['the size test uses unverified or missing thresholds']), ...(size.fits === true ? [] : ['the chosen entity size does not fit or cannot be decided'])];
    c[11] = needs11.length ? ATTENTION(`Accounts: ${needs11.join('; ')}`, d11) : READY('The accounts document is complete and the size test is verified and fits', d11);

    // 12 to 14 (DEC-070): the fingerprint of the accounts against the partner reviews, the client approval and the package
    const fingerprint = accountsFingerprint(doc);
    const records = await tx.accountsApproval.findMany({ where: { frameworkId: fw.id }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    const reviews = records.filter((r) => r.stage === 'PARTNER_REVIEW'), approval = records.find((r) => r.stage === 'CLIENT_APPROVAL') ?? null;
    const pkg = await tx.accountsPackage.findFirst({ where: { frameworkId: fw.id }, select: { id: true, fingerprint: true } });
    const latest = reviews.at(-1) ?? null, liveReview = !!latest && latest.fingerprint === fingerprint;
    const d12 = { fingerprint, reviews: reviews.length, liveReview };
    c[12] = latest ? (liveReview ? READY('The partner review is of the accounts as they stand', d12) : ATTENTION('The accounts changed since the partner review; it needs a new review', d12))
      : fingerprint ? READY('The accounts are ready for the partner review', d12) : ATTENTION('The accounts document is not complete', d12);
    const facts = new Map((await this.document.facts(tx, companyId, start)).current.map((f) => [f.key, f.value]));
    const open = periods.filter((p) => p.status === 'OPEN').length;
    if (approval) {
      const same = approval.fingerprint === fingerprint;
      c[13] = same ? READY('The client approved the accounts as they stand; the year is locked', { approved: true, approvedOn: isoDay(approval.approvedOn!) })
        : ATTENTION('The accounts changed since the client approved them', { approved: true, approvedOn: isoDay(approval.approvedOn!) });
    } else {
      const needs13 = [...(liveReview ? [] : ['no live partner review']), ...(open ? [`${open} accounting period(s) of the year are open; close them before approval`] : []),
        ...(facts.has('approval.date') && facts.has('approval.director') ? [] : ['the approval facts (approval.date, approval.director) are not set'])];
      const d13 = { approved: false, liveReview, openPeriods: open, approvalFacts: facts.has('approval.date') && facts.has('approval.director') };
      c[13] = needs13.length ? ATTENTION(`Client approval: ${needs13.join('; ')}`, d13) : READY("Ready for the client's approval, which locks the year", d13);
    }
    if (pkg) c[14] = pkg.fingerprint === fingerprint ? READY('The filing-ready package holds the accounts as they stand', { generated: true })
      : ATTENTION('The accounts changed since the package was generated', { generated: true });
    else {
      const problems = packageProblems({ approved: !!approval, fingerprint, approvedFingerprint: approval?.fingerprint ?? null, documentComplete: doc.complete, versionVerified: doc.verified,
        thresholdSetsVerified: size.verified, sizeFits: size.fits });
      c[14] = problems.length ? ATTENTION(`Package: ${problems.join('; ')}`, { generated: false, problems }) : READY('Ready to generate the filing-ready package', { generated: false });
    }
    return { c, doc, size, fingerprint, reviews, approval, pkg };
  }

  private async framework(tx: Tx, companyId: string, yearStart: string) {
    const fw = await tx.companyReportingFramework.findFirst({ where: { companyId, yearStart: toDate(yearStart) } });
    if (!fw) throw notFound(`No reporting framework is set for the year starting ${yearStart}`, 'framework_not_set');
    return fw;
  }
  private async compute(tx: Tx, companyId: string, yearStart: string) {
    const fw = await this.framework(tx, companyId, yearStart);
    const read = await this.controls(tx, companyId, fw);
    const controls = read.c;
    const rows = await tx.yearEndStepSignoff.findMany({ where: { frameworkId: fw.id }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    const signedOff: Record<number, boolean> = {};
    for (const r of rows) signedOff[r.step] = r.action === 'SIGN_OFF';
    signedOff[12] = read.reviews.length > 0; signedOff[13] = !!read.approval; signedOff[14] = !!read.pkg;
    const { state, current } = yearEndStepStates(Object.fromEntries(Object.entries(controls).map(([k, v]) => [k, v.status])), signedOff);
    return { fw, controls, rows, signedOff, state, current, read };
  }
  /** The workflow's state with what it read, for the approval service (DEC-070). */
  state(tx: Tx, companyId: string, yearStart: string): Promise<WorkflowState> { return this.compute(tx, companyId, yearStart) as Promise<WorkflowState>; }

  /** The workflow of the framework year starting `yearStart` (v2-plan 5i.2). */
  async workflow(tx: Tx, companyId: string, q: { yearStart: string }) {
    const w = await this.compute(tx, companyId, q.yearStart);
    return {
      companyId, year: { start: isoDay(w.fw.yearStart), end: isoDay(w.fw.yearEnd), frameworkId: w.fw.id }, locked: !!w.fw.lockedAt, fingerprint: w.read.fingerprint, current: w.current,
      steps: YEAR_END_STEPS.map((title, i) => {
        const n = i + 1, ctl = w.controls[n]!;
        return { step: n, title, dependsOn: YEAR_END_STEP_DEPENDS[n]!, control: ctl, state: w.state[n]!,
          signOffs: w.rows.filter((r) => r.step === n).map((r) => ({ action: r.action, note: r.note, control: r.control as Record<string, unknown>, byUserId: r.byUserId, at: r.at })) };
      }),
      notices: ['Each step reads its status from an existing control; a sign-off lapses when its control stops being ready. Second-person control stays with the review flags, the verified rules and the partner and client approvals (DEC-069).',
        'Steps 12 to 14 are done through the partner review, the client approval and the filing-ready package (DEC-070); the approval locks the year.'],
    };
  }

  private async need(actor: PostingActor, companyId: string) {
    if (actor.kind !== 'USER') throw forbidden('Only a person can sign off a year-end step', 'ai_cannot_write');
    if (!(await actor.can('accounts:prepare', companyId))) throw forbidden('Requires permission accounts:prepare', 'permission_denied');
  }
  private ownRecord(step: number) {
    if (YEAR_END_OWN_RECORD_STEPS.includes(step)) throw conflict(`Step ${step} is done through the ${step === 12 ? 'partner review' : step === 13 ? "client's approval" : 'filing-ready package'}, not signed off here`, 'step_own_record');
  }
  async signOff(tx: Tx, a: Ctx & { yearStart: string; step: number; note?: string }) {
    await this.need(a.actor, a.companyId);
    this.ownRecord(a.step);
    const w = await this.compute(tx, a.companyId, a.yearStart);
    assertYearOpen(w.fw);
    const st = w.state[a.step];
    if (w.signedOff[a.step]) throw conflict(`Step ${a.step} is already signed off; reopen it first`, 'step_signed_off');
    if (st === 'BLOCKED') throw conflict(`Step ${a.step} waits for step(s) ${YEAR_END_STEP_DEPENDS[a.step]!.filter((d) => w.state[d] !== 'DONE').join(', ')}`, 'step_blocked');
    if (st !== 'TODO') throw unprocessable(`Step ${a.step} is not ready: ${w.controls[a.step]!.summary}`, 'step_not_ready');
    const ctl = w.controls[a.step]!;
    const r = await tx.yearEndStepSignoff.create({ data: { organisationId: a.organisationId, companyId: a.companyId, frameworkId: w.fw.id, step: a.step, action: 'SIGN_OFF', note: a.note ?? null,
      control: { status: ctl.status, summary: ctl.summary, details: ctl.details } as object, byUserId: a.actor.userId! } });
    await this.audit(tx, { action: 'accounts.year_end_step_signed_off', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'year_end_step_signoff', entityId: r.id,
      after: { yearStart: a.yearStart, step: a.step, control: ctl.status, note: a.note ?? null } });
    return this.workflow(tx, a.companyId, { yearStart: a.yearStart });
  }
  async reopen(tx: Tx, a: Ctx & { yearStart: string; step: number; note: string }) {
    await this.need(a.actor, a.companyId);
    this.ownRecord(a.step);
    const w = await this.compute(tx, a.companyId, a.yearStart);
    assertYearOpen(w.fw);
    if (!w.signedOff[a.step]) throw conflict(`Step ${a.step} is not signed off`, 'step_not_signed_off');
    const ctl = w.controls[a.step]!;
    const r = await tx.yearEndStepSignoff.create({ data: { organisationId: a.organisationId, companyId: a.companyId, frameworkId: w.fw.id, step: a.step, action: 'REOPEN', note: a.note,
      control: { status: ctl.status, summary: ctl.summary, details: ctl.details } as object, byUserId: a.actor.userId! } });
    await this.audit(tx, { action: 'accounts.year_end_step_reopened', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'year_end_step_signoff', entityId: r.id,
      after: { yearStart: a.yearStart, step: a.step, note: a.note }, reason: a.note });
    return this.workflow(tx, a.companyId, { yearStart: a.yearStart });
  }
}
