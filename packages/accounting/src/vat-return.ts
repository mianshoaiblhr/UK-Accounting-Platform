import { createHash } from 'node:crypto';
import { FINAL_STATUSES, canonicalJson, vatReturnStatus, type VatFlagKind } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import { money } from './money';
import type { VatActor, VatService } from './vat';

/**
 * V5-M1 (DEC-090): the VAT return, following the accounts approval pattern (DEC-070). The return is the M4b workpaper of one VAT period; its
 * fingerprint is the SHA-256 of the workpaper in canonical JSON without its notice, computed live, so a change of the ledger makes a step lapse.
 * Events are append-only. Review flags come from the workpaper and must be explained on the live fingerprint before review. The client's
 * approval stores the workpaper as approved, locks the period (the database refuses any later VAT line with a tax point inside it) and moves
 * the linked obligation to READY. NOTHING is filed here (V5-M2; DEC-082, DEC-086). No tax figure is built in: the boxes come from verified rules.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ukToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
type Workpaper = Awaited<ReturnType<VatService['workpaper']>>;
type ReturnRow = Awaited<ReturnType<Tx['vatReturn']['findUniqueOrThrow']>>;
type EventRow = Awaited<ReturnType<Tx['vatReturnEvent']['findUniqueOrThrow']>>;
export interface VatFlag { key: string; kind: VatFlagKind; message: string }

const LATE = 'Tax point in the period but journal dated outside it';

/** The workpaper as plain JSON (dates as text) and its fingerprint. */
export function vatFingerprint(wp: Workpaper): { content: Record<string, unknown>; fingerprint: string } {
  const { notice: _notice, ...rest } = JSON.parse(JSON.stringify(wp)) as Record<string, unknown>;
  return { content: rest, fingerprint: createHash('sha256').update(canonicalJson(rest)).digest('hex') };
}

/** The review flags a workpaper raises (DEC-090); `superseded` is the set of rate versions that have since been superseded. */
export function vatFlags(wp: { to: string; boxes: { box: number; amount: string; direction?: string }[]; reconciliation: { difference: string; explainedBy: { journalId: string; journalNumber: number; lineNo: number; journalDate: string; taxPoint: string | null; amount: string; reason: string }[] }; rules: { rateId: string; code: string }[] },
  superseded: Set<string>): VatFlag[] {
  const out: VatFlag[] = [];
  const box = (n: number) => money(wp.boxes.find((b) => b.box === n)?.amount ?? '0');
  if (!money(wp.reconciliation.difference).isZero()) {
    out.push({ key: 'reconciliation_difference', kind: 'reconciliation_difference', message: `The VAT accounts moved by a different amount from the VAT lines (difference ${wp.reconciliation.difference}); the entries listed with the reconciliation explain what they can` });
  }
  for (const r of wp.rules) if (superseded.has(r.rateId)) out.push({ key: `superseded_rate:${r.rateId}`, kind: 'superseded_rate', message: `VAT code ${r.code} used a rate version that has since been superseded` });
  if (box(4).greaterThan(box(1).plus(box(2)))) out.push({ key: 'repayment', kind: 'repayment', message: 'Input VAT (box 4) is more than output VAT (boxes 1 and 2): this is a repayment return' });
  if (wp.boxes.every((b) => money(b.amount).isZero())) out.push({ key: 'zero_return', kind: 'zero_return', message: 'Every box is zero' });
  for (const e of wp.reconciliation.explainedBy) {
    if (e.reason === LATE && e.journalDate > wp.to) out.push({ key: `late_posting:${e.journalId}:${e.lineNo}`, kind: 'late_posting', message: `Journal ${e.journalNumber} line ${e.lineNo} is dated ${e.journalDate}, after the period, with a tax point (${e.taxPoint}) inside it` });
  }
  return out;
}

export class VatReturnService {
  constructor(private readonly vat: VatService, private readonly opts: { captureDeviceMetadata?: boolean; today?: () => string } = {}) {}
  private today() { return this.opts.today?.() ?? ukToday(); }
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: VatActor, companyId: string, ...permissions: string[]) {
    if (actor.kind && actor.kind !== 'USER') throw forbidden('Only a person can act on a VAT return', 'ai_cannot_post');
    for (const p of permissions) if (!(await actor.can(p, companyId))) throw forbidden(`Requires permission ${p}`, 'permission_denied');
  }
  private async find(tx: Tx, companyId: string, id: string) {
    const r = await tx.vatReturn.findFirst({ where: { id, companyId } });
    if (!r) throw notFound('VAT return not found');
    return r;
  }
  /** The return as it stands: live workpaper and fingerprint (or the approved ones once locked), flags with their live explanation, status. */
  private async state(tx: Tx, r: ReturnRow) {
    const events = await tx.vatReturnEvent.findMany({ where: { vatReturnId: r.id }, orderBy: { seq: 'asc' } });
    const live = r.lockedAt
      ? { content: r.approvedContent as unknown as Workpaper, fingerprint: r.approvedFingerprint! }
      : vatFingerprint(await this.vat.workpaper(tx, r.companyId, { from: isoDay(r.periodFrom), to: isoDay(r.periodTo) }));
    const wp = live.content as unknown as Workpaper;
    const rateIds = wp.rules.map((x) => x.rateId);
    const superseded = new Set((await tx.taxRate.findMany({ where: { id: { in: rateIds }, supersededById: { not: null } }, select: { id: true } })).map((x) => x.id));
    const flags = vatFlags(wp, superseded).map((f) => {
      const e = events.filter((x) => x.kind === 'FLAG_EXPLAINED' && x.flagKey === f.key && x.fingerprint === live.fingerprint).at(-1);
      return { ...f, explanation: e ? { note: e.note!, byUserId: e.byUserId, at: e.at } : null };
    });
    const status = vatReturnStatus({ locked: !!r.lockedAt, fingerprint: live.fingerprint, events });
    return { events, wp, fingerprint: live.fingerprint, flags, status };
  }
  private view(r: ReturnRow, s: Awaited<ReturnType<VatReturnService['state']>>) {
    const ev = (e: EventRow) => ({ id: e.id, kind: e.kind, fingerprint: e.fingerprint, live: !!r.lockedAt || e.fingerprint === s.fingerprint, flagKey: e.flagKey, note: e.note, byUserId: e.byUserId, at: e.at,
      approverContactId: e.approverContactId, approvedOn: e.approvedOn ? isoDay(e.approvedOn) : null, evidenceDocumentId: e.evidenceDocumentId });
    return {
      id: r.id, companyId: r.companyId, periodFrom: isoDay(r.periodFrom), periodTo: isoDay(r.periodTo), obligationId: r.obligationId, status: s.status, fingerprint: s.fingerprint,
      locked: !!r.lockedAt, lockedAt: r.lockedAt, lockedByUserId: r.lockedByUserId, createdByUserId: r.createdByUserId, createdAt: r.createdAt,
      workpaper: s.wp, flags: s.flags, unexplainedFlags: s.flags.filter((f) => !f.explanation).length, events: s.events.map(ev),
      notice: 'VAT return for review and approval: not a submission. Nothing is sent to HMRC (DEC-082, DEC-086). Boxes 6 to 9 are exact here; whole-pound presentation is applied when the filing record is built (V5-M2).',
    };
  }

  async list(tx: Tx, companyId: string, q: { year?: number }) {
    const where = { companyId, ...(q.year ? { periodTo: { gte: toDate(`${q.year}-01-01`), lte: toDate(`${q.year}-12-31`) } } : {}) };
    const rows = await tx.vatReturn.findMany({ where, orderBy: { periodFrom: 'desc' } });
    const items = [];
    for (const r of rows) {
      const s = await this.state(tx, r);
      items.push({ id: r.id, periodFrom: isoDay(r.periodFrom), periodTo: isoDay(r.periodTo), status: s.status, locked: !!r.lockedAt, unexplainedFlags: s.flags.filter((f) => !f.explanation).length, obligationId: r.obligationId });
    }
    return { items };
  }
  async get(tx: Tx, companyId: string, id: string) {
    const r = await this.find(tx, companyId, id);
    return this.view(r, await this.state(tx, r));
  }

  /** Opens the return for the VAT period containing `date`; it links the client's VAT obligation for that period when there is one. */
  async create(tx: Tx, a: { organisationId: string; companyId: string; actor: VatActor; date: string }) {
    await this.need(a.actor, a.companyId, 'vat:prepare');
    const p = await this.vat.period(tx, a.companyId, a.date);
    const existing = await tx.vatReturn.findFirst({ where: { companyId: a.companyId, periodFrom: toDate(p.from) } });
    if (existing) throw conflict(`The VAT return for ${p.from} to ${p.to} already exists`, 'vat_return_exists', { id: existing.id });
    const obligation = await tx.complianceObligation.findFirst({ where: { companyId: a.companyId, kind: 'VAT_RETURN', periodEnd: toDate(p.to) }, orderBy: { createdAt: 'asc' } });
    let r: ReturnRow;
    try {
      r = await tx.vatReturn.create({ data: { organisationId: a.organisationId, companyId: a.companyId, periodFrom: toDate(p.from), periodTo: toDate(p.to), obligationId: obligation?.id ?? null, createdByUserId: a.actor.userId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict(`The VAT return for ${p.from} to ${p.to} already exists`, 'vat_return_exists');
      throw e;
    }
    await this.audit(tx, { action: 'vat.return_created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'vat_return', entityId: r.id,
      after: { periodFrom: p.from, periodTo: p.to, obligationId: r.obligationId } });
    return this.view(r, await this.state(tx, r));
  }

  private async event(tx: Tx, a: { organisationId: string; companyId: string; actor: VatActor; r: ReturnRow; kind: string; fingerprint: string; note?: string | null; flagKey?: string;
    approval?: { approverContactId: string; approvedOn: string; evidenceDocumentId: string } }) {
    try {
      return await tx.vatReturnEvent.create({ data: { organisationId: a.organisationId, companyId: a.companyId, vatReturnId: a.r.id, kind: a.kind, fingerprint: a.fingerprint, flagKey: a.flagKey ?? null,
        note: a.note?.trim() || null, byUserId: a.actor.userId, ...(a.approval ? { approverContactId: a.approval.approverContactId, approvedOn: toDate(a.approval.approvedOn), evidenceDocumentId: a.approval.evidenceDocumentId } : {}) } });
    } catch (e) {
      const msg = String((e as Error).message);
      if (msg.includes('someone other than the person who prepared')) throw forbidden('A VAT return is reviewed by someone other than the person who prepared it', 'self_review_not_allowed');
      if (msg.includes('takes no further events')) throw conflict('The VAT return is approved and frozen', 'vat_return_locked');
      throw e;
    }
  }
  private open(r: ReturnRow) { if (r.lockedAt) throw conflict('The VAT return is approved and frozen', 'vat_return_locked'); }

  /** Records that the return as it stands is prepared (vat:prepare). */
  async prepare(tx: Tx, a: { organisationId: string; companyId: string; actor: VatActor; id: string; note?: string }) {
    await this.need(a.actor, a.companyId, 'vat:prepare');
    const r = await this.find(tx, a.companyId, a.id);
    this.open(r);
    const s = await this.state(tx, r);
    if (s.status !== 'DRAFT') throw conflict('The VAT return as it stands is already prepared', 'already_prepared');
    const e = await this.event(tx, { ...a, r, kind: 'PREPARED', fingerprint: s.fingerprint, note: a.note });
    await this.audit(tx, { action: 'vat.return_prepared', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'vat_return', entityId: r.id,
      after: { eventId: e.id, fingerprint: s.fingerprint, flags: s.flags.map((f) => f.key), note: a.note ?? null } });
    return this.get(tx, a.companyId, r.id);
  }

  /** Explains one live review flag on the live fingerprint (vat:prepare or vat:review). */
  async explainFlag(tx: Tx, a: { organisationId: string; companyId: string; actor: VatActor; id: string; flagKey: string; explanation: string }) {
    if (a.actor.kind && a.actor.kind !== 'USER') throw forbidden('Only a person can act on a VAT return', 'ai_cannot_post');
    if (!(await a.actor.can('vat:prepare', a.companyId)) && !(await a.actor.can('vat:review', a.companyId))) throw forbidden('Requires permission vat:prepare or vat:review', 'permission_denied');
    const r = await this.find(tx, a.companyId, a.id);
    this.open(r);
    const s = await this.state(tx, r);
    const flag = s.flags.find((f) => f.key === a.flagKey);
    if (!flag) throw unprocessable('The return as it stands does not raise this flag', 'unknown_flag');
    const e = await this.event(tx, { ...a, r, kind: 'FLAG_EXPLAINED', fingerprint: s.fingerprint, flagKey: a.flagKey, note: a.explanation });
    await this.audit(tx, { action: 'vat.return_flag_explained', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'vat_return', entityId: r.id,
      after: { eventId: e.id, flagKey: a.flagKey, fingerprint: s.fingerprint }, reason: a.explanation.trim() });
    return this.get(tx, a.companyId, r.id);
  }

  /** The review (vat:review): a second person, on a live preparation, with every flag explained. */
  async review(tx: Tx, a: { organisationId: string; companyId: string; actor: VatActor; id: string; note?: string }) {
    await this.need(a.actor, a.companyId, 'vat:review');
    const r = await this.find(tx, a.companyId, a.id);
    this.open(r);
    const s = await this.state(tx, r);
    if (s.status === 'DRAFT') throw unprocessable('The VAT return as it stands is not prepared (or the ledger changed since it was)', 'not_prepared');
    if (s.status === 'REVIEWED') throw conflict('The VAT return as it stands is already reviewed', 'already_reviewed');
    const preparer = s.events.filter((e) => e.kind === 'PREPARED').at(-1)!;
    if (preparer.byUserId === a.actor.userId) throw forbidden('A VAT return is reviewed by someone other than the person who prepared it', 'self_review_not_allowed');
    const open = s.flags.filter((f) => !f.explanation);
    if (open.length) throw unprocessable(`Every review flag needs an explanation first: ${open.map((f) => f.key).join(', ')}`, 'flags_unexplained', { flags: open.map((f) => f.key) });
    const e = await this.event(tx, { ...a, r, kind: 'REVIEWED', fingerprint: s.fingerprint, note: a.note });
    await this.audit(tx, { action: 'vat.return_reviewed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'vat_return', entityId: r.id,
      after: { eventId: e.id, fingerprint: s.fingerprint, note: a.note ?? null } });
    return this.get(tx, a.companyId, r.id);
  }

  /**
   * The client's approval (vat:review and period:lock): on a live review, naming the client's contact, the date (after the period, not in the
   * future) and a readable evidence document of the client scanned clean. It freezes the return, locks the period and moves the obligation to READY.
   * Postings with VAT lines take the same advisory lock shared, so none commits between the fingerprint read here and the lock.
   */
  async clientApproval(tx: Tx, a: { organisationId: string; companyId: string; actor: VatActor; id: string; approverContactId: string; approvedOn: string; evidenceDocumentId: string; note?: string }) {
    await this.need(a.actor, a.companyId, 'vat:review', 'period:lock');
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'vatreturn:' + a.companyId}, 0))`;
    const r = await this.find(tx, a.companyId, a.id);
    this.open(r);
    const s = await this.state(tx, r);
    if (s.status !== 'REVIEWED') throw unprocessable('The VAT return as it stands is not reviewed (or the ledger changed since it was)', 'not_reviewed');
    const to = isoDay(r.periodTo);
    if (a.approvedOn <= to) throw unprocessable(`The client approves the return after the period ends (${to})`, 'approval_date_invalid');
    if (a.approvedOn > this.today()) throw unprocessable('An approval is recorded once it has happened, not before', 'approval_date_invalid');
    const contact = await tx.contact.findFirst({ where: { id: a.approverContactId, OR: [{ companyId: a.companyId }, { officers: { some: { companyId: a.companyId } } }] }, select: { id: true } });
    if (!contact) throw unprocessable("The approver must be one of the client's contacts or officers", 'approver_invalid');
    const evidence = await tx.document.findFirst({ where: { id: a.evidenceDocumentId, companyId: a.companyId, status: 'ACTIVE' },
      select: { id: true, companyId: true, visibility: true, createdByUserId: true, versions: { where: { status: 'AVAILABLE' }, select: { id: true }, take: 1 } } });
    const readable = evidence && (a.actor.canReadDocument ? await a.actor.canReadDocument(evidence) : await a.actor.can('document:read', a.companyId));
    if (!evidence || !readable || evidence.versions.length === 0) throw unprocessable('The evidence must be a document of the client with a version scanned clean', 'evidence_invalid');
    const e = await this.event(tx, { ...a, r, kind: 'CLIENT_APPROVED', fingerprint: s.fingerprint, note: a.note, approval: a });
    const content = vatFingerprint(s.wp as Workpaper);
    await tx.vatReturn.update({ where: { id: r.id }, data: { lockedAt: new Date(), lockedByUserId: a.actor.userId, approvedFingerprint: s.fingerprint, approvedContent: content.content as Prisma.InputJsonValue } });
    await this.audit(tx, { action: 'vat.return_client_approved', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'vat_return', entityId: r.id,
      after: { eventId: e.id, fingerprint: s.fingerprint, approverContactId: a.approverContactId, approvedOn: a.approvedOn, evidenceDocumentId: a.evidenceDocumentId, periodLocked: { from: isoDay(r.periodFrom), to } } });
    if (r.obligationId) {
      const o = await tx.complianceObligation.findFirst({ where: { id: r.obligationId } });
      if (o && !(FINAL_STATUSES as readonly string[]).includes(o.status) && o.status !== 'READY') {
        const reason = 'The client approved the VAT return';
        await tx.complianceObligation.update({ where: { id: o.id }, data: { version: o.version + 1, status: 'READY', statusReason: reason } });
        await this.audit(tx, { action: 'compliance.obligation_updated', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'compliance_obligation', entityId: o.id,
          before: { status: o.status, version: o.version }, after: { status: 'READY', version: o.version + 1 }, reason, metadata: { vatReturnId: r.id } });
      }
    }
    return this.get(tx, a.companyId, r.id);
  }
}
