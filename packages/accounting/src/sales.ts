import { randomUUID } from 'node:crypto';
import { Events, type SalesDocumentKind } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow, publishEvent } from '@uk/platform';
import { ZERO, fmt, money, type Money } from './money';
import { PostingService, type PostingActor, type PostLineInput } from './posting';
import { VatService, vatInGross, vatOnNet } from './vat';

/**
 * Sales documents (M5a; DEC-026..031, ADR-59). The ONLY writer of `sales_setting`, `sales_sequence`, `sales_document`, `sales_document_line` and
 * `sales_allocation` (architecture-tested). It never writes the ledger: approval and allocation post through the PostingService, and the database
 * re-proves the numbering, the lifecycle and every outstanding amount.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const addDays = (s: string, n: number) => isoDay(new Date(toDate(s).getTime() + n * 86_400_000));

export interface SalesActor extends PostingActor { userId: string }
export interface SalesLineInput { description: string; quantity: string; unitPrice: string; accountId: string; taxCodeId?: string }
type DocRow = Awaited<ReturnType<Tx['salesDocument']['findUniqueOrThrow']>>;
type LineRow = Awaited<ReturnType<Tx['salesDocumentLine']['findUniqueOrThrow']>>;
type AllocRow = Awaited<ReturnType<Tx['salesAllocation']['findUniqueOrThrow']>>;

/** Line amount = quantity x unit price, rounded half-up to the currency's minor units (DEC-027). */
export const lineAmount = (quantity: Money, unitPrice: Money, minor: number) => quantity.mul(unitPrice).toDecimalPlaces(minor, Prisma.Decimal.ROUND_HALF_UP);
/** The carried functional amount released by allocating `amount` of `outstanding`: the whole remainder when it clears it, otherwise prorated half-up (DEC-030). */
export const releaseShare = (functionalOutstanding: Money, outstanding: Money, amount: Money, minor: number) =>
  amount.equals(outstanding) ? functionalOutstanding : functionalOutstanding.mul(amount).div(outstanding).toDecimalPlaces(minor, Prisma.Decimal.ROUND_HALF_UP);

/** What a document shows of its counterparty, captured at approval so later edits never rewrite it (DEC-023). */
export async function buildContactSnapshot(tx: Tx, roleId: string) {
  const r = await tx.contactRole.findFirst({ where: { id: roleId } });
  if (!r) throw notFound('Contact role not found');
  const c = await tx.contact.findFirstOrThrow({ where: { id: r.contactId } });
  const a = (await tx.address.findMany({ where: { contactId: c.id }, orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }], take: 1 }))[0];
  return {
    roleId: r.id, role: r.role, contactId: c.id, accountCode: r.accountCode, name: c.name, kind: c.kind, vatNumber: c.vatNumber, email: c.email,
    address: a ? { line1: a.line1, line2: a.line2, line3: a.line3, city: a.city, region: a.region, postcode: a.postcode, countryCode: a.countryCode } : null,
    capturedAt: new Date().toISOString(),
  };
}

function paymentStatus(d: DocRow) {
  if (d.status !== 'APPROVED') return null;
  const inv = d.kind === 'INVOICE';
  if (d.outstanding.isZero()) return inv ? 'PAID' : 'ALLOCATED';
  if (d.outstanding.lessThan(d.grossTotal)) return inv ? 'PART_PAID' : 'PART_ALLOCATED';
  return inv ? 'UNPAID' : 'UNALLOCATED';
}

export class SalesService {
  private readonly posting: PostingService;
  private readonly vat: VatService;
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {
    this.posting = new PostingService({ captureDeviceMetadata: opts.captureDeviceMetadata });
    this.vat = new VatService({ captureDeviceMetadata: opts.captureDeviceMetadata });
  }
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: SalesActor, permission: string, companyId: string) {
    if (actor.kind !== 'USER' || !actor.userId) throw forbidden('Sales documents are prepared and approved by people; AI can only propose a draft through an accepted proposal', 'ai_cannot_post');
    if (!(await actor.can(permission, companyId))) throw forbidden(`Requires permission ${permission}`, 'permission_denied');
  }
  private async minorOf(tx: Tx, code: string) { return (await tx.currency.findUnique({ where: { code } }))?.minorUnits ?? 2; }
  private async company(tx: Tx, companyId: string) {
    const c = await tx.company.findFirst({ where: { id: companyId }, select: { id: true, baseCurrency: true } });
    if (!c) throw notFound('Company not found');
    return c;
  }

  // ───── Settings ─────
  async getSettings(tx: Tx, companyId: string) {
    const s = await tx.salesSetting.findFirst({ where: { companyId } });
    const seq = await tx.salesSequence.findMany({ where: { companyId } });
    const last = (k: string) => seq.find((x) => x.kind === k)?.lastNumber ?? null;
    return {
      companyId, receivablesAccountId: s?.receivablesAccountId ?? null, invoicePrefix: s?.invoicePrefix ?? 'INV-', creditNotePrefix: s?.creditNotePrefix ?? 'CN-',
      invoiceStart: s?.invoiceStart ?? 1, creditNoteStart: s?.creditNoteStart ?? 1, requireSeparateApprover: s?.requireSeparateApprover ?? false,
      lastInvoiceNumber: last('INVOICE'), lastCreditNoteNumber: last('CREDIT_NOTE'), numberingFrozen: { invoice: last('INVOICE') !== null, creditNote: last('CREDIT_NOTE') !== null },
      isDefault: !s, updatedAt: s?.updatedAt ?? null, updatedByUserId: s?.updatedByUserId ?? null,
    };
  }

  async setSettings(tx: Tx, a: { organisationId: string; companyId: string; actor: SalesActor; receivablesAccountId: string | null; invoicePrefix: string; creditNotePrefix: string;
    invoiceStart: number; creditNoteStart: number; requireSeparateApprover: boolean; reason: string }) {
    await this.need(a.actor, 'ledger:policy', a.companyId);
    await this.company(tx, a.companyId);
    const before = await this.getSettings(tx, a.companyId);
    if (a.receivablesAccountId) {
      const acc = await tx.account.findFirst({ where: { id: a.receivablesAccountId, companyId: a.companyId } });
      if (!acc) throw unprocessable('The receivables account does not exist in this company', 'unknown_account');
      if (!acc.isControl || acc.controlKind !== 'TRADE_RECEIVABLES') throw unprocessable('The receivables account must be a TRADE_RECEIVABLES control account', 'receivables_account_invalid');
    }
    if (before.receivablesAccountId !== a.receivablesAccountId && (await tx.salesDocument.count({ where: { companyId: a.companyId, status: 'APPROVED' } })) > 0) {
      throw conflict('Approved sales documents already post to the receivables account; it cannot change', 'receivables_account_in_use');
    }
    if (before.numberingFrozen.invoice && (a.invoicePrefix !== before.invoicePrefix || a.invoiceStart !== before.invoiceStart)) throw conflict('Invoice numbering cannot change after the first invoice is approved', 'numbering_frozen');
    if (before.numberingFrozen.creditNote && (a.creditNotePrefix !== before.creditNotePrefix || a.creditNoteStart !== before.creditNoteStart)) throw conflict('Credit note numbering cannot change after the first credit note is approved', 'numbering_frozen');
    const data = { receivablesAccountId: a.receivablesAccountId, invoicePrefix: a.invoicePrefix, creditNotePrefix: a.creditNotePrefix, invoiceStart: a.invoiceStart, creditNoteStart: a.creditNoteStart,
      requireSeparateApprover: a.requireSeparateApprover, updatedByUserId: a.actor.userId };
    await tx.salesSetting.upsert({ where: { organisationId_companyId: { organisationId: a.organisationId, companyId: a.companyId } }, create: { organisationId: a.organisationId, companyId: a.companyId, ...data }, update: data });
    const after = await this.getSettings(tx, a.companyId);
    await this.audit(tx, { action: 'sales.settings_changed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'sales_setting', entityId: a.companyId,
      before: { ...before, updatedAt: undefined }, after: { ...after, updatedAt: undefined }, reason: a.reason });
    return after;
  }

  // ───── Line computation (the same arithmetic the PostingService uses; the database proves the posted result) ─────
  private async checkLines(tx: Tx, a: { companyId: string; issueDate: string; currency: string; base: string; lines: SalesLineInput[]; allowedCodes?: Set<string> }) {
    const vat = await tx.companyVatSetting.findFirst({ where: { companyId: a.companyId } });
    const fx = await tx.companyFxSetting.findFirst({ where: { companyId: a.companyId } });
    const reserved = new Set([vat?.outputAccountId, vat?.inputAccountId, fx?.roundingAccountId, fx?.realisedAccountId, fx?.unrealisedAccountId].filter(Boolean) as string[]);
    const accIds = [...new Set(a.lines.map((l) => l.accountId))];
    const accounts = new Map((await tx.account.findMany({ where: { companyId: a.companyId, id: { in: accIds } } })).map((x) => [x.id, x]));
    const d = toDate(a.issueDate);
    for (const [i, l] of a.lines.entries()) {
      const acc = accounts.get(l.accountId);
      if (!acc) throw unprocessable(`Line ${i + 1}: the account does not exist in this company`, 'unknown_account');
      if (acc.isControl) throw unprocessable(`Line ${i + 1}: ${acc.code} is a control account; sales lines post to income or other non-control accounts`, 'control_account_restricted');
      if (reserved.has(acc.id)) throw unprocessable(`Line ${i + 1}: ${acc.code} is reserved for VAT or foreign-exchange postings`, 'system_account_restricted');
      if ((acc.activeFrom && d < acc.activeFrom) || (acc.activeTo && d > acc.activeTo)) throw unprocessable(`Line ${i + 1}: account ${acc.code} is not active on ${a.issueDate}`, 'account_inactive');
      if (l.taxCodeId) {
        if (a.currency !== a.base) throw unprocessable('VAT on foreign-currency documents comes with M5c (DEC-031)', 'vat_foreign_currency_not_supported');
        const code = await tx.taxCode.findFirst({ where: { id: l.taxCodeId } });
        if (!code) throw unprocessable(`Line ${i + 1}: unknown VAT code`, 'unknown_tax_code');
        if (code.direction === 'PURCHASES' || code.reverseCharge) throw unprocessable(`Line ${i + 1}: ${code.code} is not a sales VAT code`, 'tax_code_direction');
        if (a.allowedCodes && !a.allowedCodes.has(code.id)) throw unprocessable(`Line ${i + 1}: a credit note uses only VAT codes of its invoice`, 'tax_code_not_on_invoice');
      }
    }
  }

  /**
   * Per-line amounts. `strict`: every VAT rate must be verified and in force (approval). Otherwise (drafts) a missing or unverified rate is reported as a
   * warning and the VAT shown as zero. `pins`: credit notes take the invoice's rate version per VAT code (DEC-029).
   */
  private async compute(tx: Tx, a: { lines: SalesLineInput[]; inclusive: boolean; taxPoint: string; minor: number; strict: boolean; pins?: Map<string, { taxRateId: string; ratePoint: string }> }) {
    const warnings: string[] = [];
    const out: { net: Money; vat: Money; gross: Money; entered: Money }[] = [];
    for (const [i, l] of a.lines.entries()) {
      const entered = lineAmount(money(l.quantity), money(l.unitPrice), a.minor);
      let vat = ZERO;
      if (l.taxCodeId) {
        let rate: Money | null = null;
        const pin = a.pins?.get(l.taxCodeId);
        try {
          if (pin) {
            const r = await tx.taxRate.findFirst({ where: { id: pin.taxRateId } });
            if (!r || r.verificationStatus !== 'VERIFIED') throw unprocessable(`Line ${i + 1}: the invoice's VAT rate is not verified`, 'tax_rate_unverified');
            rate = r.rate;
          } else rate = (await this.vat.rateFor(tx, l.taxCodeId, a.taxPoint)).rate;
        } catch (e) {
          if (a.strict) throw e;
          warnings.push(`Line ${i + 1}: ${(e as Error).message}`);
        }
        if (rate && !rate.isZero()) vat = a.inclusive ? vatInGross(entered, rate, a.minor) : vatOnNet(entered, rate, a.minor);
      }
      const net = a.inclusive ? entered.minus(vat) : entered;
      if (a.strict && !net.greaterThan(0)) throw unprocessable(`Line ${i + 1}: the net amount must be greater than zero`, 'invalid_amount');
      out.push({ net, vat, gross: net.plus(vat), entered });
    }
    const sum = (k: 'net' | 'vat' | 'gross') => out.reduce((t, x) => t.plus(x[k]), ZERO);
    return { lines: out, net: sum('net'), vat: sum('vat'), gross: sum('gross'), warnings };
  }

  /** Credit notes: per VAT code, the rate version the invoice's journal used and the invoice's tax point. */
  private async invoicePins(tx: Tx, invoice: DocRow) {
    const lines = await tx.journalLine.findMany({ where: { journalId: invoice.journalId!, vatRole: 'NET' }, select: { taxCodeId: true, taxRateId: true, taxPoint: true } });
    const pins = new Map<string, { taxRateId: string; ratePoint: string }>();
    for (const l of lines) if (l.taxCodeId && l.taxRateId && l.taxPoint) pins.set(l.taxCodeId, { taxRateId: l.taxRateId, ratePoint: isoDay(l.taxPoint) });
    return pins;
  }

  private async writeLines(tx: Tx, doc: { organisationId: string; companyId: string; id: string }, revision: number, lines: SalesLineInput[], amounts: { net: Money; vat: Money; gross: Money }[]) {
    await tx.salesDocumentLine.createMany({ data: lines.map((l, i) => ({
      organisationId: doc.organisationId, companyId: doc.companyId, documentId: doc.id, revision, lineNo: i + 1, description: l.description.trim(), quantity: money(l.quantity), unitPrice: money(l.unitPrice),
      accountId: l.accountId, taxCodeId: l.taxCodeId ?? null, net: amounts[i]!.net, vat: amounts[i]!.vat, gross: amounts[i]!.gross,
    })) });
  }
  private async currentLines(tx: Tx, d: DocRow) { return tx.salesDocumentLine.findMany({ where: { documentId: d.id, revision: d.revision }, orderBy: { lineNo: 'asc' } }); }
  private static asInput(l: LineRow): SalesLineInput { return { description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), accountId: l.accountId, ...(l.taxCodeId ? { taxCodeId: l.taxCodeId } : {}) }; }

  private async customer(tx: Tx, companyId: string, roleId: string) {
    const r = await tx.contactRole.findFirst({ where: { id: roleId, companyId } });
    if (!r || r.role !== 'CUSTOMER') throw unprocessable('The customer must be a customer role of this company', 'not_a_customer');
    const profile = await tx.customerProfile.findFirst({ where: { roleId } });
    return { role: r, profile };
  }

  // ───── Drafts ─────
  async createInvoice(tx: Tx, a: { organisationId: string; companyId: string; actor: SalesActor; customerRoleId: string; issueDate: string; supplyDate?: string; taxPoint?: string; dueDate?: string;
    currency?: string; amountsIncludeVat: boolean; customerReference?: string; notes?: string; lines: SalesLineInput[]; aiProposalId?: string }) {
    await this.need(a.actor, 'sales:manage', a.companyId);
    const company = await this.company(tx, a.companyId);
    const { role, profile } = await this.customer(tx, a.companyId, a.customerRoleId);
    if (role.status !== 'ACTIVE') throw conflict('An ended customer role cannot be used on a new document', 'contact_role_ended');
    const currency = a.currency ?? profile?.defaultCurrency ?? company.baseCurrency;
    if (!(await tx.currency.findUnique({ where: { code: currency } }))) throw unprocessable(`${currency} is not a known currency`, 'unknown_currency');
    if (a.aiProposalId) {
      const p = await tx.aiProposal.findFirst({ where: { id: a.aiProposalId } });
      if (!p || p.companyId !== a.companyId) throw unprocessable('The AI proposal does not belong to this company', 'proposal_not_found');
      if (p.kind !== 'sales_invoice') throw unprocessable('The AI proposal is not a sales invoice proposal', 'proposal_kind_invalid');
      if (p.status !== 'ACCEPTED') throw unprocessable('Only an ACCEPTED AI proposal can become a draft; a person reviews and accepts it first', 'proposal_not_accepted');
      if (p.appliedAt) throw conflict('This AI proposal was already applied', 'proposal_already_applied');
    }
    await this.checkLines(tx, { companyId: a.companyId, issueDate: a.issueDate, currency, base: company.baseCurrency, lines: a.lines });
    const minor = await this.minorOf(tx, currency);
    const amounts = await this.compute(tx, { lines: a.lines, inclusive: a.amountsIncludeVat, taxPoint: a.taxPoint ?? a.issueDate, minor, strict: false });
    const doc = await tx.salesDocument.create({ data: {
      organisationId: a.organisationId, companyId: a.companyId, kind: 'INVOICE', customerRoleId: role.id, contactId: role.contactId, issueDate: toDate(a.issueDate),
      supplyDate: a.supplyDate ? toDate(a.supplyDate) : null, taxPoint: a.taxPoint ? toDate(a.taxPoint) : null, dueDate: toDate(a.dueDate ?? addDays(a.issueDate, profile?.paymentTermsDays ?? 0)),
      currency, amountsIncludeVat: a.amountsIncludeVat, customerReference: a.customerReference ?? null, notes: a.notes ?? null,
      netTotal: amounts.net, vatTotal: amounts.vat, grossTotal: amounts.gross, origin: a.aiProposalId ? 'AI_PROPOSAL' : 'MANUAL', aiProposalId: a.aiProposalId ?? null, createdByUserId: a.actor.userId,
    } });
    await this.writeLines(tx, doc, 1, a.lines, amounts.lines);
    await this.audit(tx, { action: 'sales_document.created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'sales_document', entityId: doc.id,
      after: { kind: 'INVOICE', customerRoleId: role.id, currency, gross: fmt(amounts.gross, minor), lines: a.lines.length }, metadata: { origin: doc.origin, aiProposalId: a.aiProposalId ?? null } });
    return this.get(tx, a.companyId, doc.id, amounts.warnings);
  }

  async createCreditNote(tx: Tx, a: { organisationId: string; companyId: string; actor: SalesActor; originalInvoiceId: string; issueDate: string; supplyDate?: string; taxPoint?: string;
    customerReference?: string; notes?: string; reason: string; lines?: SalesLineInput[] }) {
    await this.need(a.actor, 'sales:manage', a.companyId);
    const company = await this.company(tx, a.companyId);
    const inv = await tx.salesDocument.findFirst({ where: { id: a.originalInvoiceId, companyId: a.companyId } });
    if (!inv || inv.kind !== 'INVOICE') throw notFound('Invoice not found');
    if (inv.status !== 'APPROVED') throw unprocessable('Only an approved invoice can be credited', 'invoice_not_approved');
    if (inv.outstanding.isZero()) throw unprocessable('The invoice has nothing outstanding to credit', 'nothing_to_credit');
    if (a.issueDate < isoDay(inv.issueDate)) throw unprocessable('A credit note cannot be dated before its invoice', 'invalid_date');
    let lines = a.lines;
    if (!lines) {
      if (!inv.outstanding.equals(inv.grossTotal)) throw unprocessable('Part of this invoice is already settled or credited; give the lines to credit', 'credit_lines_required');
      lines = (await this.currentLines(tx, inv)).map(SalesService.asInput);
    }
    const pins = await this.invoicePins(tx, inv);
    const invoiceCodes = new Set((await this.currentLines(tx, inv)).map((l) => l.taxCodeId).filter(Boolean) as string[]);
    await this.checkLines(tx, { companyId: a.companyId, issueDate: a.issueDate, currency: inv.currency, base: company.baseCurrency, lines, allowedCodes: invoiceCodes });
    const minor = await this.minorOf(tx, inv.currency);
    const amounts = await this.compute(tx, { lines, inclusive: inv.amountsIncludeVat, taxPoint: a.taxPoint ?? a.issueDate, minor, strict: false, pins });
    const doc = await tx.salesDocument.create({ data: {
      organisationId: a.organisationId, companyId: a.companyId, kind: 'CREDIT_NOTE', customerRoleId: inv.customerRoleId, contactId: inv.contactId, issueDate: toDate(a.issueDate),
      supplyDate: a.supplyDate ? toDate(a.supplyDate) : null, taxPoint: a.taxPoint ? toDate(a.taxPoint) : null, dueDate: toDate(a.issueDate), currency: inv.currency, amountsIncludeVat: inv.amountsIncludeVat,
      customerReference: a.customerReference ?? inv.customerReference, notes: a.notes ?? null, originalInvoiceId: inv.id, creditReason: a.reason.trim(),
      netTotal: amounts.net, vatTotal: amounts.vat, grossTotal: amounts.gross, createdByUserId: a.actor.userId,
    } });
    await this.writeLines(tx, doc, 1, lines, amounts.lines);
    await this.audit(tx, { action: 'sales_document.created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'sales_document', entityId: doc.id,
      after: { kind: 'CREDIT_NOTE', originalInvoiceId: inv.id, currency: inv.currency, gross: fmt(amounts.gross, minor), lines: lines.length }, reason: a.reason });
    const w = amounts.gross.greaterThan(inv.outstanding) ? [`The credit (${fmt(amounts.gross, minor)}) exceeds what is outstanding on the invoice (${fmt(inv.outstanding, minor)}); it cannot be approved as it stands`] : [];
    return this.get(tx, a.companyId, doc.id, [...amounts.warnings, ...w]);
  }

  async updateDraft(tx: Tx, a: { organisationId: string; companyId: string; actor: SalesActor; id: string; revision: number; issueDate?: string; supplyDate?: string | null; taxPoint?: string | null;
    dueDate?: string; customerReference?: string | null; notes?: string | null; amountsIncludeVat?: boolean; reason?: string; lines?: SalesLineInput[] }) {
    await this.need(a.actor, 'sales:manage', a.companyId);
    const company = await this.company(tx, a.companyId);
    await tx.$queryRaw`SELECT id FROM sales_document WHERE id = ${a.id}::uuid FOR UPDATE`;
    const d = await tx.salesDocument.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!d) throw notFound('Sales document not found');
    if (d.status !== 'DRAFT') throw conflict(`An ${d.status.toLowerCase()} document cannot be edited${d.status === 'APPROVED' ? '; correct it with a credit note' : ''}`, 'document_not_draft');
    if (d.revision !== a.revision) throw conflict(`The draft was changed by someone else (now revision ${d.revision})`, 'stale_revision', { revision: d.revision });
    if (d.kind === 'CREDIT_NOTE' && a.amountsIncludeVat !== undefined && a.amountsIncludeVat !== d.amountsIncludeVat) throw unprocessable('A credit note follows its invoice on VAT-inclusive amounts', 'invalid_amount');
    if (d.kind === 'INVOICE' && a.reason !== undefined) throw unprocessable('A reason belongs to a credit note', 'invalid_field');
    const issueDate = a.issueDate ?? isoDay(d.issueDate);
    const taxPoint = a.taxPoint === undefined ? (d.taxPoint ? isoDay(d.taxPoint) : null) : a.taxPoint;
    const inclusive = a.amountsIncludeVat ?? d.amountsIncludeVat;
    const lines = a.lines ?? (await this.currentLines(tx, d)).map(SalesService.asInput);
    let pins: Map<string, { taxRateId: string; ratePoint: string }> | undefined; let allowed: Set<string> | undefined;
    if (d.kind === 'CREDIT_NOTE') {
      const inv = await tx.salesDocument.findFirstOrThrow({ where: { id: d.originalInvoiceId! } });
      if (issueDate < isoDay(inv.issueDate)) throw unprocessable('A credit note cannot be dated before its invoice', 'invalid_date');
      pins = await this.invoicePins(tx, inv);
      allowed = new Set((await this.currentLines(tx, inv)).map((l) => l.taxCodeId).filter(Boolean) as string[]);
    }
    await this.checkLines(tx, { companyId: a.companyId, issueDate, currency: d.currency, base: company.baseCurrency, lines, allowedCodes: allowed });
    const minor = await this.minorOf(tx, d.currency);
    const amounts = await this.compute(tx, { lines, inclusive, taxPoint: taxPoint ?? issueDate, minor, strict: false, pins });
    const dueDate = a.dueDate ?? (d.kind === 'CREDIT_NOTE' ? issueDate : isoDay(d.dueDate) < issueDate ? issueDate : isoDay(d.dueDate));
    if (dueDate < issueDate) throw unprocessable('dueDate cannot precede issueDate', 'invalid_date');
    const revision = d.revision + 1;
    await tx.salesDocument.update({ where: { id: d.id }, data: {
      revision, issueDate: toDate(issueDate), supplyDate: a.supplyDate === undefined ? d.supplyDate : a.supplyDate ? toDate(a.supplyDate) : null, taxPoint: taxPoint ? toDate(taxPoint) : null,
      dueDate: toDate(dueDate), customerReference: a.customerReference === undefined ? d.customerReference : a.customerReference, notes: a.notes === undefined ? d.notes : a.notes,
      amountsIncludeVat: inclusive, creditReason: a.reason?.trim() ?? d.creditReason, netTotal: amounts.net, vatTotal: amounts.vat, grossTotal: amounts.gross,
    } });
    await this.writeLines(tx, d, revision, lines, amounts.lines);
    await this.audit(tx, { action: 'sales_document.updated', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'sales_document', entityId: d.id,
      before: { revision: d.revision, gross: fmt(d.grossTotal, minor) }, after: { revision, gross: fmt(amounts.gross, minor), lines: lines.length } });
    return this.get(tx, a.companyId, d.id, amounts.warnings);
  }

  async discard(tx: Tx, a: { organisationId: string; companyId: string; actor: SalesActor; id: string; reason: string }) {
    await this.need(a.actor, 'sales:manage', a.companyId);
    const d = await tx.salesDocument.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!d) throw notFound('Sales document not found');
    if (d.status !== 'DRAFT') throw conflict(d.status === 'APPROVED' ? 'An approved document is never discarded; correct it with a credit note' : 'This draft was already discarded', 'document_not_draft');
    const upd = await tx.salesDocument.updateMany({ where: { id: d.id, status: 'DRAFT' }, data: { status: 'DISCARDED', discardedByUserId: a.actor.userId, discardedAt: new Date(), discardedReason: a.reason.trim() } });
    if (upd.count !== 1) throw conflict('The draft changed concurrently', 'document_not_draft');
    await this.audit(tx, { action: 'sales_document.discarded', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'sales_document', entityId: d.id,
      before: { status: 'DRAFT' }, after: { status: 'DISCARDED' }, reason: a.reason });
    return this.get(tx, a.companyId, d.id);
  }

  // ───── Approval: number, snapshot, post, (credit notes) allocate - one transaction ─────
  async approve(tx: Tx, a: { organisationId: string; companyId: string; actor: SalesActor; id: string; duplicateOverrideReason?: string; creditLimitOverrideReason?: string }) {
    await this.need(a.actor, 'sales:approve', a.companyId);
    const company = await this.company(tx, a.companyId);
    await tx.$queryRaw`SELECT id FROM sales_document WHERE id = ${a.id}::uuid FOR UPDATE`;
    const d = await tx.salesDocument.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!d) throw notFound('Sales document not found');
    if (d.status !== 'DRAFT') throw conflict(`This document is already ${d.status.toLowerCase()}`, 'document_not_draft');
    const settings = await tx.salesSetting.findFirst({ where: { companyId: a.companyId } });
    if (!settings?.receivablesAccountId) throw unprocessable('Set the receivables control account in the sales settings first', 'sales_settings_missing');
    if (settings.requireSeparateApprover && d.createdByUserId === a.actor.userId) throw forbidden('This company requires a different person to approve a sales document', 'separate_approver_required');
    const { role, profile } = await this.customer(tx, a.companyId, d.customerRoleId);
    if (role.status !== 'ACTIVE') throw conflict('The customer role has ended; reactivate it to approve this document', 'contact_role_ended');
    const issueDate = isoDay(d.issueDate);
    const taxPoint = d.taxPoint ? isoDay(d.taxPoint) : issueDate;
    // DEC-031: a VAT-registered company does not approve foreign-currency sales until M5c (the database refuses it too)
    if (d.currency !== company.baseCurrency) {
      const vs = await tx.companyVatSetting.findFirst({ where: { companyId: a.companyId } });
      if (vs?.registered && vs.registeredFrom && taxPoint >= isoDay(vs.registeredFrom)) {
        throw unprocessable('A VAT-registered company cannot approve a foreign-currency sales document until VAT on foreign-currency documents is delivered (M5c, DEC-031)', 'vat_foreign_currency_not_supported');
      }
    }
    let invoice: DocRow | null = null; let pins: Map<string, { taxRateId: string; ratePoint: string }> | undefined; let allowed: Set<string> | undefined;
    if (d.kind === 'CREDIT_NOTE') {
      await tx.$queryRaw`SELECT id FROM sales_document WHERE id = ${d.originalInvoiceId}::uuid FOR UPDATE`;
      invoice = await tx.salesDocument.findFirstOrThrow({ where: { id: d.originalInvoiceId! } });
      pins = await this.invoicePins(tx, invoice);
      allowed = new Set((await this.currentLines(tx, invoice)).map((l) => l.taxCodeId).filter(Boolean) as string[]);
    }
    const stored = await this.currentLines(tx, d);
    if (stored.length === 0) throw unprocessable('A document needs at least one line', 'too_few_lines');
    const lines = stored.map(SalesService.asInput);
    await this.checkLines(tx, { companyId: a.companyId, issueDate, currency: d.currency, base: company.baseCurrency, lines, allowedCodes: allowed });
    const minor = await this.minorOf(tx, d.currency);
    const amounts = await this.compute(tx, { lines, inclusive: d.amountsIncludeVat, taxPoint, minor, strict: true, pins });
    if (invoice && amounts.gross.greaterThan(invoice.outstanding)) {
      throw unprocessable(`The credit (${fmt(amounts.gross, minor)}) exceeds what is outstanding on invoice ${invoice.documentNumber} (${fmt(invoice.outstanding, minor)})`, 'credit_exceeds_outstanding');
    }
    // duplicate check (DEC-027): same customer and (same date, currency and total, or the same customer reference)
    let possibleDuplicates: string[] = [];
    if (d.kind === 'INVOICE') {
      const dups = await tx.salesDocument.findMany({ where: { companyId: a.companyId, kind: 'INVOICE', status: 'APPROVED', customerRoleId: d.customerRoleId, id: { not: d.id },
        OR: [{ issueDate: d.issueDate, currency: d.currency, grossTotal: amounts.gross }, ...(d.customerReference ? [{ customerReference: d.customerReference }] : [])] }, select: { documentNumber: true }, take: 5 });
      possibleDuplicates = dups.map((x) => x.documentNumber!);
      if (possibleDuplicates.length > 0 && !a.duplicateOverrideReason) {
        throw conflict(`Possible duplicate of ${possibleDuplicates.join(', ')} (same customer and the same date and total, or the same customer reference); approve with a duplicateOverrideReason if it is genuine`, 'possible_duplicate', { documents: possibleDuplicates });
      }
    }
    // if the amounts changed since the draft was saved (a rate verified meanwhile), the approved figures are a new revision of the lines
    const changed = !amounts.gross.equals(d.grossTotal) || !amounts.vat.equals(d.vatTotal) || stored.some((l, i) => !l.net.equals(amounts.lines[i]!.net) || !l.vat.equals(amounts.lines[i]!.vat));
    let revision = d.revision;
    if (changed) {
      revision += 1;
      await tx.salesDocument.update({ where: { id: d.id }, data: { revision, netTotal: amounts.net, vatTotal: amounts.vat, grossTotal: amounts.gross } });
      await this.writeLines(tx, d, revision, lines, amounts.lines);
    }
    // the next number (locked sequence row; the database refuses anything else)
    const start = d.kind === 'INVOICE' ? settings.invoiceStart : settings.creditNoteStart;
    const seq = await tx.$queryRaw<{ last_number: number }[]>`
      INSERT INTO sales_sequence (organisation_id, company_id, kind, last_number) VALUES (${a.organisationId}::uuid, ${a.companyId}::uuid, ${d.kind}, ${start})
      ON CONFLICT (organisation_id, company_id, kind) DO UPDATE SET last_number = sales_sequence.last_number + 1 RETURNING last_number`;
    const number = seq[0]!.last_number;
    const documentNumber = `${d.kind === 'INVOICE' ? settings.invoicePrefix : settings.creditNotePrefix}${number}`;
    const snapshot = await buildContactSnapshot(tx, d.customerRoleId);
    // post: invoice Dr receivables / Cr lines (+ output VAT by the PostingService); a credit note mirrors it, at the invoice's VAT rates
    const isInvoice = d.kind === 'INVOICE';
    const g = fmt(amounts.gross, minor);
    const journalLines: PostLineInput[] = [
      { accountId: settings.receivablesAccountId, debit: isInvoice ? g : '0', credit: isInvoice ? '0' : g, description: `${documentNumber} ${snapshot.name}`.slice(0, 300) },
      ...lines.map((l, i): PostLineInput => {
        const e = fmt(amounts.lines[i]!.entered, minor);
        return { accountId: l.accountId, debit: isInvoice ? '0' : e, credit: isInvoice ? e : '0', description: l.description.slice(0, 300),
          ...(l.taxCodeId ? { taxCodeId: l.taxCodeId, ...(pins?.get(l.taxCodeId) ? { vatRate: pins.get(l.taxCodeId)! } : {}) } : {}) };
      }),
    ];
    const coded = lines.some((l) => l.taxCodeId);
    const journal = await this.posting.post(tx, {
      organisationId: a.organisationId, companyId: a.companyId, journalDate: issueDate, sourceType: isInvoice ? 'SALES_INVOICE' : 'SALES_CREDIT_NOTE', sourceId: d.id, sourceReference: documentNumber,
      description: `${isInvoice ? 'Sales invoice' : 'Sales credit note'} ${documentNumber} - ${snapshot.name}${invoice ? ` (credits ${invoice.documentNumber})` : ''}`.slice(0, 500),
      ...(d.currency !== company.baseCurrency ? { currency: d.currency } : {}),
      ...(coded ? { amountsIncludeVat: d.amountsIncludeVat, taxPoint } : {}),
      lines: journalLines, idempotencyKey: `sales:${d.id}:approve`, actor: a.actor,
    });
    const recv = await tx.journalLine.findFirstOrThrow({ where: { journalId: journal.id, lineNo: 1 } });
    const functionalGross = recv.debit.plus(recv.credit);
    // credit limit (DEC-027): the customer's open balance in the company currency, including this invoice
    if (isInvoice && profile?.creditLimit != null) {
      const open = await this.openBalance(tx, a.companyId, d.customerRoleId);
      const after = open.plus(functionalGross);
      if (after.greaterThan(profile.creditLimit) && !a.creditLimitOverrideReason) {
        const cm = await this.minorOf(tx, company.baseCurrency);
        throw conflict(`This invoice takes the customer to ${fmt(after, cm)} ${company.baseCurrency}, over the credit limit of ${fmt(profile.creditLimit, cm)}; approve with a creditLimitOverrideReason`, 'credit_limit_exceeded',
          { openBalance: fmt(open, cm), creditLimit: fmt(profile.creditLimit, cm) });
      }
    }
    await tx.salesDocument.update({ where: { id: d.id }, data: {
      status: 'APPROVED', number, documentNumber, journalId: journal.id, approvedByUserId: a.actor.userId, approvedAt: new Date(), contactSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      outstanding: amounts.gross, functionalGross, functionalOutstanding: functionalGross, exchangeRateId: recv.exchangeRateId, rate: recv.rate,
      duplicateOverrideReason: possibleDuplicates.length > 0 ? a.duplicateOverrideReason!.trim() : null, creditLimitOverrideReason: a.creditLimitOverrideReason?.trim() ?? null,
    } });
    await this.audit(tx, { action: 'sales_document.approved', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'sales_document', entityId: d.id,
      before: { status: 'DRAFT' }, after: { status: 'APPROVED', documentNumber, gross: g, currency: d.currency, journalId: journal.id },
      reason: a.duplicateOverrideReason ?? a.creditLimitOverrideReason ?? null,
      metadata: { possibleDuplicates, duplicateOverride: possibleDuplicates.length > 0, creditLimitOverride: !!a.creditLimitOverrideReason, origin: d.origin, aiProposalId: d.aiProposalId, preparedBy: d.createdByUserId } });
    const base = { documentId: d.id, companyId: a.companyId, documentNumber, customerRoleId: d.customerRoleId, issueDate, currency: d.currency, gross: g, journalId: journal.id };
    if (isInvoice) await publishEvent(tx, Events.invoiceCreated, { aggregateId: d.id, organisationId: a.organisationId, actorUserId: a.actor.userId, payload: { ...base, dueDate: isoDay(d.dueDate) } });
    else {
      await publishEvent(tx, Events.creditNoteCreated, { aggregateId: d.id, organisationId: a.organisationId, actorUserId: a.actor.userId, payload: { ...base, originalInvoiceId: invoice!.id } });
      await this.allocate(tx, { organisationId: a.organisationId, companyId: a.companyId, actor: a.actor, invoiceId: invoice!.id, creditId: d.id, amount: amounts.gross, date: issueDate });
    }
    return this.get(tx, a.companyId, d.id);
  }

  /** Open balance of a customer in the company currency: approved invoices outstanding less approved credits not yet allocated. */
  async openBalance(tx: Tx, companyId: string, customerRoleId: string): Promise<Money> {
    const rows = await tx.salesDocument.groupBy({ by: ['kind'], where: { companyId, customerRoleId, status: 'APPROVED' }, _sum: { functionalOutstanding: true } });
    const s = (k: string) => rows.find((r) => r.kind === k)?._sum.functionalOutstanding ?? ZERO;
    return money(s('INVOICE')).minus(money(s('CREDIT_NOTE')));
  }

  // ───── Allocation (DEC-030): releases carried amounts on both sides; any difference is realised FX in its own journal ─────
  async allocate(tx: Tx, a: { organisationId: string; companyId: string; actor: SalesActor; invoiceId: string; creditId: string; amount: Money; date: string }) {
    await this.need(a.actor, 'sales:approve', a.companyId);
    await tx.$queryRaw`SELECT id FROM sales_document WHERE id IN (${a.invoiceId}::uuid, ${a.creditId}::uuid) ORDER BY id FOR UPDATE`;
    const [inv, cr] = await Promise.all([tx.salesDocument.findFirst({ where: { id: a.invoiceId, companyId: a.companyId } }), tx.salesDocument.findFirst({ where: { id: a.creditId, companyId: a.companyId } })]);
    if (!inv || !cr) throw notFound('Sales document not found');
    if (inv.status !== 'APPROVED' || cr.status !== 'APPROVED') throw unprocessable('Only approved documents are allocated', 'document_not_approved');
    if (!a.amount.greaterThan(0)) throw unprocessable('An allocation must be greater than zero', 'invalid_amount');
    if (a.amount.greaterThan(inv.outstanding) || a.amount.greaterThan(cr.outstanding)) throw unprocessable('An allocation cannot exceed what is outstanding on either document', 'allocation_exceeds_outstanding');
    const company = await this.company(tx, a.companyId);
    const fm = await this.minorOf(tx, company.baseCurrency);
    const invoiceFunctional = releaseShare(inv.functionalOutstanding, inv.outstanding, a.amount, fm);
    const creditFunctional = releaseShare(cr.functionalOutstanding, cr.outstanding, a.amount, fm);
    const diff = invoiceFunctional.minus(creditFunctional);
    const id = randomUUID();
    let fxJournalId: string | null = null;
    if (!diff.isZero()) {
      const fx = await tx.companyFxSetting.findFirst({ where: { companyId: a.companyId } });
      if (!fx?.realisedAccountId) throw unprocessable('This allocation realises an exchange difference but the company has no realised-FX account; designate one in the FX settings', 'fx_realised_account_missing');
      const settings = await tx.salesSetting.findFirstOrThrow({ where: { companyId: a.companyId } });
      const amt = fmt(diff.abs(), fm);
      const loss = diff.greaterThan(0); // the invoice carried more than the credit releases: a debit is left on receivables
      const j = await this.posting.post(tx, {
        organisationId: a.organisationId, companyId: a.companyId, journalDate: a.date, sourceType: 'SALES_ALLOCATION_FX', sourceId: id, sourceReference: `${inv.documentNumber}/${cr.documentNumber}`,
        description: `Realised exchange ${loss ? 'loss' : 'gain'}: ${cr.documentNumber} allocated to ${inv.documentNumber} (${fmt(a.amount, await this.minorOf(tx, inv.currency))} ${inv.currency})`.slice(0, 500),
        lines: [
          { accountId: fx.realisedAccountId, debit: loss ? amt : '0', credit: loss ? '0' : amt, description: 'Realised FX' },
          { accountId: settings.receivablesAccountId!, debit: loss ? '0' : amt, credit: loss ? amt : '0', description: `FX on ${inv.documentNumber}`, adjustsCurrency: inv.currency },
        ],
        idempotencyKey: `sales-allocation:${id}`, actor: a.actor,
      });
      fxJournalId = j.id;
    }
    const row = await tx.salesAllocation.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, invoiceId: inv.id, creditId: cr.id, amount: a.amount,
      invoiceFunctional, creditFunctional, fxDifference: diff, fxJournalId, allocatedOn: toDate(a.date), createdByUserId: a.actor.userId } });
    await this.audit(tx, { action: 'sales_allocation.created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'sales_allocation', entityId: id,
      after: { invoice: inv.documentNumber, credit: cr.documentNumber, amount: a.amount.toFixed(4), currency: inv.currency, realisedFx: fmt(diff.negated(), fm), fxJournalId } });
    return this.allocationView(row, fm);
  }

  private allocationView(r: AllocRow, fm: number) {
    return { id: r.id, invoiceId: r.invoiceId, creditId: r.creditId, amount: r.amount.toFixed(4), invoiceFunctional: fmt(r.invoiceFunctional, fm), creditFunctional: fmt(r.creditFunctional, fm),
      /** Positive = gain, negative = loss, in the company currency. */
      realisedFx: fmt(r.fxDifference.negated(), fm), fxJournalId: r.fxJournalId, allocatedOn: isoDay(r.allocatedOn), createdByUserId: r.createdByUserId, createdAt: r.createdAt };
  }

  // ───── Reads ─────
  private view(d: DocRow, lines: LineRow[], minor: number, fm: number) {
    const m = (v: Money) => fmt(v, minor);
    const effectiveTaxPoint = d.taxPoint ? isoDay(d.taxPoint) : isoDay(d.issueDate);
    return {
      id: d.id, companyId: d.companyId, kind: d.kind as SalesDocumentKind, status: d.status, paymentStatus: paymentStatus(d), number: d.number, documentNumber: d.documentNumber,
      customerRoleId: d.customerRoleId, contactId: d.contactId, issueDate: isoDay(d.issueDate), supplyDate: d.supplyDate ? isoDay(d.supplyDate) : null, taxPoint: effectiveTaxPoint,
      taxPointExplicit: !!d.taxPoint, taxPointReview: !!d.supplyDate && isoDay(d.supplyDate) !== effectiveTaxPoint, dueDate: isoDay(d.dueDate), currency: d.currency, amountsIncludeVat: d.amountsIncludeVat,
      customerReference: d.customerReference, notes: d.notes, originalInvoiceId: d.originalInvoiceId, creditReason: d.creditReason, revision: d.revision,
      totals: { net: m(d.netTotal), vat: m(d.vatTotal), gross: m(d.grossTotal) }, outstanding: m(d.outstanding),
      functional: d.functionalGross ? { gross: fmt(d.functionalGross, fm), outstanding: fmt(d.functionalOutstanding, fm) } : null,
      rate: d.rate ? d.rate.toFixed(8) : null, exchangeRateId: d.exchangeRateId, journalId: d.journalId, contactSnapshot: d.contactSnapshot,
      duplicateOverrideReason: d.duplicateOverrideReason, creditLimitOverrideReason: d.creditLimitOverrideReason, origin: d.origin, aiProposalId: d.aiProposalId,
      createdByUserId: d.createdByUserId, approvedByUserId: d.approvedByUserId, approvedAt: d.approvedAt, discardedByUserId: d.discardedByUserId, discardedAt: d.discardedAt, discardedReason: d.discardedReason,
      createdAt: d.createdAt, updatedAt: d.updatedAt,
      lines: lines.map((l) => ({ lineNo: l.lineNo, description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), accountId: l.accountId, taxCodeId: l.taxCodeId, net: m(l.net), vat: m(l.vat), gross: m(l.gross) })),
    };
  }

  async get(tx: Tx, companyId: string, id: string, warnings: string[] = []) {
    const d = await tx.salesDocument.findFirst({ where: { id, companyId } });
    if (!d) throw notFound('Sales document not found');
    const company = await this.company(tx, companyId);
    const [minor, fm, lines, allocs, credits] = await Promise.all([this.minorOf(tx, d.currency), this.minorOf(tx, company.baseCurrency), this.currentLines(tx, d),
      tx.salesAllocation.findMany({ where: { OR: [{ invoiceId: d.id }, { creditId: d.id }] }, orderBy: { createdAt: 'asc' } }),
      d.kind === 'INVOICE' ? tx.salesDocument.findMany({ where: { originalInvoiceId: d.id }, select: { id: true, documentNumber: true, status: true }, orderBy: { createdAt: 'asc' } }) : Promise.resolve([])]);
    return { ...this.view(d, lines, minor, fm), allocations: allocs.map((r) => this.allocationView(r, fm)), creditNotes: credits, warnings };
  }

  async list(tx: Tx, companyId: string, q: { kind?: string; status?: string; paymentStatus?: string; customerRoleId?: string; from?: string; to?: string; limit: number; cursor?: string }) {
    const company = await this.company(tx, companyId);
    const fm = await this.minorOf(tx, company.baseCurrency);
    const f = tx.salesDocument.fields;
    const ps: Prisma.SalesDocumentWhereInput = !q.paymentStatus ? {}
      : ['PAID', 'ALLOCATED'].includes(q.paymentStatus) ? { status: 'APPROVED', outstanding: 0, kind: q.paymentStatus === 'PAID' ? 'INVOICE' : 'CREDIT_NOTE' }
      : ['UNPAID', 'UNALLOCATED'].includes(q.paymentStatus) ? { status: 'APPROVED', outstanding: { equals: f.grossTotal }, kind: q.paymentStatus === 'UNPAID' ? 'INVOICE' : 'CREDIT_NOTE' }
      : { status: 'APPROVED', outstanding: { gt: 0, lt: f.grossTotal }, kind: q.paymentStatus === 'PART_PAID' ? 'INVOICE' : 'CREDIT_NOTE' };
    const rows = await tx.salesDocument.findMany({
      where: { companyId, ...(q.kind ? { kind: q.kind } : {}), ...(q.status ? { status: q.status } : {}), ...(q.customerRoleId ? { customerRoleId: q.customerRoleId } : {}),
        ...(q.from || q.to ? { issueDate: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } } : {}), ...ps },
      orderBy: [{ issueDate: 'desc' }, { id: 'desc' }], take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const minors = new Map<string, number>();
    for (const c of new Set(rows.map((r) => r.currency))) minors.set(c, await this.minorOf(tx, c));
    const items = rows.slice(0, q.limit).map((d) => { const { lines: _l, ...v } = this.view(d, [], minors.get(d.currency)!, fm); return v; });
    return { items, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  /**
   * Receivables reconciliation (V1-ARC-01, MAN-ACC-06): open items per currency against the control account. In the document currency the control
   * account's original amounts must equal the open items; in the company currency the carried amounts must too. Whatever else sits on the control
   * account (opening balances, control adjustments, revaluation) is listed by journal source so every difference has a name.
   */
  async reconciliation(tx: Tx, companyId: string) {
    const company = await this.company(tx, companyId);
    const fm = await this.minorOf(tx, company.baseCurrency);
    const settings = await tx.salesSetting.findFirst({ where: { companyId } });
    if (!settings?.receivablesAccountId) throw unprocessable('Set the receivables control account in the sales settings first', 'sales_settings_missing');
    const docs = await tx.salesDocument.groupBy({ by: ['currency', 'kind'], where: { companyId, status: 'APPROVED' }, _sum: { outstanding: true, functionalOutstanding: true } });
    const ledger = await tx.$queryRaw<{ currency: string; source_type: string; original: string; functional: string }[]>`
      SELECT coalesce(l.original_currency, l.adjusts_currency, ${company.baseCurrency}) AS currency, j.source_type,
             sum(CASE WHEN l.original_currency IS NOT NULL THEN l.original_debit - l.original_credit WHEN l.adjusts_currency IS NOT NULL THEN 0 ELSE l.debit - l.credit END)::text AS original,
             sum(l.debit - l.credit)::text AS functional
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND l.account_id = ${settings.receivablesAccountId}::uuid
       GROUP BY 1, 2`;
    const currencies = [...new Set([...docs.map((d) => d.currency), ...ledger.map((l) => l.currency)])].sort();
    const SUB = new Set(['SALES_INVOICE', 'SALES_CREDIT_NOTE', 'SALES_ALLOCATION_FX']);
    const rows = [];
    for (const c of currencies) {
      const minor = await this.minorOf(tx, c);
      const sumDocs = (k: 'outstanding' | 'functionalOutstanding') => docs.filter((d) => d.currency === c).reduce((t, d) => (d.kind === 'INVOICE' ? t.plus(d._sum[k] ?? 0) : t.minus(d._sum[k] ?? 0)), ZERO);
      const led = ledger.filter((l) => l.currency === c);
      const sub = (rowsOf: typeof led, k: 'original' | 'functional') => rowsOf.reduce((t, l) => t.plus(money(l[k])), ZERO);
      const fromDocs = led.filter((l) => SUB.has(l.source_type)), other = led.filter((l) => !SUB.has(l.source_type));
      const openItems = sumDocs('outstanding'), openFunctional = sumDocs('functionalOutstanding');
      const ctlFromDocs = sub(fromDocs, 'original'), ctlFunctionalFromDocs = sub(fromDocs, 'functional');
      rows.push({
        currency: c, openItems: fmt(openItems, minor), openItemsFunctional: fmt(openFunctional, fm),
        control: { fromSalesDocuments: fmt(ctlFromDocs, minor), fromSalesDocumentsFunctional: fmt(ctlFunctionalFromDocs, fm), total: fmt(sub(led, 'original'), minor), totalFunctional: fmt(sub(led, 'functional'), fm) },
        /** Must be zero: the sub-ledger and its own postings agree. */
        difference: fmt(ctlFromDocs.minus(openItems), minor), differenceFunctional: fmt(ctlFunctionalFromDocs.minus(openFunctional), fm),
        otherPostings: other.map((l) => ({ sourceType: l.source_type, original: fmt(money(l.original), minor), functional: fmt(money(l.functional), fm) })),
      });
    }
    return { companyId, receivablesAccountId: settings.receivablesAccountId, functionalCurrency: company.baseCurrency, currencies: rows,
      reconciled: rows.every((r) => money(r.difference).isZero() && money(r.differenceFunctional).isZero()) };
  }

  /** Drafts dated in a period (close control, MAN-ACC-08). */
  async draftsIn(tx: Tx, companyId: string, from: Date, to: Date) {
    return tx.salesDocument.findMany({ where: { companyId, status: 'DRAFT', issueDate: { gte: from, lte: to } }, select: { id: true, kind: true, issueDate: true, grossTotal: true, currency: true }, take: 20 });
  }
}
