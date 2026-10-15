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
/** `taxCodeId` absent: the customer's default VAT code applies on invoices (DEC-046); `null`: explicitly no VAT code. */
export interface SalesLineInput { description: string; quantity: string; unitPrice: string; accountId: string; taxCodeId?: string | null }
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

  /**
   * DEC-046: invoice lines that name no VAT code take the customer's default, resolved now and stored on the line. Not on foreign-currency
   * invoices (VAT on them is M5c, DEC-031): the draft says so in its warnings instead of being refused.
   */
  private static withDefaultTaxCode(lines: SalesLineInput[], defaultTaxCodeId: string | null | undefined, currency: string, base: string) {
    const open = lines.some((l) => l.taxCodeId === undefined);
    if (!defaultTaxCodeId || !open) return { lines, warnings: [] as string[] };
    if (currency !== base) return { lines, warnings: [`The customer's default VAT code was not applied: VAT on ${currency} documents comes with M5c (DEC-031)`] };
    return { lines: lines.map((l) => (l.taxCodeId === undefined ? { ...l, taxCodeId: defaultTaxCodeId } : l)), warnings: [] as string[] };
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
    const { lines, warnings: defaults } = SalesService.withDefaultTaxCode(a.lines, profile?.defaultTaxCodeId, currency, company.baseCurrency);
    await this.checkLines(tx, { companyId: a.companyId, issueDate: a.issueDate, currency, base: company.baseCurrency, lines });
    const minor = await this.minorOf(tx, currency);
    const amounts = await this.compute(tx, { lines, inclusive: a.amountsIncludeVat, taxPoint: a.taxPoint ?? a.issueDate, minor, strict: false });
    const doc = await tx.salesDocument.create({ data: {
      organisationId: a.organisationId, companyId: a.companyId, kind: 'INVOICE', customerRoleId: role.id, contactId: role.contactId, issueDate: toDate(a.issueDate),
      supplyDate: a.supplyDate ? toDate(a.supplyDate) : null, taxPoint: a.taxPoint ? toDate(a.taxPoint) : null, dueDate: toDate(a.dueDate ?? addDays(a.issueDate, profile?.paymentTermsDays ?? 0)),
      currency, amountsIncludeVat: a.amountsIncludeVat, customerReference: a.customerReference ?? null, notes: a.notes ?? null,
      netTotal: amounts.net, vatTotal: amounts.vat, grossTotal: amounts.gross, origin: a.aiProposalId ? 'AI_PROPOSAL' : 'MANUAL', aiProposalId: a.aiProposalId ?? null, createdByUserId: a.actor.userId,
    } });
    await this.writeLines(tx, doc, 1, lines, amounts.lines);
    await this.audit(tx, { action: 'sales_document.created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'sales_document', entityId: doc.id,
      after: { kind: 'INVOICE', customerRoleId: role.id, currency, gross: fmt(amounts.gross, minor), lines: lines.length }, metadata: { origin: doc.origin, aiProposalId: a.aiProposalId ?? null } });
    return this.get(tx, a.companyId, doc.id, [...defaults, ...amounts.warnings]);
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
    let lines = a.lines ?? (await this.currentLines(tx, d)).map(SalesService.asInput);
    let defaults: string[] = [];
    if (d.kind === 'INVOICE' && a.lines) {
      const profile = await tx.customerProfile.findFirst({ where: { roleId: d.customerRoleId } });
      ({ lines, warnings: defaults } = SalesService.withDefaultTaxCode(a.lines, profile?.defaultTaxCodeId, d.currency, company.baseCurrency));
    }
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
    return this.get(tx, a.companyId, d.id, [...defaults, ...amounts.warnings]);
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

  /** Open balance of a customer in the company currency: approved invoices outstanding less credit notes and receipts not yet allocated. */
  async openBalance(tx: Tx, companyId: string, customerRoleId: string): Promise<Money> {
    const rows = await tx.salesDocument.groupBy({ by: ['kind'], where: { companyId, customerRoleId, status: 'APPROVED' }, _sum: { functionalOutstanding: true } });
    const s = (k: string) => rows.find((r) => r.kind === k)?._sum.functionalOutstanding ?? ZERO;
    const rc = await tx.salesReceipt.aggregate({ where: { companyId, customerRoleId, status: 'POSTED' }, _sum: { functionalOutstanding: true } });
    return money(s('INVOICE')).minus(money(s('CREDIT_NOTE'))).minus(money(rc._sum.functionalOutstanding ?? 0));
  }

  // ───── Allocation (DEC-030): releases carried amounts on both sides; any difference is realised FX in its own journal ─────
  async allocate(tx: Tx, a: { organisationId: string; companyId: string; actor: SalesActor; invoiceId: string; creditId?: string; receiptId?: string; amount: Money; date: string }) {
    await this.need(a.actor, 'sales:approve', a.companyId);
    if (!!a.creditId === !!a.receiptId) throw unprocessable('An allocation applies either a credit note or a receipt', 'invalid_allocation');
    // lock in a fixed order (documents by id, then the receipt) so concurrent allocations cannot deadlock
    await tx.$queryRaw`SELECT id FROM sales_document WHERE id IN (${a.invoiceId}::uuid, ${a.creditId ?? a.invoiceId}::uuid) ORDER BY id FOR UPDATE`;
    if (a.receiptId) await tx.$queryRaw`SELECT id FROM sales_receipt WHERE id = ${a.receiptId}::uuid FOR UPDATE`;
    const inv = await tx.salesDocument.findFirst({ where: { id: a.invoiceId, companyId: a.companyId } });
    if (!inv || inv.kind !== 'INVOICE') throw notFound('Invoice not found');
    if (inv.status !== 'APPROVED') throw unprocessable('Only approved invoices are allocated to', 'document_not_approved');
    let src: { id: string; label: string; customerRoleId: string; currency: string; outstanding: Money; functionalOutstanding: Money };
    if (a.creditId) {
      const cr = await tx.salesDocument.findFirst({ where: { id: a.creditId, companyId: a.companyId } });
      if (!cr) throw notFound('Sales document not found');
      if (cr.status !== 'APPROVED') throw unprocessable('Only approved documents are allocated', 'document_not_approved');
      src = { id: cr.id, label: cr.documentNumber!, customerRoleId: cr.customerRoleId, currency: cr.currency, outstanding: cr.outstanding, functionalOutstanding: cr.functionalOutstanding };
    } else {
      const r = await tx.salesReceipt.findFirst({ where: { id: a.receiptId!, companyId: a.companyId } });
      if (!r) throw notFound('Receipt not found');
      if (r.status !== 'POSTED') throw unprocessable('A reversed receipt cannot be allocated', 'receipt_reversed');
      src = { id: r.id, label: `receipt ${r.reference ?? isoDay(r.receiptDate)}`, customerRoleId: r.customerRoleId, currency: r.currency, outstanding: r.outstanding, functionalOutstanding: r.functionalOutstanding };
    }
    if (src.customerRoleId !== inv.customerRoleId || src.currency !== inv.currency) throw unprocessable('An allocation joins documents of one customer and currency', 'allocation_mismatch');
    if (!a.amount.greaterThan(0)) throw unprocessable('An allocation must be greater than zero', 'invalid_amount');
    if (a.amount.greaterThan(inv.outstanding) || a.amount.greaterThan(src.outstanding)) throw unprocessable('An allocation cannot exceed what is outstanding on either side', 'allocation_exceeds_outstanding');
    const company = await this.company(tx, a.companyId);
    const fm = await this.minorOf(tx, company.baseCurrency);
    const invoiceFunctional = releaseShare(inv.functionalOutstanding, inv.outstanding, a.amount, fm);
    const creditFunctional = releaseShare(src.functionalOutstanding, src.outstanding, a.amount, fm);
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
        organisationId: a.organisationId, companyId: a.companyId, journalDate: a.date, sourceType: 'SALES_ALLOCATION_FX', sourceId: id, sourceReference: `${inv.documentNumber}/${src.label}`.slice(0, 100),
        description: `Realised exchange ${loss ? 'loss' : 'gain'}: ${src.label} allocated to ${inv.documentNumber} (${fmt(a.amount, await this.minorOf(tx, inv.currency))} ${inv.currency})`.slice(0, 500),
        lines: [
          { accountId: fx.realisedAccountId, debit: loss ? amt : '0', credit: loss ? '0' : amt, description: 'Realised FX' },
          { accountId: settings.receivablesAccountId!, debit: loss ? '0' : amt, credit: loss ? amt : '0', description: `FX on ${inv.documentNumber}`, adjustsCurrency: inv.currency },
        ],
        idempotencyKey: `sales-allocation:${id}`, actor: a.actor,
      });
      fxJournalId = j.id;
    }
    const row = await tx.salesAllocation.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, invoiceId: inv.id, creditId: a.creditId ?? null, receiptId: a.receiptId ?? null,
      amount: a.amount, invoiceFunctional, creditFunctional, fxDifference: diff, fxJournalId, allocatedOn: toDate(a.date), createdByUserId: a.actor.userId } });
    await this.audit(tx, { action: 'sales_allocation.created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'sales_allocation', entityId: id,
      after: { invoice: inv.documentNumber, credit: src.label, receiptId: a.receiptId ?? null, amount: a.amount.toFixed(4), currency: inv.currency, realisedFx: fmt(diff.negated(), fm), fxJournalId } });
    return this.allocationView(row, fm);
  }

  private allocationView(r: AllocRow, fm: number) {
    return { id: r.id, invoiceId: r.invoiceId, creditId: r.creditId, receiptId: r.receiptId, amount: r.amount.toFixed(4), invoiceFunctional: fmt(r.invoiceFunctional, fm), creditFunctional: fmt(r.creditFunctional, fm),
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
    const receipts = await tx.salesReceipt.groupBy({ by: ['currency'], where: { companyId, status: 'POSTED' }, _sum: { outstanding: true, functionalOutstanding: true } });
    const ledger = await tx.$queryRaw<{ currency: string; source_type: string; original: string; functional: string }[]>`
      SELECT coalesce(l.original_currency, l.adjusts_currency, ${company.baseCurrency}) AS currency, j.source_type,
             sum(CASE WHEN l.original_currency IS NOT NULL THEN l.original_debit - l.original_credit WHEN l.adjusts_currency IS NOT NULL THEN 0 ELSE l.debit - l.credit END)::text AS original,
             sum(l.debit - l.credit)::text AS functional
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND l.account_id = ${settings.receivablesAccountId}::uuid
       GROUP BY 1, 2`;
    const currencies = [...new Set([...docs.map((d) => d.currency), ...receipts.map((r) => r.currency), ...ledger.map((l) => l.currency)])].sort();
    const SUB = new Set(['SALES_INVOICE', 'SALES_CREDIT_NOTE', 'SALES_ALLOCATION_FX', 'SALES_RECEIPT', 'SALES_RECEIPT_REVERSAL']);
    const rows = [];
    for (const c of currencies) {
      const minor = await this.minorOf(tx, c);
      const sumDocs = (k: 'outstanding' | 'functionalOutstanding') => docs.filter((d) => d.currency === c).reduce((t, d) => (d.kind === 'INVOICE' ? t.plus(d._sum[k] ?? 0) : t.minus(d._sum[k] ?? 0)), ZERO)
        .minus(money(receipts.find((r) => r.currency === c)?._sum[k] ?? 0));
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

  // ───── Receipts (M5b, DEC-032): posted when recorded; allocated at entry or later; reversed only while unallocated ─────
  private async bankAccount(tx: Tx, companyId: string, id: string, date: string) {
    const a = await tx.account.findFirst({ where: { id, companyId } });
    if (!a) throw unprocessable('The bank account does not exist in this company', 'unknown_account');
    if (!['CURRENT_ASSET_BANK', 'CURRENT_ASSET_CASH'].includes(a.subtype)) throw unprocessable(`Account ${a.code} is not a bank or cash account`, 'not_a_bank_account');
    const d = toDate(date);
    if ((a.activeFrom && d < a.activeFrom) || (a.activeTo && d > a.activeTo)) throw unprocessable(`Account ${a.code} is not active on ${date}`, 'account_inactive');
    return a;
  }

  async recordReceipt(tx: Tx, a: { organisationId: string; companyId: string; actor: SalesActor; customerRoleId: string; receiptDate: string; currency?: string; amount: string; bankAccountId: string;
    reference?: string; notes?: string; rateId?: string; allocations: { invoiceId: string; amount: string }[]; duplicateOverrideReason?: string }) {
    await this.need(a.actor, 'sales:approve', a.companyId);
    const company = await this.company(tx, a.companyId);
    const { role } = await this.customer(tx, a.companyId, a.customerRoleId);
    if (role.status !== 'ACTIVE') throw conflict('An ended customer role cannot receive new receipts; reactivate it first', 'contact_role_ended');
    const settings = await tx.salesSetting.findFirst({ where: { companyId: a.companyId } });
    if (!settings?.receivablesAccountId) throw unprocessable('Set the receivables control account in the sales settings first', 'sales_settings_missing');
    const currency = a.currency ?? company.baseCurrency;
    const cur = await tx.currency.findUnique({ where: { code: currency } });
    if (!cur) throw unprocessable(`${currency} is not a known currency`, 'unknown_currency');
    const amount = money(a.amount);
    if (!amount.greaterThan(0) || amount.decimalPlaces() > cur.minorUnits) throw unprocessable(`The amount must be greater than zero with at most ${cur.minorUnits} decimal places`, 'invalid_amount');
    if (a.rateId && currency === company.baseCurrency) throw unprocessable('A rate applies only to foreign-currency receipts', 'rate_not_applicable');
    await this.bankAccount(tx, a.companyId, a.bankAccountId, a.receiptDate);
    const allocated = a.allocations.reduce((t, x) => t.plus(money(x.amount)), ZERO);
    if (allocated.greaterThan(amount)) throw unprocessable('The allocations exceed the receipt', 'allocation_exceeds_outstanding');
    if (new Set(a.allocations.map((x) => x.invoiceId)).size !== a.allocations.length) throw unprocessable('Each invoice appears once in the allocations', 'invalid_allocation');
    // duplicate check (DEC-032): same customer and (same date, currency and amount, or the same bank reference)
    const dups = await tx.salesReceipt.findMany({ where: { companyId: a.companyId, customerRoleId: role.id, status: 'POSTED',
      OR: [{ receiptDate: toDate(a.receiptDate), currency, amount }, ...(a.reference ? [{ reference: a.reference }] : [])] }, select: { id: true }, take: 5 });
    if (dups.length > 0 && !a.duplicateOverrideReason) throw conflict('Possible duplicate of an earlier receipt from this customer (same date, currency and amount, or the same reference); record it with a duplicateOverrideReason if it is genuine', 'possible_duplicate', { receipts: dups.map((d) => d.id) });
    const id = randomUUID();
    const snapshotName = (await tx.contact.findFirstOrThrow({ where: { id: role.contactId }, select: { name: true } })).name;
    const amt = fmt(amount, cur.minorUnits);
    const j = await this.posting.post(tx, {
      organisationId: a.organisationId, companyId: a.companyId, journalDate: a.receiptDate, sourceType: 'SALES_RECEIPT', sourceId: id, sourceReference: a.reference ?? null,
      description: `Receipt from ${snapshotName}${a.reference ? ` (${a.reference})` : ''}`.slice(0, 500),
      ...(currency !== company.baseCurrency ? { currency, ...(a.rateId ? { rateId: a.rateId } : {}) } : {}),
      lines: [
        { accountId: a.bankAccountId, debit: amt, credit: '0', description: `Receipt ${snapshotName}`.slice(0, 300) },
        { accountId: settings.receivablesAccountId, debit: '0', credit: amt, description: `Receipt ${snapshotName}`.slice(0, 300) },
      ],
      idempotencyKey: `sales-receipt:${id}`, actor: a.actor,
    });
    const recv = await tx.journalLine.findFirstOrThrow({ where: { journalId: j.id, lineNo: 2 } });
    const functional = recv.credit;
    await tx.salesReceipt.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, customerRoleId: role.id, contactId: role.contactId, receiptDate: toDate(a.receiptDate), currency,
      amount, outstanding: amount, functionalAmount: functional, functionalOutstanding: functional, bankAccountId: a.bankAccountId, exchangeRateId: recv.exchangeRateId, rate: recv.rate,
      reference: a.reference ?? null, notes: a.notes ?? null, journalId: j.id, duplicateOverrideReason: dups.length > 0 ? a.duplicateOverrideReason!.trim() : null, createdByUserId: a.actor.userId } });
    for (const x of a.allocations) {
      const inv = await tx.salesDocument.findFirst({ where: { id: x.invoiceId, companyId: a.companyId }, select: { issueDate: true } });
      if (!inv) throw notFound('Invoice not found');
      const date = isoDay(inv.issueDate) > a.receiptDate ? isoDay(inv.issueDate) : a.receiptDate;
      await this.allocate(tx, { organisationId: a.organisationId, companyId: a.companyId, actor: a.actor, invoiceId: x.invoiceId, receiptId: id, amount: money(x.amount), date });
    }
    await this.audit(tx, { action: 'sales_receipt.recorded', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'sales_receipt', entityId: id,
      after: { customerRoleId: role.id, receiptDate: a.receiptDate, currency, amount: amt, allocated: fmt(allocated, cur.minorUnits), journalId: j.id }, reason: a.duplicateOverrideReason ?? null,
      metadata: { duplicateOverride: dups.length > 0 } });
    await publishEvent(tx, Events.salesReceiptRecorded, { aggregateId: id, organisationId: a.organisationId, actorUserId: a.actor.userId,
      payload: { receiptId: id, companyId: a.companyId, customerRoleId: role.id, receiptDate: a.receiptDate, currency, amount: amt, allocated: fmt(allocated, cur.minorUnits), journalId: j.id } });
    return this.getReceipt(tx, a.companyId, id);
  }

  /** Allocate (part of) a receipt's unallocated credit to invoices; dated, unless given, when both the receipt and the invoice exist. */
  async allocateReceipt(tx: Tx, a: { organisationId: string; companyId: string; actor: SalesActor; receiptId: string; allocations: { invoiceId: string; amount: string }[]; date?: string }) {
    await this.need(a.actor, 'sales:approve', a.companyId);
    const r = await tx.salesReceipt.findFirst({ where: { id: a.receiptId, companyId: a.companyId } });
    if (!r) throw notFound('Receipt not found');
    if (new Set(a.allocations.map((x) => x.invoiceId)).size !== a.allocations.length) throw unprocessable('Each invoice appears once in the allocations', 'invalid_allocation');
    for (const x of a.allocations) {
      const inv = await tx.salesDocument.findFirst({ where: { id: x.invoiceId, companyId: a.companyId }, select: { issueDate: true } });
      if (!inv) throw notFound('Invoice not found');
      const earliest = isoDay(inv.issueDate) > isoDay(r.receiptDate) ? isoDay(inv.issueDate) : isoDay(r.receiptDate);
      if (a.date && a.date < earliest) throw unprocessable('An allocation cannot precede the receipt or the invoice', 'invalid_date');
      await this.allocate(tx, { organisationId: a.organisationId, companyId: a.companyId, actor: a.actor, invoiceId: x.invoiceId, receiptId: r.id, amount: money(x.amount), date: a.date ?? earliest });
    }
    return this.getReceipt(tx, a.companyId, r.id);
  }

  async reverseReceipt(tx: Tx, a: { organisationId: string; companyId: string; actor: SalesActor; id: string; reason: string; date?: string; negativeCashReason?: string }) {
    await this.need(a.actor, 'sales:approve', a.companyId);
    await tx.$queryRaw`SELECT id FROM sales_receipt WHERE id = ${a.id}::uuid FOR UPDATE`;
    const r = await tx.salesReceipt.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!r) throw notFound('Receipt not found');
    if (r.status !== 'POSTED') throw conflict('This receipt is already reversed', 'receipt_reversed');
    if (!r.outstanding.equals(r.amount)) throw conflict('Part of this receipt is allocated to invoices; an allocated receipt cannot be reversed (unallocating is deferred, DEC-026)', 'receipt_allocated');
    const date = a.date ?? isoDay(r.receiptDate);
    if (date < isoDay(r.receiptDate)) throw unprocessable('A reversal cannot precede the receipt', 'invalid_date');
    // the exact mirror of the posted lines, original amounts and rate included (a foreign receipt reverses at its own rate, whatever the date)
    const posted = await tx.journalLine.findMany({ where: { journalId: r.journalId }, orderBy: { lineNo: 'asc' } });
    const j = await this.posting.post(tx, {
      organisationId: a.organisationId, companyId: a.companyId, journalDate: date, sourceType: 'SALES_RECEIPT_REVERSAL', sourceId: r.id, sourceReference: r.reference,
      description: `Reversal of receipt ${r.reference ?? r.id.slice(0, 8)}: ${a.reason.trim()}`.slice(0, 500),
      lines: [...posted].reverse().map((l) => ({ accountId: l.accountId, debit: l.credit.toFixed(4), credit: l.debit.toFixed(4), description: 'Receipt reversed',
        ...(l.originalCurrency ? { original: { currency: l.originalCurrency, debit: l.originalCredit!.toFixed(4), credit: l.originalDebit!.toFixed(4), rate: l.rate!.toFixed(8), rateId: l.exchangeRateId! } } : {}) })),
      idempotencyKey: `sales-receipt-reversal:${r.id}`, actor: a.actor, reason: a.reason, negativeCashReason: a.negativeCashReason,
    });
    await tx.salesReceipt.update({ where: { id: r.id }, data: { status: 'REVERSED', reversalJournalId: j.id, reversedByUserId: a.actor.userId, reversedAt: new Date(), reversedReason: a.reason.trim() } });
    await this.audit(tx, { action: 'sales_receipt.reversed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'sales_receipt', entityId: r.id,
      before: { status: 'POSTED' }, after: { status: 'REVERSED', journalId: j.id, date }, reason: a.reason });
    return this.getReceipt(tx, a.companyId, r.id);
  }

  async getReceipt(tx: Tx, companyId: string, id: string) {
    const r = await tx.salesReceipt.findFirst({ where: { id, companyId } });
    if (!r) throw notFound('Receipt not found');
    const company = await this.company(tx, companyId);
    const [minor, fm] = await Promise.all([this.minorOf(tx, r.currency), this.minorOf(tx, company.baseCurrency)]);
    const allocs = await tx.salesAllocation.findMany({ where: { receiptId: r.id }, orderBy: { createdAt: 'asc' } });
    return { ...this.receiptView(r, minor, fm), allocations: allocs.map((x) => this.allocationView(x, fm)) };
  }
  private receiptView(r: Awaited<ReturnType<Tx['salesReceipt']['findUniqueOrThrow']>>, minor: number, fm: number) {
    return { id: r.id, companyId: r.companyId, customerRoleId: r.customerRoleId, contactId: r.contactId, receiptDate: isoDay(r.receiptDate), currency: r.currency, amount: fmt(r.amount, minor),
      unallocated: fmt(r.outstanding, minor), functional: { amount: fmt(r.functionalAmount, fm), unallocated: fmt(r.functionalOutstanding, fm) }, rate: r.rate ? r.rate.toFixed(8) : null, exchangeRateId: r.exchangeRateId,
      bankAccountId: r.bankAccountId, reference: r.reference, notes: r.notes, journalId: r.journalId, duplicateOverrideReason: r.duplicateOverrideReason, status: r.status,
      reversalJournalId: r.reversalJournalId, reversedByUserId: r.reversedByUserId, reversedAt: r.reversedAt, reversedReason: r.reversedReason, createdByUserId: r.createdByUserId, createdAt: r.createdAt };
  }
  async listReceipts(tx: Tx, companyId: string, q: { customerRoleId?: string; status?: string; unallocated?: boolean; from?: string; to?: string; limit: number; cursor?: string }) {
    const company = await this.company(tx, companyId);
    const fm = await this.minorOf(tx, company.baseCurrency);
    const rows = await tx.salesReceipt.findMany({
      where: { companyId, ...(q.customerRoleId ? { customerRoleId: q.customerRoleId } : {}), ...(q.status ? { status: q.status } : {}),
        ...(q.unallocated === true ? { status: 'POSTED', outstanding: { gt: 0 } } : q.unallocated === false ? { outstanding: 0 } : {}),
        ...(q.from || q.to ? { receiptDate: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } } : {}) },
      orderBy: [{ receiptDate: 'desc' }, { id: 'desc' }], take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = [];
    for (const r of rows.slice(0, q.limit)) items.push(this.receiptView(r, await this.minorOf(tx, r.currency), fm));
    return { items, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  // ───── Customer statement and aged receivables (document currency; from documents, receipts and allocations) ─────
  async statement(tx: Tx, companyId: string, customerRoleId: string, q: { from: string; to: string }) {
    const { role } = await this.customer(tx, companyId, customerRoleId);
    const docs = await tx.salesDocument.findMany({ where: { companyId, customerRoleId, status: 'APPROVED', issueDate: { lte: toDate(q.to) } } });
    const receipts = await tx.salesReceipt.findMany({ where: { companyId, customerRoleId, receiptDate: { lte: toDate(q.to) } } });
    const revJournals = new Map((await tx.journal.findMany({ where: { id: { in: receipts.map((r) => r.reversalJournalId).filter(Boolean) as string[] } }, select: { id: true, journalDate: true } })).map((j) => [j.id, isoDay(j.journalDate)]));
    type Entry = { date: string; type: string; reference: string | null; documentId: string; dueDate: string | null; debit: Money; credit: Money };
    const byCcy = new Map<string, Entry[]>();
    const push = (c: string, e: Entry) => { if (!byCcy.has(c)) byCcy.set(c, []); byCcy.get(c)!.push(e); };
    for (const d of docs) push(d.currency, { date: isoDay(d.issueDate), type: d.kind, reference: d.documentNumber, documentId: d.id, dueDate: d.kind === 'INVOICE' ? isoDay(d.dueDate) : null,
      debit: d.kind === 'INVOICE' ? d.grossTotal : ZERO, credit: d.kind === 'INVOICE' ? ZERO : d.grossTotal });
    for (const r of receipts) {
      push(r.currency, { date: isoDay(r.receiptDate), type: 'RECEIPT', reference: r.reference, documentId: r.id, dueDate: null, debit: ZERO, credit: r.amount });
      const rd = r.reversalJournalId ? revJournals.get(r.reversalJournalId) : undefined;
      if (rd && rd <= q.to) push(r.currency, { date: rd, type: 'RECEIPT_REVERSAL', reference: r.reference, documentId: r.id, dueDate: null, debit: r.amount, credit: ZERO });
    }
    const currencies = [];
    for (const [c, entries] of [...byCcy.entries()].sort(([x], [y]) => x.localeCompare(y))) {
      const minor = await this.minorOf(tx, c);
      entries.sort((x, y) => x.date.localeCompare(y.date) || x.type.localeCompare(y.type));
      const opening = entries.filter((e) => e.date < q.from).reduce((t, e) => t.plus(e.debit).minus(e.credit), ZERO);
      let bal = opening;
      const lines = entries.filter((e) => e.date >= q.from).map((e) => { bal = bal.plus(e.debit).minus(e.credit); return { date: e.date, type: e.type, reference: e.reference, documentId: e.documentId, dueDate: e.dueDate,
        debit: fmt(e.debit, minor), credit: fmt(e.credit, minor), balance: fmt(bal, minor) }; });
      currencies.push({ currency: c, opening: fmt(opening, minor), lines, closing: fmt(bal, minor) });
    }
    return { companyId, customerRoleId, customer: await buildContactSnapshot(tx, role.id), from: q.from, to: q.to, currencies };
  }

  async agedReceivables(tx: Tx, companyId: string, q: { asOf?: string; customerRoleId?: string }) {
    await this.company(tx, companyId);
    const asOf = q.asOf ?? isoDay(new Date());
    const d = toDate(asOf);
    const filt = q.customerRoleId ? { customerRoleId: q.customerRoleId } : {};
    const invoices = await tx.salesDocument.findMany({ where: { companyId, ...filt, status: 'APPROVED', issueDate: { lte: d } } });
    const receipts = await tx.salesReceipt.findMany({ where: { companyId, ...filt, receiptDate: { lte: d } } });
    const revDates = new Map((await tx.journal.findMany({ where: { id: { in: receipts.map((r) => r.reversalJournalId).filter(Boolean) as string[] } }, select: { id: true, journalDate: true } })).map((j) => [j.id, j.journalDate]));
    const allocs = await tx.salesAllocation.findMany({ where: { companyId, allocatedOn: { lte: d } } });
    const used = (pick: (x: AllocRow) => string | null) => { const m = new Map<string, Money>(); for (const x of allocs) { const k = pick(x); if (k) m.set(k, (m.get(k) ?? ZERO).plus(x.amount)); } return m; };
    const toInvoice = used((x) => x.invoiceId), fromCredit = used((x) => x.creditId), fromReceipt = used((x) => x.receiptId);
    const BUCKETS = ['notDue', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;
    type Row = Record<(typeof BUCKETS)[number] | 'unallocatedCredits', Money>;
    const rows = new Map<string, { customerRoleId: string; currency: string; r: Row }>();
    const row = (cust: string, c: string) => { const k = `${cust}|${c}`; if (!rows.has(k)) rows.set(k, { customerRoleId: cust, currency: c, r: { notDue: ZERO, days1to30: ZERO, days31to60: ZERO, days61to90: ZERO, over90: ZERO, unallocatedCredits: ZERO } }); return rows.get(k)!.r; };
    for (const i of invoices) {
      const open = i.kind === 'INVOICE' ? i.grossTotal.minus(toInvoice.get(i.id) ?? ZERO) : i.grossTotal.minus(fromCredit.get(i.id) ?? ZERO);
      if (open.isZero()) continue;
      const r = row(i.customerRoleId, i.currency);
      if (i.kind !== 'INVOICE') { r.unallocatedCredits = r.unallocatedCredits.minus(open); continue; }
      const late = Math.round((d.getTime() - i.dueDate.getTime()) / 86_400_000);
      const b = late <= 0 ? 'notDue' : late <= 30 ? 'days1to30' : late <= 60 ? 'days31to60' : late <= 90 ? 'days61to90' : 'over90';
      r[b] = r[b].plus(open);
    }
    for (const rc of receipts) {
      const rev = rc.reversalJournalId ? revDates.get(rc.reversalJournalId) : undefined;
      if (rev && rev <= d) continue;
      const open = rc.amount.minus(fromReceipt.get(rc.id) ?? ZERO);
      if (!open.isZero()) { const r = row(rc.customerRoleId, rc.currency); r.unallocatedCredits = r.unallocatedCredits.minus(open); }
    }
    const names = new Map((await tx.contactRole.findMany({ where: { id: { in: [...new Set([...rows.values()].map((x) => x.customerRoleId))] } }, select: { id: true, accountCode: true, contactId: true } })).map((x) => [x.id, x]));
    const contactNames = new Map((await tx.contact.findMany({ where: { id: { in: [...names.values()].map((x) => x.contactId) } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
    const out = [];
    const totals = new Map<string, Row>();
    for (const v of [...rows.values()].sort((x, y) => x.currency.localeCompare(y.currency) || (contactNames.get(names.get(x.customerRoleId)?.contactId ?? '') ?? '').localeCompare(contactNames.get(names.get(y.customerRoleId)?.contactId ?? '') ?? ''))) {
      const minor = await this.minorOf(tx, v.currency);
      const total = [...BUCKETS, 'unallocatedCredits' as const].reduce((t, k) => t.plus(v.r[k]), ZERO);
      const tt = totals.get(v.currency) ?? { notDue: ZERO, days1to30: ZERO, days31to60: ZERO, days61to90: ZERO, over90: ZERO, unallocatedCredits: ZERO };
      for (const k of [...BUCKETS, 'unallocatedCredits' as const]) tt[k] = tt[k].plus(v.r[k]);
      totals.set(v.currency, tt);
      const n = names.get(v.customerRoleId);
      out.push({ customerRoleId: v.customerRoleId, accountCode: n?.accountCode ?? null, name: contactNames.get(n?.contactId ?? '') ?? null, currency: v.currency,
        ...Object.fromEntries([...BUCKETS, 'unallocatedCredits'].map((k) => [k, fmt(v.r[k as keyof Row], minor)])), total: fmt(total, minor) });
    }
    const currencyTotals = [];
    for (const [c, t] of [...totals.entries()].sort(([x], [y]) => x.localeCompare(y))) {
      const minor = await this.minorOf(tx, c);
      currencyTotals.push({ currency: c, ...Object.fromEntries([...BUCKETS, 'unallocatedCredits'].map((k) => [k, fmt(t[k as keyof Row], minor)])), total: fmt([...BUCKETS, 'unallocatedCredits' as const].reduce((s2, k) => s2.plus(t[k]), ZERO), minor) });
    }
    return { companyId, asOf, customers: out, totals: currencyTotals };
  }
}
