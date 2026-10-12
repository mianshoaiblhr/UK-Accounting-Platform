import { VAT_SCHEMES, type VatDirection, type VatTreatment } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable, uuidv7 } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow } from '@uk/platform';
import { ZERO, fmt, money, type Money } from './money';

/**
 * VAT foundation, standard VAT accounting (M4b; DEC-010, DEC-021, DEC-022, DEC-025; ADR-51). This file holds VAT REFERENCE data (codes, rate versions,
 * company settings) and the read-side workpaper. It never writes a journal: VAT lines are added and posted by the PostingService, and the database
 * proves each one against its VERIFIED rate version at commit. No rate figure is built in; every number comes from a sourced, verified version.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
export interface VatActor { userId: string; kind?: string; can(permission: string, companyId: string): boolean | Promise<boolean>;
  /** Per-document visibility (restricted documents), supplied by the API from the central authoriser. */
  canReadDocument?(d: { id: string; companyId: string | null; visibility: string; createdByUserId: string | null }): boolean | Promise<boolean> }
type RateRow = Awaited<ReturnType<Tx['taxRate']['findUniqueOrThrow']>>;
type CodeRow = Awaited<ReturnType<Tx['taxCode']['findUniqueOrThrow']>>;

/** Exclusive: round(net x r / 100); inclusive: round(gross x r / (100 + r)) - both half-up to the minor units (DEC-025). The database re-proves both. */
export const vatOnNet = (net: Money, ratePct: Money, minor: number) => net.mul(ratePct).div(100).toDecimalPlaces(minor, Prisma.Decimal.ROUND_HALF_UP);
export const vatInGross = (gross: Money, ratePct: Money, minor: number) => gross.mul(ratePct).div(money(100).plus(ratePct)).toDecimalPlaces(minor, Prisma.Decimal.ROUND_HALF_UP);

export const rateVersionView = (r: RateRow) => ({
  id: r.id, taxCodeId: r.taxCodeId, rate: r.rate.toFixed(4), effectiveFrom: isoDay(r.effectiveFrom), effectiveTo: r.effectiveTo ? isoDay(r.effectiveTo) : null, netBoxes: r.netBoxes, vatBoxes: r.vatBoxes,
  source: { url: r.sourceUrl, provision: r.sourceProvision, retrievedOn: isoDay(r.sourceRetrievedOn) }, enteredByUserId: r.enteredByUserId, createdAt: r.createdAt,
  verificationStatus: r.verificationStatus, verifiedByUserId: r.verifiedByUserId, verifiedAt: r.verifiedAt, verificationNotes: r.verificationNotes, evidenceDocumentId: r.evidenceDocumentId, supersededById: r.supersededById,
});
export const taxCodeView = (c: CodeRow, rates: RateRow[] = []) => ({
  id: c.id, code: c.code, name: c.name, treatment: c.treatment, direction: c.direction, reverseCharge: c.reverseCharge, createdAt: c.createdAt,
  rates: rates.filter((r) => r.taxCodeId === c.id).sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime()).map(rateVersionView),
});

/** The return period containing `date`, given the period length in months and one period end (the stagger; always a month end). */
export function vatPeriodFor(date: string, anchorEnd: string, months: number): { from: string; to: string } {
  const a = toDate(anchorEnd), d = toDate(date);
  const diff = (d.getUTCFullYear() - a.getUTCFullYear()) * 12 + (d.getUTCMonth() - a.getUTCMonth());
  const endMonth = a.getUTCMonth() + Math.ceil(diff / months) * months;              // the first period end in or after the date's month
  return { from: isoDay(new Date(Date.UTC(a.getUTCFullYear(), endMonth - months + 1, 1))), to: isoDay(new Date(Date.UTC(a.getUTCFullYear(), endMonth + 1, 0))) };
}

export class VatService {
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {}
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: VatActor, permission: string, companyId: string) {
    if (actor.kind && actor.kind !== 'USER') throw forbidden('Only a person can change VAT rules', 'ai_cannot_post');
    if (!(await actor.can(permission, companyId))) throw forbidden(`Requires permission ${permission}`, 'permission_denied');
  }

  // ───── Codes ─────
  async listCodes(tx: Tx) {
    const [codes, rates] = await Promise.all([tx.taxCode.findMany({ orderBy: { code: 'asc' } }), tx.taxRate.findMany()]);
    return { items: codes.map((c) => taxCodeView(c, rates)) };
  }
  async getCode(tx: Tx, id: string) {
    const c = await tx.taxCode.findFirst({ where: { id } });
    if (!c) throw notFound('VAT code not found');
    return taxCodeView(c, await tx.taxRate.findMany({ where: { taxCodeId: id } }));
  }
  async createCode(tx: Tx, a: { organisationId: string; companyId: string; actor: VatActor; code: string; name: string; treatment: VatTreatment; direction: VatDirection; reverseCharge: boolean }) {
    await this.need(a.actor, 'vat:manage', a.companyId);
    try {
      const c = await tx.taxCode.create({ data: { organisationId: a.organisationId, code: a.code, name: a.name.trim(), treatment: a.treatment, direction: a.direction, reverseCharge: a.reverseCharge, createdByUserId: a.actor.userId } });
      await this.audit(tx, { action: 'vat.code_created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'tax_code', entityId: c.id,
        after: { code: c.code, name: c.name, treatment: c.treatment, direction: c.direction, reverseCharge: c.reverseCharge } });
      return taxCodeView(c);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict(`VAT code ${a.code} already exists`, 'tax_code_exists');
      throw e;
    }
  }

  // ───── Rate versions ─────
  private async insertRate(tx: Tx, a: { organisationId: string; userId: string; taxCodeId: string; rate: string; effectiveFrom: string; effectiveTo?: string | null; netBoxes: number[]; vatBoxes: number[]; source: { url: string; provision: string; retrievedOn: string }; id?: string }) {
    try {
      return await tx.taxRate.create({ data: { id: a.id, organisationId: a.organisationId, taxCodeId: a.taxCodeId, rate: money(a.rate), effectiveFrom: toDate(a.effectiveFrom), effectiveTo: a.effectiveTo ? toDate(a.effectiveTo) : null,
        netBoxes: a.netBoxes, vatBoxes: a.vatBoxes, sourceUrl: a.source.url, sourceProvision: a.source.provision, sourceRetrievedOn: toDate(a.source.retrievedOn), enteredByUserId: a.userId } });
    } catch (e) {
      const msg = String((e as Error).message);
      if (msg.includes('overlaps another current version')) throw conflict('These dates overlap another current version of this code; supersede that version first', 'tax_rate_overlap');
      if (msg.includes('has a rate of 0') || msg.includes('has a rate above 0')) throw unprocessable(msg.match(/a [a-z_ ]+ code has a rate[^"\n]*/)?.[0] ?? 'The rate does not fit the code treatment', 'rate_treatment_mismatch');
      throw e;
    }
  }
  private boxRules(code: CodeRow, netBoxes: number[], vatBoxes: number[]) {
    const salesNet = netBoxes.filter((b) => b === 6 || b === 8), purchNet = netBoxes.filter((b) => b === 7 || b === 9);
    if (code.direction === 'SALES' && (purchNet.length || vatBoxes.includes(4))) throw unprocessable('A sales code maps to sales boxes (net 6/8, VAT 1/2)', 'invalid_boxes');
    if (code.direction === 'PURCHASES' && !code.reverseCharge && (salesNet.length || vatBoxes.some((b) => b === 1 || b === 2))) throw unprocessable('A purchases code maps to purchase boxes (net 7/9, VAT 4)', 'invalid_boxes');
    if (['ZERO', 'EXEMPT', 'OUTSIDE_SCOPE'].includes(code.treatment) && vatBoxes.length) throw unprocessable('A code with no VAT has no VAT box', 'invalid_boxes');
    if (code.reverseCharge && !(vatBoxes.includes(4) && vatBoxes.some((b) => b === 1 || b === 2))) throw unprocessable('A reverse-charge code maps its VAT to an output box (1 or 2) and to box 4', 'invalid_boxes');
  }
  async addRate(tx: Tx, a: { organisationId: string; companyId: string; actor: VatActor; taxCodeId: string; rate: string; effectiveFrom: string; effectiveTo?: string; netBoxes: number[]; vatBoxes: number[]; source: { url: string; provision: string; retrievedOn: string } }) {
    await this.need(a.actor, 'vat:manage', a.companyId);
    const code = await tx.taxCode.findFirst({ where: { id: a.taxCodeId } });
    if (!code) throw notFound('VAT code not found');
    this.boxRules(code, a.netBoxes, a.vatBoxes);
    const r = await this.insertRate(tx, { ...a, userId: a.actor.userId });
    await this.audit(tx, { action: 'vat.rate_added', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'tax_rate', entityId: r.id,
      after: { code: code.code, rate: r.rate.toFixed(4), effectiveFrom: a.effectiveFrom, effectiveTo: a.effectiveTo ?? null, netBoxes: a.netBoxes, vatBoxes: a.vatBoxes, source: a.source, verification: 'UNVERIFIED' } });
    return rateVersionView(r);
  }
  /** Any change of a rule is a new version that is UNVERIFIED again; the old version stays for the lines that used it. */
  async supersedeRate(tx: Tx, a: { organisationId: string; companyId: string; actor: VatActor; id: string; rate: string; effectiveFrom: string; effectiveTo?: string; netBoxes: number[]; vatBoxes: number[]; source: { url: string; provision: string; retrievedOn: string }; reason: string }) {
    await this.need(a.actor, 'vat:manage', a.companyId);
    const old = await tx.taxRate.findFirst({ where: { id: a.id } });
    if (!old) throw notFound('VAT rate version not found');
    if (old.supersededById) throw conflict('This version was already superseded', 'tax_rate_superseded');
    const code = await tx.taxCode.findUniqueOrThrow({ where: { id: old.taxCodeId } });
    this.boxRules(code, a.netBoxes, a.vatBoxes);
    const newId = uuidv7();
    await tx.taxRate.update({ where: { id: old.id }, data: { supersededById: newId } });
    const r = await this.insertRate(tx, { ...a, id: newId, userId: a.actor.userId, taxCodeId: old.taxCodeId });
    await this.audit(tx, { action: 'vat.rate_superseded', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'tax_rate', entityId: old.id,
      before: rateVersionView(old), after: rateVersionView(r), reason: a.reason });
    return rateVersionView(r);
  }
  /** DEC-021: a holder of tax:rule-verify who did not enter the version records what was checked against which source. */
  async verifyRate(tx: Tx, a: { organisationId: string; companyId: string; actor: VatActor; id: string; notes: string; evidenceDocumentId?: string }) {
    await this.need(a.actor, 'tax:rule-verify', a.companyId);
    const r = await tx.taxRate.findFirst({ where: { id: a.id } });
    if (!r) throw notFound('VAT rate version not found');
    if (r.supersededById) throw conflict('A superseded version cannot be verified', 'tax_rate_superseded');
    if (r.verificationStatus === 'VERIFIED') throw conflict('This version is already verified', 'already_verified');
    if (r.enteredByUserId === a.actor.userId) throw forbidden('A VAT rule must be verified by someone other than the person who entered it', 'self_verification_not_allowed');
    if (a.evidenceDocumentId) {
      // the verifier must be able to read the evidence (restricted documents included); an unreadable document is indistinguishable from a missing one
      const d = await tx.document.findFirst({ where: { id: a.evidenceDocumentId }, select: { id: true, companyId: true, visibility: true, createdByUserId: true } });
      const ok = d && (a.actor.canReadDocument ? await a.actor.canReadDocument(d) : await a.actor.can('document:read', d.companyId ?? a.companyId));
      if (!ok) throw unprocessable('The evidence document does not exist', 'invalid_evidence');
    }
    const v = await tx.taxRate.update({ where: { id: r.id }, data: { verificationStatus: 'VERIFIED', verifiedByUserId: a.actor.userId, verifiedAt: new Date(), verificationNotes: a.notes.trim(), evidenceDocumentId: a.evidenceDocumentId ?? null } });
    await this.audit(tx, { action: 'vat.rate_verified', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'tax_rate', entityId: r.id,
      before: { verification: 'UNVERIFIED' }, after: { verification: 'VERIFIED', source: { url: r.sourceUrl, provision: r.sourceProvision } }, reason: a.notes.trim() });
    return rateVersionView(v);
  }

  /** The version that applies on a tax point: current (not superseded) and covering the date. `requireVerified` refuses an unverified one with a clear code. */
  async rateFor(tx: Tx, taxCodeId: string, taxPoint: string): Promise<RateRow> {
    const d = toDate(taxPoint);
    const rows = await tx.taxRate.findMany({ where: { taxCodeId, supersededById: null, effectiveFrom: { lte: d }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: d } }] } });
    if (rows.length === 0) throw unprocessable(`No rate of this VAT code covers the tax point ${taxPoint}`, 'tax_rate_not_found');
    const r = rows[0]!;
    if (r.verificationStatus !== 'VERIFIED') throw unprocessable(`The VAT rate for ${taxPoint} has not been verified (DEC-021); a holder of tax:rule-verify who did not enter it must verify it first`, 'tax_rate_unverified', { rateId: r.id });
    return r;
  }

  // ───── Company settings ─────
  async getSettings(tx: Tx, companyId: string) {
    const s = await tx.companyVatSetting.findFirst({ where: { companyId } });
    return s ? { companyId, registered: s.registered, vrn: s.vrn, registeredFrom: s.registeredFrom ? isoDay(s.registeredFrom) : null, scheme: s.scheme, periodMonths: s.periodMonths,
      anchorPeriodEnd: s.anchorPeriodEnd ? isoDay(s.anchorPeriodEnd) : null, outputAccountId: s.outputAccountId, inputAccountId: s.inputAccountId, isDefault: false, updatedAt: s.updatedAt, updatedByUserId: s.updatedByUserId }
      : { companyId, registered: false, vrn: null, registeredFrom: null, scheme: 'STANDARD', periodMonths: 3, anchorPeriodEnd: null, outputAccountId: null, inputAccountId: null, isDefault: true, updatedAt: null, updatedByUserId: null };
  }
  async setSettings(tx: Tx, a: { organisationId: string; companyId: string; actor: VatActor; registered: boolean; vrn: string | null; registeredFrom: string | null; scheme: string; periodMonths: number; anchorPeriodEnd: string | null; outputAccountId: string | null; inputAccountId: string | null; reason: string }) {
    await this.need(a.actor, 'vat:manage', a.companyId);
    if (a.anchorPeriodEnd) { const e = toDate(a.anchorPeriodEnd); if (new Date(e.getTime() + 86_400_000).getUTCDate() !== 1) throw unprocessable('The period end must be the last day of a month', 'invalid_period_end'); }
    const scheme = VAT_SCHEMES[a.scheme];
    if (!scheme?.implemented) throw unprocessable(`The ${a.scheme} scheme is not available yet (${scheme?.description ?? 'unknown scheme'})`, 'vat_scheme_not_supported');
    for (const id of [a.outputAccountId, a.inputAccountId].filter((x): x is string => !!x)) {
      const acc = await tx.account.findFirst({ where: { id, companyId: a.companyId } });
      if (!acc) throw unprocessable('A VAT account does not exist in this company', 'unknown_account');
      if (!['ASSET', 'LIABILITY'].includes(acc.type) || acc.activeTo) throw unprocessable(`Account ${acc.code} cannot hold VAT: use an active balance-sheet account (normally the VAT control account)`, 'invalid_account');
    }
    const before = await this.getSettings(tx, a.companyId);
    const data = { registered: a.registered, vrn: a.vrn, registeredFrom: a.registeredFrom ? toDate(a.registeredFrom) : null, scheme: a.scheme, periodMonths: a.periodMonths,
      anchorPeriodEnd: a.anchorPeriodEnd ? toDate(a.anchorPeriodEnd) : null, outputAccountId: a.outputAccountId, inputAccountId: a.inputAccountId, updatedByUserId: a.actor.userId };
    await tx.companyVatSetting.upsert({ where: { organisationId_companyId: { organisationId: a.organisationId, companyId: a.companyId } }, create: { organisationId: a.organisationId, companyId: a.companyId, ...data }, update: data });
    const after = await this.getSettings(tx, a.companyId);
    const v = (x: typeof before) => ({ registered: x.registered, vrn: x.vrn, registeredFrom: x.registeredFrom, scheme: x.scheme, periodMonths: x.periodMonths, anchorPeriodEnd: x.anchorPeriodEnd, outputAccountId: x.outputAccountId, inputAccountId: x.inputAccountId });
    await this.audit(tx, { action: 'vat.settings_changed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'company_vat_setting', entityId: a.companyId, before: v(before), after: v(after), reason: a.reason.trim() });
    return after;
  }
  async period(tx: Tx, companyId: string, date: string) {
    const s = await this.getSettings(tx, companyId);
    if (!s.registered || !s.anchorPeriodEnd) throw unprocessable('The company is not VAT registered (no return periods)', 'not_vat_registered');
    return { ...vatPeriodFor(date, s.anchorPeriodEnd, s.periodMonths), periodMonths: s.periodMonths };
  }

  // ───── Workpaper (read side; NOT a return and NOT a submission) ─────
  /**
   * Nine-box workpaper from journal lines by TAX POINT within [from, to]. Each VERIFIED rate version says which boxes its net and VAT amounts feed;
   * sales-side amounts count credits less debits (a credit note reduces), purchase-side amounts debits less credits. Every box drills to its lines.
   * The control-account reconciliation compares the movement on the VAT accounts (by journal date) with the VAT lines (by tax point) and lists the
   * entries that explain any difference (non-VAT postings such as payments to HMRC, or tax points outside the journal's period).
   */
  async workpaper(tx: Tx, companyId: string, q: { from: string; to: string }) {
    const settings = await this.getSettings(tx, companyId);
    if (!settings.registered) throw unprocessable('The company is not VAT registered', 'not_vat_registered');
    const company = await tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { baseCurrency: true } });
    const minor = (await tx.currency.findUnique({ where: { code: company.baseCurrency } }))?.minorUnits ?? 2;
    const rows = await tx.$queryRaw<{ journal_id: string; journal_number: number; journal_date: Date; line_no: number; account_id: string; account_code: string; debit: string; credit: string; vat_role: string; tax_point: Date; code: string; direction: string; rate_id: string; rate: string; net_boxes: number[]; vat_boxes: number[]; verified_by: string | null; verified_at: Date | null; provision: string; url: string }[]>`
      SELECT l.journal_id, j.journal_number, j.journal_date, l.line_no, l.account_id, a.code AS account_code, l.debit::text AS debit, l.credit::text AS credit, l.vat_role, l.tax_point,
             c.code, c.direction, r.id AS rate_id, r.rate::text AS rate, r.net_boxes::int[] AS net_boxes, r.vat_boxes::int[] AS vat_boxes, r.verified_by_user_id AS verified_by, r.verified_at, r.source_provision AS provision, r.source_url AS url
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
        JOIN account a ON a.id = l.account_id AND a.organisation_id = l.organisation_id
        JOIN tax_code c ON c.id = l.tax_code_id AND c.organisation_id = l.organisation_id
        JOIN tax_rate r ON r.id = l.tax_rate_id AND r.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND l.tax_point BETWEEN ${q.from}::date AND ${q.to}::date
       ORDER BY j.journal_number, l.line_no`;
    type Ref = { journalId: string; journalNumber: number; lineNo: number; accountCode: string; taxCode: string; taxPoint: string; amount: string };
    const boxes: Record<number, { total: Money; lines: Ref[] }> = Object.fromEntries([1, 2, 4, 6, 7, 8, 9].map((b) => [b, { total: ZERO, lines: [] as Ref[] }]));
    const add = (b: number, amt: Money, r: (typeof rows)[number]) => {
      boxes[b]!.total = boxes[b]!.total.plus(amt);
      boxes[b]!.lines.push({ journalId: r.journal_id, journalNumber: r.journal_number, lineNo: r.line_no, accountCode: r.account_code, taxCode: r.code, taxPoint: isoDay(r.tax_point), amount: fmt(amt, minor) });
    };
    const rules = new Map<string, { rateId: string; code: string; rate: string; provision: string; url: string; verifiedBy: string | null; verifiedAt: Date | null }>();
    let vatLineTotal = ZERO;
    for (const r of rows) {
      rules.set(r.rate_id, { rateId: r.rate_id, code: r.code, rate: money(r.rate).toFixed(4), provision: r.provision, url: r.url, verifiedBy: r.verified_by, verifiedAt: r.verified_at });
      const d = money(r.debit), c = money(r.credit);
      if (r.vat_role === 'NET') {
        const salesSide = r.direction === 'SALES' || (r.direction === 'BOTH' && c.greaterThan(0));
        for (const b of r.net_boxes) if (salesSide ? b === 6 || b === 8 : b === 7 || b === 9) add(b, salesSide ? c.minus(d) : d.minus(c), r);
      } else {
        const output = r.account_id === settings.outputAccountId && r.vat_role !== 'RC_INPUT';
        vatLineTotal = vatLineTotal.plus(c.minus(d));
        for (const b of r.vat_boxes) {
          if (output && (b === 1 || b === 2)) add(b, c.minus(d), r);
          if (!output && b === 4) add(b, d.minus(c), r);
        }
      }
    }
    const box3 = boxes[1]!.total.plus(boxes[2]!.total), box5 = box3.minus(boxes[4]!.total);
    // control-account reconciliation: movement on the VAT accounts by journal date versus the VAT lines by tax point (credit-positive)
    const accounts = [...new Set([settings.outputAccountId, settings.inputAccountId].filter((x): x is string => !!x))];
    const movement = await tx.$queryRaw<{ journal_id: string; journal_number: number; journal_date: Date; line_no: number; debit: string; credit: string; vat_role: string | null; tax_point: Date | null }[]>`
      SELECT l.journal_id, j.journal_number, j.journal_date, l.line_no, l.debit::text AS debit, l.credit::text AS credit, l.vat_role, l.tax_point
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND l.account_id = ANY(${accounts}::uuid[]) AND j.journal_date BETWEEN ${q.from}::date AND ${q.to}::date`;
    let moved = ZERO; const explain: { journalId: string; journalNumber: number; lineNo: number; journalDate: string; taxPoint: string | null; amount: string; reason: string }[] = [];
    for (const m of movement) {
      const amt = money(m.credit).minus(money(m.debit)); moved = moved.plus(amt);
      const tp = m.tax_point ? isoDay(m.tax_point) : null;
      if (!m.vat_role) explain.push({ journalId: m.journal_id, journalNumber: m.journal_number, lineNo: m.line_no, journalDate: isoDay(m.journal_date), taxPoint: null, amount: fmt(amt, minor), reason: 'Posting to a VAT account without a VAT code (for example a payment to HMRC or an adjustment)' });
      else if (tp && (tp < q.from || tp > q.to)) explain.push({ journalId: m.journal_id, journalNumber: m.journal_number, lineNo: m.line_no, journalDate: isoDay(m.journal_date), taxPoint: tp, amount: fmt(amt, minor), reason: 'Tax point outside the period of the journal date' });
    }
    for (const r of rows) {
      if (r.vat_role === 'NET') continue;
      const jd = isoDay(r.journal_date);
      if (jd < q.from || jd > q.to) explain.push({ journalId: r.journal_id, journalNumber: r.journal_number, lineNo: r.line_no, journalDate: jd, taxPoint: isoDay(r.tax_point), amount: fmt(money(r.credit).minus(money(r.debit)), minor), reason: 'Tax point in the period but journal dated outside it' });
    }
    const out = (b: number) => ({ box: b, amount: fmt(boxes[b]!.total, minor), lines: boxes[b]!.lines });
    return {
      companyId, from: q.from, to: q.to, currency: company.baseCurrency, vrn: settings.vrn, scheme: settings.scheme,
      boxes: [out(1), out(2), { box: 3, amount: fmt(box3, minor), lines: [] }, out(4), { box: 5, amount: fmt(box5.abs(), minor), lines: [], direction: box5.isNegative() ? 'REPAYABLE' : 'PAYABLE' }, out(6), out(7), out(8), out(9)],
      reconciliation: { vatAccountMovement: fmt(moved, minor), vatLinesByTaxPoint: fmt(vatLineTotal, minor), difference: fmt(moved.minus(vatLineTotal), minor), explainedBy: explain },
      rules: [...rules.values()],
      notice: 'Workpaper only: not a VAT return and not a submission. Amounts are exact (no presentation rounding of boxes 6-9 is applied); the box mappings and rates are those of the VERIFIED rule versions listed.',
    };
  }
}
