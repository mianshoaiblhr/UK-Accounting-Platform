import { createHash } from 'node:crypto';
import { FINAL_STATUSES, canonicalJson, presentWholePounds, type VatPresentationMethod } from '@uk/contracts';
import { AppError, conflict, forbidden, notFound, unprocessable, uuidv7 } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import { ZERO, fmt, money, type Money } from './money';
import type { PostingService } from './posting';
import type { VatActor, VatService } from './vat';

/**
 * V5-M2 (DEC-091): the VAT filing record. There is no HMRC connection (DEC-082, DEC-086). An approved return (DEC-090) becomes a filing
 * package: boxes 1 to 5 exactly as approved, boxes 6 to 9 in whole pounds by the verified presentation rule covering the period end (no rule is
 * built in, DEC-021). A filing made outside the platform is RECORDED with HMRC's receipt reference and the receipt as evidence: it posts the
 * liability journal and closes the obligation. A SIMULATED filing goes through the HMRC VAT port (fake adapter only) and changes nothing else.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ukToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const VAT_PACKAGE_FORMAT = 'uk-vat-filing-package/1';
type RuleRow = Awaited<ReturnType<Tx['vatPresentationRule']['findUniqueOrThrow']>>;
type FilingRow = Awaited<ReturnType<Tx['vatFiling']['findUniqueOrThrow']>>;
type Source = { url: string; provision: string; retrievedOn: string };
type Boxes = Record<'1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9', string>;

/** The port the filing service calls; the adapters package implements it (only a fake exists). */
export interface VatFilingPort { readonly name: string; submitReturn(s: { vrn: string; periodFrom: string; periodTo: string; boxes: Boxes; finalised: true }): Promise<{ fake: boolean; processingDate: string; formBundleNumber: string; chargeRefNumber: string | null; paymentIndicator: string | null }> }

export const presentationRuleView = (r: RuleRow) => ({
  id: r.id, method: r.method as VatPresentationMethod, effectiveFrom: isoDay(r.effectiveFrom), effectiveTo: r.effectiveTo ? isoDay(r.effectiveTo) : null,
  source: { url: r.sourceUrl, provision: r.sourceProvision, retrievedOn: isoDay(r.sourceRetrievedOn) }, enteredByUserId: r.enteredByUserId, createdAt: r.createdAt,
  verificationStatus: r.verificationStatus, verifiedByUserId: r.verifiedByUserId, verifiedAt: r.verifiedAt, verificationNotes: r.verificationNotes, evidenceDocumentId: r.evidenceDocumentId, supersededById: r.supersededById,
});
export const filingView = (f: FilingRow) => ({
  id: f.id, vatReturnId: f.vatReturnId, mode: f.mode, submittedOn: isoDay(f.submittedOn), receiptReference: f.receiptReference, receipt: f.receipt, adapter: f.adapter,
  evidenceDocumentId: f.evidenceDocumentId, journalId: f.journalId, note: f.note, package: f.package, packageSha256: f.packageSha256, presentationRuleId: f.presentationRuleId, byUserId: f.byUserId, at: f.at,
  notice: f.mode === 'SIMULATED' ? 'SIMULATED: made through the fake HMRC adapter. Nothing was sent to HMRC and this is not a filing.' : 'Recorded filing: submitted to HMRC outside the platform; the receipt is the evidence.',
});

export class VatFilingService {
  constructor(private readonly vat: VatService, private readonly posting: PostingService, private readonly port: VatFilingPort | null,
    private readonly opts: { captureDeviceMetadata?: boolean; today?: () => string } = {}) {}
  private today() { return this.opts.today?.() ?? ukToday(); }
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: VatActor, companyId: string, permission: string) {
    if (actor.kind && actor.kind !== 'USER') throw forbidden('Only a person can act on VAT filings and rules', 'ai_cannot_post');
    if (!(await actor.can(permission, companyId))) throw forbidden(`Requires permission ${permission}`, 'permission_denied');
  }

  // ───── Presentation rules (organisation data; the DEC-021 pattern) ─────
  async listRules(tx: Tx) { return { items: (await tx.vatPresentationRule.findMany({ orderBy: [{ effectiveFrom: 'asc' }, { createdAt: 'asc' }] })).map(presentationRuleView) }; }
  private async insertRule(tx: Tx, a: { organisationId: string; userId: string; method: string; effectiveFrom: string; effectiveTo?: string | null; source: Source; id?: string }) {
    try {
      return await tx.vatPresentationRule.create({ data: { id: a.id, organisationId: a.organisationId, method: a.method, effectiveFrom: toDate(a.effectiveFrom), effectiveTo: a.effectiveTo ? toDate(a.effectiveTo) : null,
        sourceUrl: a.source.url, sourceProvision: a.source.provision, sourceRetrievedOn: toDate(a.source.retrievedOn), enteredByUserId: a.userId } });
    } catch (e) {
      if (String((e as Error).message).includes('overlaps another current version')) throw conflict('These dates overlap another current version; supersede that version first', 'presentation_rule_overlap');
      throw e;
    }
  }
  async addRule(tx: Tx, a: { organisationId: string; companyId: string; actor: VatActor; method: string; effectiveFrom: string; effectiveTo?: string; source: Source }) {
    await this.need(a.actor, a.companyId, 'vat:manage');
    const r = await this.insertRule(tx, { ...a, userId: a.actor.userId });
    await this.audit(tx, { action: 'vat.presentation_rule_added', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'vat_presentation_rule', entityId: r.id,
      after: { method: a.method, effectiveFrom: a.effectiveFrom, effectiveTo: a.effectiveTo ?? null, source: a.source, verification: 'UNVERIFIED' } });
    return presentationRuleView(r);
  }
  async supersedeRule(tx: Tx, a: { organisationId: string; companyId: string; actor: VatActor; id: string; method: string; effectiveFrom: string; effectiveTo?: string; source: Source; reason: string }) {
    await this.need(a.actor, a.companyId, 'vat:manage');
    const old = await tx.vatPresentationRule.findFirst({ where: { id: a.id } });
    if (!old) throw notFound('Presentation rule not found');
    if (old.supersededById) throw conflict('This version was already superseded', 'presentation_rule_superseded');
    const newId = uuidv7();
    await tx.vatPresentationRule.update({ where: { id: old.id }, data: { supersededById: newId } });
    const r = await this.insertRule(tx, { ...a, id: newId, userId: a.actor.userId });
    await this.audit(tx, { action: 'vat.presentation_rule_superseded', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'vat_presentation_rule', entityId: old.id,
      before: presentationRuleView(old), after: presentationRuleView(r), reason: a.reason.trim() });
    return presentationRuleView(r);
  }
  async verifyRule(tx: Tx, a: { organisationId: string; companyId: string; actor: VatActor; id: string; notes: string; evidenceDocumentId?: string }) {
    await this.need(a.actor, a.companyId, 'tax:rule-verify');
    const r = await tx.vatPresentationRule.findFirst({ where: { id: a.id } });
    if (!r) throw notFound('Presentation rule not found');
    if (r.supersededById) throw conflict('A superseded version cannot be verified', 'presentation_rule_superseded');
    if (r.verificationStatus === 'VERIFIED') throw conflict('This version is already verified', 'already_verified');
    if (r.enteredByUserId === a.actor.userId) throw forbidden('A presentation rule must be verified by someone other than the person who entered it', 'self_verification_not_allowed');
    if (a.evidenceDocumentId) {
      const d = await tx.document.findFirst({ where: { id: a.evidenceDocumentId }, select: { id: true, companyId: true, visibility: true, createdByUserId: true } });
      const ok = d && (a.actor.canReadDocument ? await a.actor.canReadDocument(d) : await a.actor.can('document:read', d.companyId ?? a.companyId));
      if (!ok) throw unprocessable('The evidence document does not exist', 'invalid_evidence');
    }
    const v = await tx.vatPresentationRule.update({ where: { id: r.id }, data: { verificationStatus: 'VERIFIED', verifiedByUserId: a.actor.userId, verifiedAt: new Date(), verificationNotes: a.notes.trim(), evidenceDocumentId: a.evidenceDocumentId ?? null } });
    await this.audit(tx, { action: 'vat.presentation_rule_verified', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'vat_presentation_rule', entityId: r.id,
      before: { verification: 'UNVERIFIED' }, after: { verification: 'VERIFIED', method: r.method, source: { url: r.sourceUrl, provision: r.sourceProvision } }, reason: a.notes.trim() });
    return presentationRuleView(v);
  }

  // ───── The filing package ─────
  /** The package of an approved return: boxes 1 to 5 as approved, 6 to 9 by the verified rule covering the period end. */
  async package(tx: Tx, companyId: string, returnId: string) {
    const r = await tx.vatReturn.findFirst({ where: { id: returnId, companyId } });
    if (!r) throw notFound('VAT return not found');
    if (!r.lockedAt) throw unprocessable('Only an approved VAT return is filed', 'not_approved');
    const end = r.periodTo;
    const rules = await tx.vatPresentationRule.findMany({ where: { supersededById: null, effectiveFrom: { lte: end }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: end } }] } });
    const rule = rules[0];
    if (!rule || rule.verificationStatus !== 'VERIFIED') {
      throw unprocessable(rule ? `The presentation rule for boxes 6 to 9 covering ${isoDay(end)} has not been verified (DEC-021)` : `No presentation rule for boxes 6 to 9 covers ${isoDay(end)}; enter one and have it verified`,
        'presentation_rule_unverified', rule ? { ruleId: rule.id } : undefined);
    }
    const wp = r.approvedContent as unknown as { vrn: string | null; currency: string; boxes: { box: number; amount: string; direction?: string }[] };
    const amt = (n: number) => wp.boxes.find((b) => b.box === n)!.amount;
    const box5 = wp.boxes.find((b) => b.box === 5)!;
    const method = rule.method as VatPresentationMethod;
    const boxes: Boxes = { 1: amt(1), 2: amt(2), 3: amt(3), 4: amt(4), 5: amt(5), 6: presentWholePounds(amt(6), method), 7: presentWholePounds(amt(7), method), 8: presentWholePounds(amt(8), method), 9: presentWholePounds(amt(9), method) };
    const pkg = { format: VAT_PACKAGE_FORMAT, companyId, vatReturnId: r.id, vrn: wp.vrn, currency: wp.currency, periodFrom: isoDay(r.periodFrom), periodTo: isoDay(r.periodTo),
      approvedFingerprint: r.approvedFingerprint!, boxes, box5Direction: box5.direction ?? 'PAYABLE', presentation: { ruleId: rule.id, method } };
    return { package: pkg, sha256: createHash('sha256').update(canonicalJson(pkg)).digest('hex'), rule, ret: r };
  }
  async getPackage(tx: Tx, companyId: string, returnId: string) {
    const p = await this.package(tx, companyId, returnId);
    return { package: p.package, sha256: p.sha256, notice: 'The filing package of the approved return. Nothing is sent to HMRC from the platform.' };
  }
  async listFilings(tx: Tx, companyId: string, returnId: string) {
    if (!(await tx.vatReturn.findFirst({ where: { id: returnId, companyId }, select: { id: true } }))) throw notFound('VAT return not found');
    return { items: (await tx.vatFiling.findMany({ where: { vatReturnId: returnId }, orderBy: { at: 'asc' } })).map(filingView) };
  }

  /**
   * Records a filing made outside the platform (vat:file): HMRC's receipt reference and the receipt as evidence. In the same transaction it posts
   * the liability journal at the period end and marks the client's VAT obligation DONE. One recorded filing per return.
   */
  async record(tx: Tx, a: { organisationId: string; companyId: string; actor: VatActor; id: string; submittedOn: string; receiptReference: string; evidenceDocumentId: string; note?: string }) {
    await this.need(a.actor, a.companyId, 'vat:file');
    const p = await this.package(tx, a.companyId, a.id);
    if (await tx.vatFiling.findFirst({ where: { vatReturnId: a.id, mode: 'RECORDED' }, select: { id: true } })) throw conflict('A filing of this return is already recorded', 'already_filed');
    const approval = await tx.vatReturnEvent.findFirst({ where: { vatReturnId: a.id, kind: 'CLIENT_APPROVED' }, orderBy: { seq: 'desc' } });
    const approvedOn = approval?.approvedOn ? isoDay(approval.approvedOn) : isoDay(p.ret.lockedAt!);
    if (a.submittedOn < approvedOn) throw unprocessable(`A return is submitted after the client approved it (${approvedOn})`, 'submission_date_invalid');
    if (a.submittedOn > this.today()) throw unprocessable('A filing is recorded once it has happened, not before', 'submission_date_invalid');
    const evidence = await tx.document.findFirst({ where: { id: a.evidenceDocumentId, companyId: a.companyId, status: 'ACTIVE' },
      select: { id: true, companyId: true, visibility: true, createdByUserId: true, versions: { where: { status: 'AVAILABLE' }, select: { id: true }, take: 1 } } });
    const readable = evidence && (a.actor.canReadDocument ? await a.actor.canReadDocument(evidence) : await a.actor.can('document:read', a.companyId));
    if (!evidence || !readable || evidence.versions.length === 0) throw unprocessable('The evidence must be a document of the client with a version scanned clean', 'evidence_invalid');
    const settings = await this.vat.getSettings(tx, a.companyId);
    if (!settings.liabilityAccountId || !settings.outputAccountId || !settings.inputAccountId) throw unprocessable('Set the VAT liability account in the VAT settings before recording a filing', 'liability_account_missing');

    // the liability journal: output VAT (box 3) and input VAT (box 4) moved to the liability account (box 5, signed)
    const company = await tx.company.findUniqueOrThrow({ where: { id: a.companyId }, select: { baseCurrency: true } });
    const minor = (await tx.currency.findUnique({ where: { code: company.baseCurrency } }))?.minorUnits ?? 2;
    const b3 = money(p.package.boxes[3]), b4 = money(p.package.boxes[4]), net = b3.minus(b4);
    const side = (accountId: string, debit: Money, description: string) => ({ accountId, debit: fmt(debit.isNegative() ? ZERO : debit, minor), credit: fmt(debit.isNegative() ? debit.abs() : ZERO, minor), description });
    const lines = [
      ...(b3.isZero() ? [] : [side(settings.outputAccountId, b3, 'Output VAT for the period (box 3)')]),
      ...(b4.isZero() ? [] : [side(settings.inputAccountId, b4.negated(), 'Input VAT for the period (box 4)')]),
      ...(net.isZero() ? [] : [side(settings.liabilityAccountId, net.negated(), net.isNegative() ? 'VAT repayable by HMRC (box 5)' : 'VAT payable to HMRC (box 5)')]),
    ];
    const id = uuidv7();
    let journalId: string | null = null;
    if (lines.length) {
      const j = await this.posting.post(tx, { organisationId: a.organisationId, companyId: a.companyId, journalDate: p.package.periodTo, sourceType: 'VAT_RETURN', sourceId: id,
        sourceReference: `VAT ${p.package.periodTo} ${a.receiptReference}`, description: `VAT return ${p.package.periodFrom} to ${p.package.periodTo} filed (HMRC receipt ${a.receiptReference})`,
        idempotencyKey: `vat-filing:${id}`, actor: { kind: 'USER', userId: a.actor.userId, can: (perm, companyId) => a.actor.can(perm, companyId) }, lines });
      journalId = j.id;
    }
    let f: FilingRow;
    try {
      f = await tx.vatFiling.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, vatReturnId: a.id, mode: 'RECORDED', package: p.package as Prisma.InputJsonValue, packageSha256: p.sha256,
        presentationRuleId: p.rule.id, submittedOn: toDate(a.submittedOn), receiptReference: a.receiptReference, evidenceDocumentId: a.evidenceDocumentId, journalId, note: a.note?.trim() || null, byUserId: a.actor.userId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('A filing of this return is already recorded', 'already_filed');
      throw e;
    }
    await this.audit(tx, { action: 'vat.filing_recorded', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'vat_filing', entityId: f.id,
      after: { vatReturnId: a.id, submittedOn: a.submittedOn, receiptReference: a.receiptReference, evidenceDocumentId: a.evidenceDocumentId, journalId, packageSha256: p.sha256, presentationRuleId: p.rule.id } });
    if (p.ret.obligationId) {
      const o = await tx.complianceObligation.findFirst({ where: { id: p.ret.obligationId } });
      if (o && !(FINAL_STATUSES as readonly string[]).includes(o.status)) {
        await tx.complianceObligation.update({ where: { id: o.id }, data: { version: o.version + 1, status: 'DONE', doneOn: toDate(a.submittedOn), doneReference: a.receiptReference, evidenceDocumentId: a.evidenceDocumentId, statusReason: null } });
        await this.audit(tx, { action: 'compliance.obligation_updated', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'compliance_obligation', entityId: o.id,
          before: { status: o.status, version: o.version }, after: { status: 'DONE', doneOn: a.submittedOn, doneReference: a.receiptReference, evidenceDocumentId: a.evidenceDocumentId, version: o.version + 1 },
          reason: 'The VAT return filing was recorded', metadata: { vatFilingId: f.id } });
      }
    }
    return filingView(f);
  }

  /** A simulated submission through the HMRC VAT port (fake adapter only). It records the fake receipt and changes nothing else. */
  async simulate(tx: Tx, a: { organisationId: string; companyId: string; actor: VatActor; id: string }) {
    await this.need(a.actor, a.companyId, 'vat:file');
    if (!this.port) throw new AppError(503, 'filing_not_available', 'No HMRC VAT adapter is configured: the platform does not submit to HMRC (DEC-082, DEC-086)');
    const p = await this.package(tx, a.companyId, a.id);
    if (!p.package.vrn) throw unprocessable('The approved return has no VAT registration number', 'not_vat_registered');
    const receipt = await this.port.submitReturn({ vrn: p.package.vrn, periodFrom: p.package.periodFrom, periodTo: p.package.periodTo, boxes: p.package.boxes, finalised: true });
    const f = await tx.vatFiling.create({ data: { organisationId: a.organisationId, companyId: a.companyId, vatReturnId: a.id, mode: 'SIMULATED', package: p.package as Prisma.InputJsonValue, packageSha256: p.sha256,
      presentationRuleId: p.rule.id, submittedOn: toDate(this.today()), receiptReference: receipt.formBundleNumber, receipt: receipt as unknown as Prisma.InputJsonValue, adapter: this.port.name, byUserId: a.actor.userId } });
    await this.audit(tx, { action: 'vat.filing_simulated', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'vat_filing', entityId: f.id,
      after: { vatReturnId: a.id, adapter: this.port.name, receiptReference: receipt.formBundleNumber, fake: receipt.fake, packageSha256: p.sha256 } });
    return filingView(f);
  }
}
