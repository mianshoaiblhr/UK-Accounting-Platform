import { FINAL_STATUSES } from '@uk/contracts';
import { AppError, conflict, forbidden, notFound, unprocessable } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow } from '@uk/platform';

/**
 * V3-M3 (DEC-095): the Companies House filing workflow. A filing of a VALID iXBRL document (DEC-094) moves DRAFT -> VALIDATED -> AUTHORISED ->
 * SUBMITTED -> ACCEPTED or REJECTED, each move with an append-only event; the database guards the path. Submission needs a person's explicit
 * authority and goes through the Companies House port, whose only adapter is a fake (production refuses it); a filing made elsewhere is
 * recorded with its evidence. Acceptance marks the accounts deadline done. Nothing here changes an accounting record.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ukToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
type FilingRow = Awaited<ReturnType<Tx['chFiling']['findUniqueOrThrow']>>;
type EventRow = Awaited<ReturnType<Tx['chFilingEvent']['findUniqueOrThrow']>>;
export interface ChActor { userId: string; kind?: string; can(permission: string, companyId: string): boolean | Promise<boolean>;
  canReadDocument?(d: { id: string; companyId: string | null; visibility: string; createdByUserId: string | null }): boolean | Promise<boolean> }
/** The port the workflow calls; the adapters package implements it (only a fake exists). */
export interface ChFilingPort {
  readonly name: string;
  submit(s: { companyNumber: string; documentSha256: string; content: string; idempotencyKey: string }): Promise<{ submissionId: string; request: Record<string, unknown>; response: Record<string, unknown> }>;
  status(submissionId: string, companyNumber: string): Promise<{ status: 'PENDING' | 'ACCEPTED' | 'REJECTED'; reference: string | null; reasons: string[]; response: Record<string, unknown> }>;
}

const filingView = (f: FilingRow, events: EventRow[] = []) => ({
  id: f.id, companyId: f.companyId, documentId: f.documentId, status: f.status, mode: f.mode, payloadSha256: f.payloadSha256, createdByUserId: f.createdByUserId, createdAt: f.createdAt,
  validatedByUserId: f.validatedByUserId, authority: f.authorisedByUserId ? { byUserId: f.authorisedByUserId, directorContactId: f.directorContactId, authorisedOn: isoDay(f.authorisedOn!), evidenceDocumentId: f.authorityEvidenceId } : null,
  submissionId: f.submissionId, chReference: f.chReference, acceptedOn: f.acceptedOn ? isoDay(f.acceptedOn) : null, acceptanceEvidenceId: f.acceptanceEvidenceId,
  rejectionReasons: (f.rejectionReasons as string[] | null) ?? [], updatedAt: f.updatedAt,
  events: events.map((e) => ({ id: e.id, fromStatus: e.fromStatus, toStatus: e.toStatus, payloadSha256: e.payloadSha256, submissionId: e.submissionId, request: e.request, response: e.response, note: e.note, byUserId: e.byUserId, at: e.at })),
  notice: f.mode === 'RECORDED' ? 'Filed outside the platform and recorded with its evidence.' : 'Through the Companies House port. The only adapter is a fake: nothing reaches Companies House (DEC-095).',
});

export class ChFilingService {
  constructor(private readonly port: ChFilingPort | null, private readonly opts: { captureDeviceMetadata?: boolean; today?: () => string } = {}) {}
  private today() { return this.opts.today?.() ?? ukToday(); }
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: ChActor, companyId: string) {
    if (actor.kind && actor.kind !== 'USER') throw forbidden('Only a person can act on a Companies House filing', 'ai_cannot_post');
    if (!(await actor.can('ixbrl:file', companyId))) throw forbidden('Requires permission ixbrl:file', 'permission_denied');
  }
  private async find(tx: Tx, companyId: string, id: string) {
    const f = await tx.chFiling.findFirst({ where: { id, companyId } });
    if (!f) throw notFound('Companies House filing not found', 'ch_filing_not_found');
    return f;
  }
  private expect(f: FilingRow, ...statuses: string[]) {
    if (!statuses.includes(f.status)) throw conflict(`The filing is ${f.status}; this step needs it ${statuses.join(' or ')}`, 'filing_wrong_status', { status: f.status });
  }
  /** One move: the row (guarded in the database) and its event, then the audit. */
  private async move(tx: Tx, a: { organisationId: string; actor: ChActor; f: FilingRow; to: string; data?: Prisma.ChFilingUncheckedUpdateInput; submissionId?: string | null;
    request?: Record<string, unknown>; response?: Record<string, unknown>; note?: string }) {
    const after = await tx.chFiling.update({ where: { id: a.f.id }, data: { status: a.to, ...(a.data ?? {}) } });
    await tx.chFilingEvent.create({ data: { organisationId: a.organisationId, companyId: a.f.companyId, filingId: a.f.id, fromStatus: a.f.status, toStatus: a.to, payloadSha256: a.f.payloadSha256,
      submissionId: a.submissionId ?? null, request: (a.request as Prisma.InputJsonValue) ?? Prisma.DbNull, response: (a.response as Prisma.InputJsonValue) ?? Prisma.DbNull, note: a.note?.trim() || null, byUserId: a.actor.userId } });
    await this.audit(tx, { action: `ch_filing.${a.to.toLowerCase()}`, organisationId: a.organisationId, companyId: a.f.companyId, actorUserId: a.actor.userId, entityType: 'ch_filing', entityId: a.f.id,
      before: { status: a.f.status }, after: { status: a.to, submissionId: after.submissionId, chReference: after.chReference }, reason: a.note?.trim() || null });
    return after;
  }
  private async evidence(tx: Tx, actor: ChActor, companyId: string, id: string) {
    const d = await tx.document.findFirst({ where: { id, companyId, status: 'ACTIVE' },
      select: { id: true, companyId: true, visibility: true, createdByUserId: true, versions: { where: { status: 'AVAILABLE' }, select: { id: true }, take: 1 } } });
    const readable = d && (actor.canReadDocument ? await actor.canReadDocument(d) : await actor.can('document:read', companyId));
    if (!d || !readable || d.versions.length === 0) throw unprocessable('The evidence must be a document of the company with a version scanned clean', 'evidence_invalid');
  }
  /** On ACCEPTED: the accounts-filing obligation of the year end becomes DONE (V7-M1), versioned and audited. */
  private async closeObligation(tx: Tx, a: { organisationId: string; actor: ChActor; f: FilingRow; acceptedOn: string; reference: string; evidenceId: string | null }) {
    const doc = await tx.ixbrlDocument.findFirstOrThrow({ where: { id: a.f.documentId }, select: { packageId: true } });
    const pkg = await tx.accountsPackage.findFirstOrThrow({ where: { id: doc.packageId }, select: { frameworkId: true } });
    const fw = await tx.companyReportingFramework.findFirstOrThrow({ where: { id: pkg.frameworkId }, select: { yearEnd: true } });
    const o = await tx.complianceObligation.findFirst({ where: { companyId: a.f.companyId, kind: 'ACCOUNTS_FILING', periodEnd: fw.yearEnd }, orderBy: { createdAt: 'asc' } });
    if (!o || (FINAL_STATUSES as readonly string[]).includes(o.status)) return;
    await tx.complianceObligation.update({ where: { id: o.id }, data: { version: o.version + 1, status: 'DONE', doneOn: toDate(a.acceptedOn), doneReference: a.reference.slice(0, 200), evidenceDocumentId: a.evidenceId, statusReason: null } });
    await this.audit(tx, { action: 'compliance.obligation_updated', organisationId: a.organisationId, companyId: a.f.companyId, actorUserId: a.actor.userId, entityType: 'compliance_obligation', entityId: o.id,
      before: { status: o.status, version: o.version }, after: { status: 'DONE', doneOn: a.acceptedOn, doneReference: a.reference, version: o.version + 1 }, reason: 'Companies House accepted the accounts', metadata: { chFilingId: a.f.id } });
  }

  async list(tx: Tx, companyId: string) {
    return { items: (await tx.chFiling.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' } })).map((f) => filingView(f)) };
  }
  async get(tx: Tx, companyId: string, id: string) {
    const f = await this.find(tx, companyId, id);
    return filingView(f, await tx.chFilingEvent.findMany({ where: { filingId: id }, orderBy: { seq: 'asc' } }));
  }

  async create(tx: Tx, a: { organisationId: string; companyId: string; actor: ChActor; documentId: string }) {
    await this.need(a.actor, a.companyId);
    const d = await tx.ixbrlDocument.findFirst({ where: { id: a.documentId, companyId: a.companyId } });
    if (!d) throw notFound('iXBRL document not found', 'ixbrl_document_not_found');
    // the accounts of a year are filed once: an ACCEPTED filing of any document of the same package ends it
    const siblings = (await tx.ixbrlDocument.findMany({ where: { packageId: d.packageId }, select: { id: true } })).map((x) => x.id);
    if (await tx.chFiling.findFirst({ where: { documentId: { in: siblings }, status: 'ACCEPTED' }, select: { id: true } })) throw conflict('These accounts were already accepted by Companies House', 'already_filed');
    let f: FilingRow;
    try {
      f = await tx.chFiling.create({ data: { organisationId: a.organisationId, companyId: a.companyId, documentId: d.id, payloadSha256: d.sha256, createdByUserId: a.actor.userId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('This document already has a live filing', 'filing_exists');
      throw e;
    }
    await tx.chFilingEvent.create({ data: { organisationId: a.organisationId, companyId: a.companyId, filingId: f.id, fromStatus: null, toStatus: 'DRAFT', payloadSha256: d.sha256, byUserId: a.actor.userId } });
    await this.audit(tx, { action: 'ch_filing.draft', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ch_filing', entityId: f.id, after: { documentId: d.id, payloadSha256: d.sha256 } });
    return this.get(tx, a.companyId, f.id);
  }

  /** VALIDATED: the document is VALID, it is the latest of its package, and the company has a registered number. */
  async validate(tx: Tx, a: { organisationId: string; companyId: string; actor: ChActor; id: string; note?: string }) {
    await this.need(a.actor, a.companyId);
    const f = await this.find(tx, a.companyId, a.id);
    this.expect(f, 'DRAFT');
    const d = await tx.ixbrlDocument.findFirstOrThrow({ where: { id: f.documentId } });
    const problems: string[] = [];
    if (d.status !== 'VALID') problems.push('the iXBRL document is INVALID');
    const latest = await tx.ixbrlDocument.findFirst({ where: { packageId: d.packageId }, orderBy: [{ at: 'desc' }, { id: 'desc' }], select: { id: true, sha256: true } });
    if (latest && latest.id !== d.id && latest.sha256 !== d.sha256) problems.push('a later document of the same accounts differs from this one');
    const company = await tx.company.findFirstOrThrow({ where: { id: a.companyId }, select: { companyNumber: true } });
    if (!company.companyNumber) problems.push('the company has no registered number');
    if (problems.length) throw unprocessable(`The filing cannot be validated: ${problems.join('; ')}`, 'filing_invalid', { problems });
    await this.move(tx, { ...a, f, to: 'VALIDATED', data: { validatedByUserId: a.actor.userId }, note: a.note });
    return this.get(tx, a.companyId, a.id);
  }

  /** AUTHORISED: the explicit authority, from a director serving on the date, with evidence; recorded by someone other than the validator. */
  async authorise(tx: Tx, a: { organisationId: string; companyId: string; actor: ChActor; id: string; directorContactId: string; authorisedOn: string; evidenceDocumentId: string; note?: string }) {
    await this.need(a.actor, a.companyId);
    const f = await this.find(tx, a.companyId, a.id);
    this.expect(f, 'VALIDATED');
    if (f.validatedByUserId === a.actor.userId) throw forbidden('The authority is recorded by someone other than the person who validated the filing', 'self_authorisation_not_allowed');
    if (a.authorisedOn > this.today()) throw unprocessable('An authority is recorded once it has been given, not before', 'authority_date_invalid');
    const on = toDate(a.authorisedOn);
    if (!(await tx.companyOfficer.findFirst({ where: { companyId: a.companyId, contactId: a.directorContactId, role: 'DIRECTOR', appointedOn: { lte: on }, OR: [{ resignedOn: null }, { resignedOn: { gte: on } }] } }))) {
      throw unprocessable('The authority must come from a director serving on that date', 'director_not_serving');
    }
    await this.evidence(tx, a.actor, a.companyId, a.evidenceDocumentId);
    await this.move(tx, { ...a, f, to: 'AUTHORISED', data: { authorisedByUserId: a.actor.userId, directorContactId: a.directorContactId, authorisedOn: on, authorityEvidenceId: a.evidenceDocumentId }, note: a.note });
    return this.get(tx, a.companyId, a.id);
  }

  /** SUBMITTED through the port, with the filing's id as the idempotency key. Never automatic: a person asks. */
  async submit(tx: Tx, a: { organisationId: string; companyId: string; actor: ChActor; id: string; note?: string }) {
    await this.need(a.actor, a.companyId);
    if (!this.port) throw new AppError(503, 'filing_not_available', 'No Companies House adapter is configured: the platform does not file with Companies House (DEC-095)');
    const f = await this.find(tx, a.companyId, a.id);
    if (f.status === 'SUBMITTED' || f.status === 'ACCEPTED' || f.status === 'REJECTED') return this.get(tx, a.companyId, a.id);   // a retry returns the same submission
    this.expect(f, 'AUTHORISED');
    const d = await tx.ixbrlDocument.findFirstOrThrow({ where: { id: f.documentId } });
    const company = await tx.company.findFirstOrThrow({ where: { id: a.companyId }, select: { companyNumber: true } });
    const r = await this.port.submit({ companyNumber: company.companyNumber!, documentSha256: d.sha256, content: d.content, idempotencyKey: f.id });
    await this.move(tx, { ...a, f, to: 'SUBMITTED', data: { submissionId: r.submissionId }, submissionId: r.submissionId, request: r.request, response: r.response, note: a.note });
    return this.get(tx, a.companyId, a.id);
  }

  /** Reads the submission's status from the port; ACCEPTED closes the accounts deadline, REJECTED is final. */
  async refresh(tx: Tx, a: { organisationId: string; companyId: string; actor: ChActor; id: string }) {
    await this.need(a.actor, a.companyId);
    if (!this.port) throw new AppError(503, 'filing_not_available', 'No Companies House adapter is configured: the platform does not file with Companies House (DEC-095)');
    const f = await this.find(tx, a.companyId, a.id);
    this.expect(f, 'SUBMITTED');
    const company = await tx.company.findFirstOrThrow({ where: { id: a.companyId }, select: { companyNumber: true } });
    const s = await this.port.status(f.submissionId!, company.companyNumber!);
    if (s.status === 'PENDING') return this.get(tx, a.companyId, a.id);
    if (s.status === 'REJECTED') {
      await this.move(tx, { ...a, f, to: 'REJECTED', data: { rejectionReasons: s.reasons }, submissionId: f.submissionId, response: s.response });
      return this.get(tx, a.companyId, a.id);
    }
    const acceptedOn = this.today();
    const after = await this.move(tx, { ...a, f, to: 'ACCEPTED', data: { chReference: s.reference ?? f.submissionId!, acceptedOn: toDate(acceptedOn) }, submissionId: f.submissionId, response: s.response });
    await this.closeObligation(tx, { organisationId: a.organisationId, actor: a.actor, f: after, acceptedOn, reference: after.chReference!, evidenceId: null });
    return this.get(tx, a.companyId, a.id);
  }

  /** A filing made outside the platform: ACCEPTED from VALIDATED or AUTHORISED, with Companies House's reference, the date and the evidence. */
  async record(tx: Tx, a: { organisationId: string; companyId: string; actor: ChActor; id: string; reference: string; acceptedOn: string; evidenceDocumentId: string; note?: string }) {
    await this.need(a.actor, a.companyId);
    const f = await this.find(tx, a.companyId, a.id);
    this.expect(f, 'VALIDATED', 'AUTHORISED');
    if (a.acceptedOn > this.today()) throw unprocessable('An acceptance is recorded once it has happened, not before', 'acceptance_date_invalid');
    await this.evidence(tx, a.actor, a.companyId, a.evidenceDocumentId);
    const after = await this.move(tx, { ...a, f, to: 'ACCEPTED', data: { mode: 'RECORDED', chReference: a.reference.trim(), acceptedOn: toDate(a.acceptedOn), acceptanceEvidenceId: a.evidenceDocumentId }, note: a.note });
    await this.closeObligation(tx, { organisationId: a.organisationId, actor: a.actor, f: after, acceptedOn: a.acceptedOn, reference: a.reference.trim(), evidenceId: a.evidenceDocumentId });
    return this.get(tx, a.companyId, a.id);
  }
}
