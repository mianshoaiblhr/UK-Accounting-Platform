import { createHash } from 'node:crypto';
import { PACKAGE_FORMAT, YEAR_END_STEP_DEPENDS, approvalDateProblems, canonicalJson, packageProblems } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable } from '@uk/core';
import type { Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import { assertYearOpen } from './accounts-document';
import type { PeriodService } from './periods';
import type { PostingActor } from './posting';
import type { FrameworkService } from './statutory';
import type { WorkflowState, YearEndWorkflowService } from './year-end-workflow';

/**
 * V2-M6c (DEC-070; v2-plan section 5j): partner review, client approval, locking and the filing-ready package of a framework year. The
 * fingerprint of the accounts document ties them together. What is stored is each review and the approval (written once) and the package
 * (one per year, written once); the periods are locked through the period service and the framework through the framework service.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
/** The actor, with per-document visibility for the approval evidence (ADR-32). */
type ApprovalActor = PostingActor & { canReadDocument?(d: { id: string; companyId: string | null; visibility: string; createdByUserId: string | null }): boolean | Promise<boolean> };
type Ctx = { organisationId: string; companyId: string; actor: ApprovalActor };

export class AccountsApprovalService {
  constructor(private readonly workflow: YearEndWorkflowService, private readonly periods: PeriodService, private readonly frameworks: FrameworkService,
    private readonly opts: { captureDeviceMetadata?: boolean; today?: () => string } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private today() { return this.opts.today?.() ?? isoDay(new Date()); }
  private async need(actor: PostingActor, companyId: string, ...permissions: string[]) {
    if (actor.kind !== 'USER') throw forbidden('Only a person can review, approve or package the accounts', 'ai_cannot_write');
    for (const p of permissions) if (!(await actor.can(p, companyId))) throw forbidden(`Requires permission ${p}`, 'permission_denied');
  }
  private refuseByState(w: WorkflowState, step: number) {
    const st = w.state[step];
    if (st === 'BLOCKED') throw conflict(`Step ${step} waits for step(s) ${YEAR_END_STEP_DEPENDS[step]!.filter((d) => w.state[d] !== 'DONE').join(', ')}`, 'step_blocked');
    if (st !== 'TODO') throw unprocessable(`Step ${step} is not ready: ${w.controls[step]!.summary}`, 'step_not_ready');
  }

  /** The year's reviews, approval and package against the accounts as they stand (v2-plan 5j.3). */
  async status(tx: Tx, companyId: string, q: { yearStart: string }) {
    const w = await this.workflow.state(tx, companyId, q.yearStart);
    const { fingerprint, reviews, approval, pkg } = w.read;
    const latest = reviews.at(-1);
    return {
      companyId, year: { start: isoDay(w.fw.yearStart), end: isoDay(w.fw.yearEnd), frameworkId: w.fw.id }, fingerprint, locked: !!w.fw.lockedAt, lockedAt: w.fw.lockedAt,
      steps: [12, 13, 14].map((n) => ({ step: n, state: w.state[n]!, control: w.controls[n]! })),
      partnerReviews: reviews.map((r) => ({ id: r.id, fingerprint: r.fingerprint, live: r === latest && r.fingerprint === fingerprint, note: r.note, byUserId: r.byUserId, at: r.at })),
      clientApproval: approval && { id: approval.id, fingerprint: approval.fingerprint, current: approval.fingerprint === fingerprint, directorContactId: approval.directorContactId!,
        approvedOn: isoDay(approval.approvedOn!), evidenceDocumentId: approval.evidenceDocumentId!, note: approval.note, byUserId: approval.byUserId, at: approval.at },
      package: pkg && (await this.packageSummary(tx, pkg.id)),
    };
  }
  private async packageSummary(tx: Tx, id: string) {
    const p = await tx.accountsPackage.findFirstOrThrow({ where: { id }, select: { id: true, fingerprint: true, sha256: true, byUserId: true, at: true } });
    return { id: p.id, fingerprint: p.fingerprint, sha256: p.sha256, byUserId: p.byUserId, at: p.at };
  }

  /** Step 12: the partner review, by a second person holding accounts:review (DEC-070). */
  async partnerReview(tx: Tx, a: Ctx & { yearStart: string; note?: string }) {
    await this.need(a.actor, a.companyId, 'accounts:review');
    const w = await this.workflow.state(tx, a.companyId, a.yearStart);
    assertYearOpen(w.fw);
    const { fingerprint, reviews } = w.read;
    if (w.state[12] === 'BLOCKED') this.refuseByState(w, 12);
    if (reviews.length && reviews.at(-1)!.fingerprint === fingerprint) throw conflict('The accounts as they stand are already reviewed', 'already_reviewed');
    if (!fingerprint) throw unprocessable('The accounts document is not complete', 'step_not_ready');
    const s11 = w.rows.filter((r) => r.step === 11).at(-1);
    if (s11?.byUserId === a.actor.userId) throw forbidden('The partner review is recorded by someone other than the person who signed off the accounts', 'second_person_required');
    const r = await tx.accountsApproval.create({ data: { organisationId: a.organisationId, companyId: a.companyId, frameworkId: w.fw.id, stage: 'PARTNER_REVIEW', fingerprint, note: a.note ?? null,
      byUserId: a.actor.userId! } });
    await this.audit(tx, { action: 'accounts.partner_reviewed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'accounts_approval', entityId: r.id,
      after: { yearStart: a.yearStart, fingerprint, note: a.note ?? null } });
    return this.status(tx, a.companyId, { yearStart: a.yearStart });
  }

  /** Step 13: the client's approval, which locks the year's periods and framework in the same transaction (DEC-070). */
  async clientApproval(tx: Tx, a: Ctx & { yearStart: string; directorContactId: string; approvedOn: string; evidenceDocumentId: string; note?: string }) {
    await this.need(a.actor, a.companyId, 'accounts:review', 'period:lock');
    const w = await this.workflow.state(tx, a.companyId, a.yearStart);
    assertYearOpen(w.fw);
    this.refuseByState(w, 13);
    const fingerprint = w.read.fingerprint!;
    // the approval the accounts state (Companies Act 2006 s.414) is the one recorded
    const facts = new Map<string, string>();
    for (const f of await tx.accountsFact.findMany({ where: { frameworkId: w.fw.id, key: { in: ['approval.date', 'approval.director'] } }, orderBy: [{ setAt: 'desc' }, { id: 'desc' }] })) if (!facts.has(f.key)) facts.set(f.key, f.value);
    if (facts.get('approval.director') !== a.directorContactId || facts.get('approval.date') !== a.approvedOn) {
      throw unprocessable(`The approval recorded must be the one the accounts state: director ${facts.get('approval.director') ?? '(not set)'} on ${facts.get('approval.date') ?? '(not set)'}`, 'approval_mismatch');
    }
    const dates = approvalDateProblems({ yearEnd: isoDay(w.fw.yearEnd), approvedOn: a.approvedOn, today: this.today() });
    if (dates.length) throw unprocessable(`The approval date is not acceptable: ${dates.join('; ')}`, 'approval_date_invalid');
    const on = new Date(`${a.approvedOn}T00:00:00.000Z`);
    if (!(await tx.companyOfficer.findFirst({ where: { companyId: a.companyId, contactId: a.directorContactId, role: 'DIRECTOR', appointedOn: { lte: on }, OR: [{ resignedOn: null }, { resignedOn: { gte: on } }] } }))) {
      throw unprocessable('The approving director did not serve the company on the approval date', 'director_not_serving');
    }
    const evidence = await tx.document.findFirst({ where: { id: a.evidenceDocumentId, companyId: a.companyId, status: 'ACTIVE' },
      select: { id: true, companyId: true, visibility: true, createdByUserId: true, versions: { where: { status: 'AVAILABLE' }, select: { id: true }, take: 1 } } });
    const readable = evidence && (a.actor.canReadDocument ? await a.actor.canReadDocument(evidence) : await a.actor.can('document:read', a.companyId));
    if (!evidence || !readable || evidence.versions.length === 0) throw unprocessable('The evidence must be a document of the company with a version scanned clean', 'evidence_invalid');
    const r = await tx.accountsApproval.create({ data: { organisationId: a.organisationId, companyId: a.companyId, frameworkId: w.fw.id, stage: 'CLIENT_APPROVAL', fingerprint, note: a.note ?? null,
      directorContactId: a.directorContactId, approvedOn: on, evidenceDocumentId: a.evidenceDocumentId, byUserId: a.actor.userId! } });
    await this.audit(tx, { action: 'accounts.client_approved', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'accounts_approval', entityId: r.id,
      after: { yearStart: a.yearStart, fingerprint, directorContactId: a.directorContactId, approvedOn: a.approvedOn, evidenceDocumentId: a.evidenceDocumentId, note: a.note ?? null } });
    // lock: every closed period of the year through the period service (its audit and event), then the framework
    const reason = `Accounts for the year ${isoDay(w.fw.yearStart)} to ${isoDay(w.fw.yearEnd)} approved by the client on ${a.approvedOn} (approval ${r.id})`;
    const periods = await tx.accountingPeriod.findMany({ where: { companyId: a.companyId, startDate: { lte: w.fw.yearEnd }, endDate: { gte: w.fw.yearStart }, status: 'CLOSED' }, orderBy: { startDate: 'asc' } });
    for (const p of periods) {
      await this.periods.transition(tx, { organisationId: a.organisationId, companyId: a.companyId, periodId: p.id, action: 'lock', reason, userId: a.actor.userId!,
        acknowledgeSuspenseBalance: true, can: (perm) => a.actor.can(perm, a.companyId) });
    }
    await this.frameworks.lock(tx, { organisationId: a.organisationId, companyId: a.companyId, frameworkId: w.fw.id, actorUserId: a.actor.userId!, approvalId: r.id });
    return this.status(tx, a.companyId, { yearStart: a.yearStart });
  }

  /** Step 14: the filing-ready package, once per year; refused unless approved, unchanged and every rule verified (DEC-070, V2-ARC-04). */
  async generatePackage(tx: Tx, a: Ctx & { yearStart: string }) {
    await this.need(a.actor, a.companyId, 'accounts:prepare');
    const w = await this.workflow.state(tx, a.companyId, a.yearStart);
    const { fingerprint, approval, pkg, doc, size, reviews } = w.read;
    if (pkg) throw conflict('The filing-ready package of this year is already generated', 'package_exists');
    if (w.state[14] === 'BLOCKED') this.refuseByState(w, 14);
    const problems = packageProblems({ approved: !!approval && !!w.fw.lockedAt, fingerprint, approvedFingerprint: approval?.fingerprint ?? null, documentComplete: doc.complete,
      versionVerified: doc.verified, thresholdSetsVerified: size.verified, sizeFits: size.fits });
    if (problems.length) throw unprocessable(`The filing-ready package cannot be generated: ${problems.join('; ')}`, 'package_refused', { problems });
    const fw = w.fw, ap = approval!;
    const version = await tx.reportingStandardVersion.findFirstOrThrow({ where: { id: fw.versionId }, select: { id: true, label: true, status: true, verifiedByUserId: true, verifiedAt: true, createdByUserId: true } });
    const director = await tx.contact.findFirstOrThrow({ where: { id: ap.directorContactId! }, select: { id: true, name: true } });
    const review = reviews.filter((r) => r.fingerprint === ap.fingerprint).at(-1)!;
    const { notices: _n, ...sizeTest } = size;
    const content = {
      format: PACKAGE_FORMAT,
      company: { id: a.companyId, name: doc.companyName, number: doc.companyNumber, currency: doc.currency },
      year: { start: isoDay(fw.yearStart), end: isoDay(fw.yearEnd), entitySize: fw.entitySize, frameworkId: fw.id },
      framework: { standard: doc.standard, version: { id: version.id, label: version.label, status: version.status, createdByUserId: version.createdByUserId, verifiedByUserId: version.verifiedByUserId, verifiedAt: version.verifiedAt } },
      sizeTest,
      fingerprint,
      partnerReview: { id: review.id, byUserId: review.byUserId, at: review.at, note: review.note },
      clientApproval: { id: ap.id, director: { contactId: director.id, name: director.name }, approvedOn: isoDay(ap.approvedOn!), evidenceDocumentId: ap.evidenceDocumentId, recordedByUserId: ap.byUserId, recordedAt: ap.at, note: ap.note },
      accounts: doc,
      notices: ['Filing-ready output, not a filing: iXBRL tagging and submission to Companies House are V3.',
        'Every rule used was verified by a second person holding accounts:rule-verify (DEC-052); the standard content remains the firm\'s, verified by its named accountant (DEC-056).'],
    };
    const json = JSON.parse(JSON.stringify(content)) as Record<string, unknown>;
    const sha256 = createHash('sha256').update(canonicalJson(json)).digest('hex');
    const row = await tx.accountsPackage.create({ data: { organisationId: a.organisationId, companyId: a.companyId, frameworkId: fw.id, fingerprint: fingerprint!, sha256, content: json as object, byUserId: a.actor.userId! } });
    await this.audit(tx, { action: 'accounts.package_generated', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'accounts_package', entityId: row.id,
      after: { yearStart: a.yearStart, fingerprint, sha256 } });
    return this.package(tx, a.companyId, { yearStart: a.yearStart });
  }
  async package(tx: Tx, companyId: string, q: { yearStart: string }) {
    const fw = await tx.companyReportingFramework.findFirst({ where: { companyId, yearStart: new Date(`${q.yearStart}T00:00:00.000Z`) }, select: { id: true } });
    if (!fw) throw notFound(`No reporting framework is set for the year starting ${q.yearStart}`, 'framework_not_set');
    const p = await tx.accountsPackage.findFirst({ where: { frameworkId: fw.id } });
    if (!p) throw notFound('No filing-ready package is generated for this year', 'package_not_found');
    return { id: p.id, companyId, yearStart: q.yearStart, frameworkId: fw.id, fingerprint: p.fingerprint, sha256: p.sha256, byUserId: p.byUserId, at: p.at, content: p.content as Record<string, unknown> };
  }
}
