import { createHash } from 'node:crypto';
import { CT600_FIELDS, CT_IXBRL_KEYS, CT_RULE_PARAMETERS, FINAL_STATUSES, canonicalJson } from '@uk/contracts';
import { AppError, conflict, forbidden, notFound, unprocessable } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import type { CorporationTaxService, CtActor } from './corporation-tax';
import type { CtComputationService } from './ct-computation';
import { conceptEntryView } from './ixbrl';

/**
 * V4-M5 (DEC-102): the CT return of an approved computation (DEC-101): the canonical CT600 with its boxes (a verified CT600_FORM rule), the
 * computation as inline XBRL (a verified CT-COMP taxonomy version), and the accounts' latest VALID iXBRL document (DEC-094). It moves DRAFT ->
 * VALIDATED -> AUTHORISED -> SUBMITTED -> ACCEPTED / REJECTED through the HMRC port, whose only adapter is a fake (production refuses it), or is
 * recorded as filed elsewhere. Mirrors the Companies House filing (DEC-095). Nothing here changes an accounting record or a computation.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ukToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const SPEC_NAMESPACES: Record<string, string> = {
  ix: 'http://www.xbrl.org/2013/inlineXBRL', ixt: 'http://www.xbrl.org/inlineXBRL/transformation/2020-02-12', xbrli: 'http://www.xbrl.org/2003/instance',
  link: 'http://www.xbrl.org/2003/linkbase', xlink: 'http://www.w3.org/1999/xlink', xbrldi: 'http://xbrl.org/2006/xbrldi', iso4217: 'http://www.xbrl.org/2003/iso4217',
};
const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const grouped = (abs: string) => { const [i, f] = abs.split('.'); return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f !== undefined ? `.${f}` : ''}`; };
const LABELS: Record<string, string> = {
  turnover: 'Turnover', tradingProfits: 'Trading profits', tradingLossesBroughtForwardUsed: 'Trading losses brought forward used', netTradingProfits: 'Net trading profits',
  nonTradingLoanRelationships: 'Non-trading loan relationships', propertyIncome: 'Property income', chargeableGains: 'Chargeable gains', lossCarriedBackFromLaterPeriod: 'Loss carried back from a later period',
  taxableTotalProfits: 'Taxable total profits', associatedCompanies: 'Associated companies', corporationTaxChargeable: 'Corporation tax chargeable', taxPayable: 'Tax payable',
  'losses.tradingLossOfPeriod': 'Trading loss of the period', 'losses.carriedBack': 'Loss carried back', 'losses.carriedForward': 'Losses carried forward',
};
const fyLabel = (f: string) => { const [p, k] = f.split('.'); return `Financial year ${p === 'fy1' ? 'one' : 'two'}: ${({ financialYear: 'year', profit: 'profit', rate: 'rate %', taxAtRate: 'tax at the rate', marginalRelief: 'marginal relief' } as Record<string, string>)[k!]}`; };

type Entry = ReturnType<typeof conceptEntryView>;
export interface CtIxbrlInput {
  taxonomy: { entryPoint: string; entityScheme: string | null; namespaces: Record<string, string>; entries: Entry[] };
  company: { name: string; utr: string | null }; currency: string; period: { start: string; end: string }; fyParts: { from: string; to: string }[];
  /** The canonical CT600 values by field (DEC-101). */
  values: Record<string, string>;
}

/** The computation as an inline XBRL document. Pure: the same input gives the same document and SHA-256. */
export function buildCtIxbrl(i: CtIxbrlInput) {
  const errors: string[] = [], warnings: string[] = [];
  const ns = i.taxonomy.namespaces;
  for (const p of Object.keys(ns)) if (Object.prototype.hasOwnProperty.call(SPEC_NAMESPACES, p)) errors.push(`The taxonomy version declares the prefix "${p}", which the inline XBRL specification uses`);
  if (!i.company.utr) errors.push('The company has no UTR: the entity identifier needs it');
  if (!i.taxonomy.entityScheme) errors.push('The taxonomy version has no entity identifier scheme');
  if (!/^[A-Z]{3}$/.test(i.currency)) errors.push(`The currency ${i.currency} is not an ISO 4217 code`);
  const ctx = new Map<string, { start?: string; end?: string; instant?: string }>();
  const ctxOf = (field: string, periodType: string) => {
    const m = /^fy([12])\./.exec(field), part = m ? i.fyParts[Number(m[1]) - 1] : null;
    if (m && !part) return null;
    const p = periodType === 'INSTANT' ? { instant: part?.to ?? i.period.end } : { start: part?.from ?? i.period.start, end: part?.to ?? i.period.end };
    const k = JSON.stringify(p);
    if (!ctx.has(k)) ctx.set(k, p);
    return k;
  };
  const facts = new Map<string, { e: Entry; ctx: string; value: string; display: string; negative: boolean }>();
  for (const e of i.taxonomy.entries) {
    if (e.sourceKind !== 'FACT' || !CT_IXBRL_KEYS.includes(e.sourceKey)) { errors.push(`${e.sourceKind} ${e.sourceKey} is not a key of the computation (ct.<field>)`); continue; }
    const field = e.sourceKey.slice(3), raw = i.values[field], c = raw === undefined ? null : ctxOf(field, e.periodType);
    if (raw === undefined || raw === null || raw === '' || !c) { if (e.mandatory) errors.push(`The mandatory ${e.sourceKey} (${e.concept}) has no value`); continue; }
    if (e.dataType === 'MONETARY') {
      if (!/^-?\d+(\.\d+)?$/.test(raw)) { errors.push(`${e.sourceKey} is not an amount`); continue; }
      const neg = raw.startsWith('-') !== e.negate && !/^-?0+(\.0+)?$/.test(raw), abs = raw.replace('-', '');
      const d = Math.max(e.decimals ?? 2, 0), fixed = (Number(abs)).toFixed(d);
      facts.set(field, { e, ctx: c, value: `${neg ? '-' : ''}${fixed}`, display: grouped(fixed), negative: neg });
    } else facts.set(field, { e, ctx: c, value: raw, display: raw, negative: false });
  }
  const ctxIds = new Map([...ctx.keys()].sort().map((k, n) => [k, `C${n + 1}`]));
  const unit = `U-${i.currency}`;
  const show = (field: string, plain: string) => {
    const f = facts.get(field);
    if (!f) return esc(plain);
    const name = esc(f.e.concept), ref = ctxIds.get(f.ctx)!;
    if (f.e.dataType === 'MONETARY') return `${f.negative ? '(' : ''}<ix:nonFraction name="${name}" contextRef="${ref}" unitRef="${esc(unit)}" decimals="${f.e.decimals}" scale="0" format="ixt:num-dot-decimal"${f.negative ? ' sign="-"' : ''}>${esc(f.display)}</ix:nonFraction>${f.negative ? ')' : ''}`;
    return `<ix:nonNumeric name="${name}" contextRef="${ref}"${f.e.dataType === 'DATE' ? ' format="ixt:date-year-month-day"' : ''}>${esc(f.display)}</ix:nonNumeric>`;
  };
  const rows = CT600_FIELDS.filter((f) => i.values[f] !== undefined).map((f) => `<tr><td>${esc(LABELS[f] ?? fyLabel(f))}</td><td class="num">${show(f, i.values[f]!)}</td></tr>`);
  const contexts = [...ctx.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, p]) => [
    `<xbrli:context id="${ctxIds.get(k)}"><xbrli:entity><xbrli:identifier scheme="${esc(i.taxonomy.entityScheme ?? '')}">${esc(i.company.utr ?? '')}</xbrli:identifier></xbrli:entity><xbrli:period>`,
    p.instant ? `<xbrli:instant>${p.instant}</xbrli:instant>` : `<xbrli:startDate>${p.start}</xbrli:startDate><xbrli:endDate>${p.end}</xbrli:endDate>`, '</xbrli:period></xbrli:context>',
  ].join('')).join('\n');
  const xmlns = Object.entries({ ...SPEC_NAMESPACES, ...ns }).map(([p, u]) => ` xmlns:${p}="${esc(u)}"`).join('');
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>', `<html xmlns="http://www.w3.org/1999/xhtml"${xmlns}>`,
    `<head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/><title>${esc(i.company.name)} - Corporation Tax computation for the period ending ${esc(i.period.end)}</title>`,
    '<style>body{font-family:Arial,sans-serif;margin:32px;color:#172231}table{border-collapse:collapse}td{padding:4px 12px;border-bottom:1px solid #e1e6ec}.num{text-align:right}</style></head>',
    '<body>', '<div style="display:none"><ix:header>',
    `<ix:references><link:schemaRef xlink:type="simple" xlink:href="${esc(i.taxonomy.entryPoint)}"/></ix:references>`,
    `<ix:resources>\n${contexts}\n<xbrli:unit id="${esc(unit)}"><xbrli:measure>iso4217:${esc(i.currency)}</xbrli:measure></xbrli:unit>\n</ix:resources>`,
    '</ix:header></div>',
    `<h1>${esc(i.company.name)}</h1>`, `<p>Corporation Tax computation for the period ${esc(i.period.start)} to ${esc(i.period.end)}; UTR ${esc(i.company.utr ?? '')}</p>`,
    '<table><tbody>', ...rows, '</tbody></table>', '</body></html>', '',
  ].join('\n');
  if (!facts.size) warnings.push('The document tags nothing');
  return { content, sha256: createHash('sha256').update(content).digest('hex'), factCount: facts.size, contextCount: ctx.size, errors, warnings };
}

type ReturnRow = Awaited<ReturnType<Tx['ctReturn']['findUniqueOrThrow']>>;
type EventRow = Awaited<ReturnType<Tx['ctReturnEvent']['findUniqueOrThrow']>>;
/** The port the workflow calls; the adapters package implements it (only a fake exists). */
export interface CtFilingPort {
  readonly name: string;
  submit(s: { utr: string; periodEnd: string; payloadSha256: string; idempotencyKey: string; package: Record<string, unknown> }): Promise<{ submissionId: string; request: Record<string, unknown>; response: Record<string, unknown> }>;
  status(submissionId: string, utr: string): Promise<{ status: 'PENDING' | 'ACCEPTED' | 'REJECTED'; reference: string | null; reasons: string[]; response: Record<string, unknown> }>;
}
const returnView = (r: ReturnRow, events: EventRow[] = [], withContent = false) => ({
  id: r.id, companyId: r.companyId, periodId: r.periodId, computationId: r.computationId, accountsIxbrlDocumentId: r.accountsIxbrlDocumentId, status: r.status, mode: r.mode, payloadSha256: r.payloadSha256,
  computationIxbrlSha256: r.computationIxbrlSha256, package: r.package as Record<string, unknown>, createdByUserId: r.createdByUserId, createdAt: r.createdAt, validatedByUserId: r.validatedByUserId,
  authority: r.authorisedByUserId ? { byUserId: r.authorisedByUserId, directorContactId: r.directorContactId, declaredOn: isoDay(r.declaredOn!), evidenceDocumentId: r.authorityEvidenceId } : null,
  submissionId: r.submissionId, hmrcReference: r.hmrcReference, acceptedOn: r.acceptedOn ? isoDay(r.acceptedOn) : null, acceptanceEvidenceId: r.acceptanceEvidenceId,
  rejectionReasons: (r.rejectionReasons as string[] | null) ?? [], updatedAt: r.updatedAt, ...(withContent ? { computationIxbrl: r.computationIxbrl } : {}),
  events: events.map((e) => ({ id: e.id, fromStatus: e.fromStatus, toStatus: e.toStatus, payloadSha256: e.payloadSha256, submissionId: e.submissionId, request: e.request, response: e.response, note: e.note, byUserId: e.byUserId, at: e.at })),
  notice: r.mode === 'RECORDED' ? 'Filed outside the platform and recorded with its evidence.' : 'Through the HMRC connection, which in this version is a test stand-in: nothing reaches HMRC.',
});

export class CtReturnService {
  constructor(private readonly ct: CorporationTaxService, private readonly comp: CtComputationService, private readonly port: CtFilingPort | null,
    private readonly opts: { captureDeviceMetadata?: boolean; today?: () => string } = {}) {}
  private today() { return this.opts.today?.() ?? ukToday(); }
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: CtActor, companyId: string) {
    if (actor.kind && actor.kind !== 'USER') throw forbidden('Only a person can act on a CT return', 'ai_cannot_post');
    if (!(await actor.can('ct:file', companyId))) throw forbidden('Requires permission ct:file', 'permission_denied');
  }
  private async find(tx: Tx, companyId: string, id: string) {
    const r = await tx.ctReturn.findFirst({ where: { id, companyId } });
    if (!r) throw notFound('CT return not found', 'ct_return_not_found');
    return r;
  }
  private expect(r: ReturnRow, ...statuses: string[]) {
    if (!statuses.includes(r.status)) throw conflict(`The return is ${r.status}; this step needs it ${statuses.join(' or ')}`, 'return_wrong_status', { status: r.status });
  }
  private notAvailable() { return new AppError(503, 'filing_not_available', 'No HMRC Corporation Tax adapter is configured: the platform does not file with HMRC'); }
  private async move(tx: Tx, a: { organisationId: string; actor: CtActor; r: ReturnRow; to: string; data?: Prisma.CtReturnUncheckedUpdateInput; submissionId?: string | null;
    request?: Record<string, unknown>; response?: Record<string, unknown>; note?: string }) {
    const after = await tx.ctReturn.update({ where: { id: a.r.id }, data: { status: a.to, ...(a.data ?? {}) } });
    await tx.ctReturnEvent.create({ data: { organisationId: a.organisationId, companyId: a.r.companyId, returnId: a.r.id, fromStatus: a.r.status, toStatus: a.to, payloadSha256: a.r.payloadSha256,
      submissionId: a.submissionId ?? null, request: (a.request as Prisma.InputJsonValue) ?? Prisma.DbNull, response: (a.response as Prisma.InputJsonValue) ?? Prisma.DbNull, note: a.note?.trim() || null, byUserId: a.actor.userId } });
    await this.audit(tx, { action: `ct_return.${a.to.toLowerCase()}`, organisationId: a.organisationId, companyId: a.r.companyId, actorUserId: a.actor.userId, entityType: 'ct_return', entityId: a.r.id,
      before: { status: a.r.status }, after: { status: a.to, submissionId: after.submissionId, hmrcReference: after.hmrcReference }, reason: a.note?.trim() || null });
    return after;
  }
  private async evidence(tx: Tx, actor: CtActor, companyId: string, id: string) {
    const d = await tx.document.findFirst({ where: { id, companyId, status: 'ACTIVE' },
      select: { id: true, companyId: true, visibility: true, createdByUserId: true, versions: { where: { status: 'AVAILABLE' }, select: { id: true }, take: 1 } } });
    const readable = d && (actor.canReadDocument ? await actor.canReadDocument(d) : await actor.can('document:read', companyId));
    if (!d || !readable || d.versions.length === 0) throw unprocessable('The evidence must be a document of the company with a version scanned clean', 'evidence_invalid');
  }
  /** The accounts' latest VALID iXBRL document of the accounts year that contains the CT period. */
  private async accountsIxbrl(tx: Tx, frameworkId: string) {
    const packages = (await tx.accountsPackage.findMany({ where: { frameworkId }, select: { id: true } })).map((p) => p.id);
    return tx.ixbrlDocument.findFirst({ where: { packageId: { in: packages }, status: 'VALID' }, orderBy: [{ at: 'desc' }, { id: 'desc' }] });
  }
  /** On ACCEPTED: the CT_RETURN obligation of the CT period's end becomes DONE (V7-M1), versioned and audited. */
  private async closeObligation(tx: Tx, a: { organisationId: string; actor: CtActor; r: ReturnRow; acceptedOn: string; reference: string; evidenceId: string | null }) {
    const p = await tx.ctPeriod.findFirstOrThrow({ where: { id: a.r.periodId }, select: { endDate: true } });
    const o = await tx.complianceObligation.findFirst({ where: { companyId: a.r.companyId, kind: 'CT_RETURN', periodEnd: p.endDate }, orderBy: { createdAt: 'asc' } });
    if (!o || (FINAL_STATUSES as readonly string[]).includes(o.status)) return;
    await tx.complianceObligation.update({ where: { id: o.id }, data: { version: o.version + 1, status: 'DONE', doneOn: toDate(a.acceptedOn), doneReference: a.reference.slice(0, 200), evidenceDocumentId: a.evidenceId, statusReason: null } });
    await this.audit(tx, { action: 'compliance.obligation_updated', organisationId: a.organisationId, companyId: a.r.companyId, actorUserId: a.actor.userId, entityType: 'compliance_obligation', entityId: o.id,
      before: { status: o.status, version: o.version }, after: { status: 'DONE', doneOn: a.acceptedOn, doneReference: a.reference, version: o.version + 1 }, reason: 'HMRC accepted the Company Tax Return', metadata: { ctReturnId: a.r.id } });
  }

  async list(tx: Tx, companyId: string) {
    return { items: (await tx.ctReturn.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' } })).map((r) => returnView(r)) };
  }
  async get(tx: Tx, companyId: string, id: string, withContent = false) {
    const r = await this.find(tx, companyId, id);
    return returnView(r, await tx.ctReturnEvent.findMany({ where: { returnId: id }, orderBy: { seq: 'asc' } }), withContent);
  }

  /** DRAFT: the package is built now and frozen; a package with problems is refused, so a draft can always go on. */
  async create(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; computationId: string }) {
    await this.need(a.actor, a.companyId);
    const c = await tx.ctComputation.findFirst({ where: { id: a.computationId, companyId: a.companyId } });
    if (!c) throw notFound('Computation not found', 'computation_not_found');
    if (c.status !== 'APPROVED' || c.supersededById) throw unprocessable('A return files the current approved computation of its period', 'computation_not_approved');
    if (await tx.ctReturn.findFirst({ where: { companyId: a.companyId, periodId: c.periodId, status: 'ACCEPTED' }, select: { id: true } })) throw conflict('A return of this period was already accepted', 'already_filed');
    const period = await this.ct.getPeriod(tx, a.companyId, c.periodId);
    const start = isoDay(period.startDate), end = isoDay(period.endDate);
    const ct600 = await this.comp.ct600(tx, a.companyId, c.periodId);
    const problems: string[] = [];
    // the canonical fields, flattened: fy1.* and fy2.* for the financial-year parts, losses.* for the losses
    const values: Record<string, string> = {};
    for (const f of CT600_FIELDS) {
      const [head, tail] = f.split('.');
      const v = head === 'fy1' || head === 'fy2' ? (ct600.financialYears[head === 'fy1' ? 0 : 1] as Record<string, unknown> | undefined)?.[tail!] : tail ? (ct600 as unknown as Record<string, Record<string, unknown>>)[head!]?.[tail] : (ct600 as unknown as Record<string, unknown>)[head!];
      if (v !== undefined && v !== null) values[f] = String(v);
    }
    const form = CT_RULE_PARAMETERS.CT600_FORM.parse((await this.ct.ruleFor(tx, 'CT600_FORM', end)).parameters);
    const boxes = CT600_FIELDS.filter((f) => values[f] !== undefined).map((f) => ({ field: f, box: form.boxes[f] ?? null, value: values[f]! }));
    for (const b of boxes) if (b.box === null && !/^-?0+(\.0+)?$/.test(b.value)) problems.push(`The CT600 form version ${form.formVersion} has no box for ${b.field}, which has a value`);
    const version = await tx.xbrlTaxonomyVersion.findFirst({ where: { standardCode: 'CT-COMP', status: 'VERIFIED', effectiveFrom: { lte: period.endDate }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: period.endDate } }] }, orderBy: { effectiveFrom: 'desc' } });
    let doc: ReturnType<typeof buildCtIxbrl> | null = null;
    if (!version) problems.push('There is no verified CT-COMP taxonomy version for the period');
    else {
      const entries = (await tx.xbrlConceptMap.findMany({ where: { versionId: version.id } })).map(conceptEntryView);
      const company = await tx.company.findFirstOrThrow({ where: { id: a.companyId }, select: { name: true, baseCurrency: true } });
      doc = buildCtIxbrl({ taxonomy: { entryPoint: version.entryPoint, entityScheme: version.entityScheme, namespaces: version.namespaces as Record<string, string>, entries },
        company: { name: company.name, utr: ct600.company.utr }, currency: company.baseCurrency, period: { start, end },
        fyParts: (c.snapshot as { result: { financialYears: { from: string; to: string }[] } }).result.financialYears.map((y) => ({ from: y.from, to: y.to })), values });
      problems.push(...doc.errors.map((e) => `Computation iXBRL: ${e}`));
    }
    const accounts = await this.accountsIxbrl(tx, period.frameworkId);
    if (!accounts) problems.push('The accounts of the year have no VALID iXBRL document');
    if (problems.length) throw unprocessable('The return cannot be started while something needs attention', 'ct_return_problems', { problems });
    const pkg = { format: 'uk-ct-return-package/1', ct600, form: { formVersion: form.formVersion, boxes }, computationIxbrl: { taxonomyVersionId: version!.id, sha256: doc!.sha256, factCount: doc!.factCount, warnings: doc!.warnings },
      accountsIxbrl: { documentId: accounts!.id, sha256: accounts!.sha256 } };
    const payloadSha256 = createHash('sha256').update(canonicalJson(pkg)).digest('hex');
    let r: ReturnRow;
    try {
      r = await tx.ctReturn.create({ data: { organisationId: a.organisationId, companyId: a.companyId, periodId: c.periodId, computationId: c.id, accountsIxbrlDocumentId: accounts!.id,
        package: pkg as unknown as Prisma.InputJsonValue, computationIxbrl: doc!.content, computationIxbrlSha256: doc!.sha256, payloadSha256, createdByUserId: a.actor.userId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('This computation already has a live return', 'return_exists');
      throw e;
    }
    await tx.ctReturnEvent.create({ data: { organisationId: a.organisationId, companyId: a.companyId, returnId: r.id, fromStatus: null, toStatus: 'DRAFT', payloadSha256, byUserId: a.actor.userId } });
    await this.audit(tx, { action: 'ct_return.draft', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'ct_return', entityId: r.id, after: { computationId: c.id, payloadSha256 } });
    return this.get(tx, a.companyId, r.id);
  }

  /** VALIDATED: the computation is still the period's current approved one, and the accounts document still the latest VALID one. */
  async validate(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; id: string; note?: string }) {
    await this.need(a.actor, a.companyId);
    const r = await this.find(tx, a.companyId, a.id);
    this.expect(r, 'DRAFT');
    const problems: string[] = [];
    const c = await tx.ctComputation.findFirstOrThrow({ where: { id: r.computationId } });
    if (c.supersededById || c.status !== 'APPROVED') problems.push('the computation is no longer the current approved one');
    const period = await this.ct.getPeriod(tx, a.companyId, r.periodId);
    const latest = await this.accountsIxbrl(tx, period.frameworkId);
    if (!latest || (latest.id !== r.accountsIxbrlDocumentId && latest.sha256 !== (r.package as { accountsIxbrl: { sha256: string } }).accountsIxbrl.sha256)) problems.push('a later iXBRL document of the accounts differs from the one in the return');
    const profile = await this.ct.getProfile(tx, a.companyId);
    if (profile.utr !== (r.package as { ct600: { company: { utr: string } } }).ct600.company.utr) problems.push('the company\'s UTR has changed since the return was started');
    if (problems.length) throw unprocessable(`The return cannot be validated: ${problems.join('; ')}`, 'return_invalid', { problems });
    await this.move(tx, { ...a, r, to: 'VALIDATED', data: { validatedByUserId: a.actor.userId }, note: a.note });
    return this.get(tx, a.companyId, a.id);
  }

  /** AUTHORISED: a serving director's declaration, with its date and evidence; recorded by someone other than the validator. */
  async authorise(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; id: string; directorContactId: string; declaredOn: string; evidenceDocumentId: string; note?: string }) {
    await this.need(a.actor, a.companyId);
    const r = await this.find(tx, a.companyId, a.id);
    this.expect(r, 'VALIDATED');
    if (r.validatedByUserId === a.actor.userId) throw forbidden('The declaration is recorded by someone other than the person who validated the return', 'self_authorisation_not_allowed');
    if (a.declaredOn > this.today()) throw unprocessable('A declaration is recorded once it has been made, not before', 'authority_date_invalid');
    const on = toDate(a.declaredOn);
    if (!(await tx.companyOfficer.findFirst({ where: { companyId: a.companyId, contactId: a.directorContactId, role: 'DIRECTOR', appointedOn: { lte: on }, OR: [{ resignedOn: null }, { resignedOn: { gte: on } }] } }))) {
      throw unprocessable('The declaration must come from a director serving on that date', 'director_not_serving');
    }
    await this.evidence(tx, a.actor, a.companyId, a.evidenceDocumentId);
    await this.move(tx, { ...a, r, to: 'AUTHORISED', data: { authorisedByUserId: a.actor.userId, directorContactId: a.directorContactId, declaredOn: on, authorityEvidenceId: a.evidenceDocumentId }, note: a.note });
    return this.get(tx, a.companyId, a.id);
  }

  /** SUBMITTED through the port with the return's id as the idempotency key; a retry returns the same submission. Never automatic. */
  async submit(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; id: string; note?: string }) {
    await this.need(a.actor, a.companyId);
    if (!this.port) throw this.notAvailable();
    const r = await this.find(tx, a.companyId, a.id);
    if (r.status === 'SUBMITTED' || r.status === 'ACCEPTED' || r.status === 'REJECTED') return this.get(tx, a.companyId, a.id);
    this.expect(r, 'AUTHORISED');
    const pkg = r.package as { ct600: { company: { utr: string }; period: { to: string } } };
    const s = await this.port.submit({ utr: pkg.ct600.company.utr, periodEnd: pkg.ct600.period.to, payloadSha256: r.payloadSha256, idempotencyKey: r.id, package: r.package as Record<string, unknown> });
    await this.move(tx, { ...a, r, to: 'SUBMITTED', data: { submissionId: s.submissionId }, submissionId: s.submissionId, request: s.request, response: s.response, note: a.note });
    return this.get(tx, a.companyId, a.id);
  }

  /** Reads the submission's status; ACCEPTED closes the CT return deadline, REJECTED is final. */
  async refresh(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; id: string }) {
    await this.need(a.actor, a.companyId);
    if (!this.port) throw this.notAvailable();
    const r = await this.find(tx, a.companyId, a.id);
    this.expect(r, 'SUBMITTED');
    const s = await this.port.status(r.submissionId!, (r.package as { ct600: { company: { utr: string } } }).ct600.company.utr);
    if (s.status === 'PENDING') return this.get(tx, a.companyId, a.id);
    if (s.status === 'REJECTED') {
      await this.move(tx, { ...a, r, to: 'REJECTED', data: { rejectionReasons: s.reasons }, submissionId: r.submissionId, response: s.response });
      return this.get(tx, a.companyId, a.id);
    }
    const acceptedOn = this.today();
    const after = await this.move(tx, { ...a, r, to: 'ACCEPTED', data: { hmrcReference: s.reference ?? r.submissionId!, acceptedOn: toDate(acceptedOn) }, submissionId: r.submissionId, response: s.response });
    await this.closeObligation(tx, { organisationId: a.organisationId, actor: a.actor, r: after, acceptedOn, reference: after.hmrcReference!, evidenceId: null });
    return this.get(tx, a.companyId, a.id);
  }

  /** A return filed outside the platform: ACCEPTED from VALIDATED or AUTHORISED, with HMRC's reference, the date and the evidence. */
  async record(tx: Tx, a: { organisationId: string; companyId: string; actor: CtActor; id: string; reference: string; acceptedOn: string; evidenceDocumentId: string; note?: string }) {
    await this.need(a.actor, a.companyId);
    const r = await this.find(tx, a.companyId, a.id);
    this.expect(r, 'VALIDATED', 'AUTHORISED');
    if (a.acceptedOn > this.today()) throw unprocessable('An acceptance is recorded once it has happened, not before', 'acceptance_date_invalid');
    await this.evidence(tx, a.actor, a.companyId, a.evidenceDocumentId);
    const after = await this.move(tx, { ...a, r, to: 'ACCEPTED', data: { mode: 'RECORDED', hmrcReference: a.reference.trim(), acceptedOn: toDate(a.acceptedOn), acceptanceEvidenceId: a.evidenceDocumentId }, note: a.note });
    await this.closeObligation(tx, { organisationId: a.organisationId, actor: a.actor, r: after, acceptedOn: a.acceptedOn, reference: a.reference.trim(), evidenceId: a.evidenceDocumentId });
    return this.get(tx, a.companyId, a.id);
  }
}
