import { randomUUID } from 'node:crypto';
import { Events, normaliseSupplierReference, type PurchaseDocumentKind } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable } from '@uk/core';
import { Prisma, type Tx } from '@uk/db';
import { auditRow, publishEvent } from '@uk/platform';
import { ZERO, fmt, money, type Money } from './money';
import { PostingService, type PostLineInput } from './posting';
import { buildContactSnapshot, lineAmount, releaseShare, type SalesActor } from './sales';
import { VatService, vatInGross, vatOnNet } from './vat';

/**
 * Purchase documents (M6a; DEC-033, DEC-034; the sales sub-ledger mirrored, ADR-59). The ONLY writer of `purchase_setting`, `purchase_sequence`,
 * `purchase_document`, `purchase_document_line` and `purchase_allocation` (architecture-tested). It never writes the ledger: approval and allocation
 * post through the PostingService, and the database re-proves numbering, lifecycle and every outstanding amount.
 */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (s: string) => new Date(`${s}T00:00:00.000Z`);
const addDays = (s: string, n: number) => isoDay(new Date(toDate(s).getTime() + n * 86_400_000));

export type PurchaseActor = SalesActor;
export interface PurchaseLineInput { description: string; quantity: string; unitPrice: string; accountId?: string; taxCodeId?: string }
type Line = { description: string; quantity: string; unitPrice: string; accountId: string; taxCodeId?: string };
type DocRow = Awaited<ReturnType<Tx['purchaseDocument']['findUniqueOrThrow']>>;
type LineRow = Awaited<ReturnType<Tx['purchaseDocumentLine']['findUniqueOrThrow']>>;
type AllocRow = Awaited<ReturnType<Tx['purchaseAllocation']['findUniqueOrThrow']>>;
type Pins = Map<string, { taxRateId: string; ratePoint: string }>;

function paymentStatus(d: DocRow) {
  if (d.status !== 'APPROVED') return null;
  const bill = d.kind === 'BILL';
  if (d.outstanding.isZero()) return bill ? 'PAID' : 'ALLOCATED';
  if (d.outstanding.lessThan(d.grossTotal)) return bill ? 'PART_PAID' : 'PART_ALLOCATED';
  return bill ? 'UNPAID' : 'UNALLOCATED';
}

export class PurchasesService {
  private readonly posting: PostingService;
  private readonly vat: VatService;
  constructor(private readonly opts: { captureDeviceMetadata?: boolean } = {}) {
    this.posting = new PostingService({ captureDeviceMetadata: opts.captureDeviceMetadata });
    this.vat = new VatService({ captureDeviceMetadata: opts.captureDeviceMetadata });
  }
  private audit(tx: Tx, e: Parameters<typeof auditRow>[0]) { return tx.auditEvent.createMany({ data: [auditRow(e, this.opts.captureDeviceMetadata)] }); }
  private async need(actor: PurchaseActor, permission: string, companyId: string) {
    if (actor.kind !== 'USER' || !actor.userId) throw forbidden('Purchase documents are prepared and approved by people', 'ai_cannot_post');
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
    const s = await tx.purchaseSetting.findFirst({ where: { companyId } });
    const seq = await tx.purchaseSequence.findMany({ where: { companyId } });
    const last = (k: string) => seq.find((x) => x.kind === k)?.lastNumber ?? null;
    return {
      companyId, payablesAccountId: s?.payablesAccountId ?? null, billPrefix: s?.billPrefix ?? 'BILL-', debitNotePrefix: s?.debitNotePrefix ?? 'DN-',
      billStart: s?.billStart ?? 1, debitNoteStart: s?.debitNoteStart ?? 1, requireSeparateApprover: s?.requireSeparateApprover ?? false,
      lastBillNumber: last('BILL'), lastDebitNoteNumber: last('DEBIT_NOTE'), numberingFrozen: { bill: last('BILL') !== null, debitNote: last('DEBIT_NOTE') !== null },
      isDefault: !s, updatedAt: s?.updatedAt ?? null, updatedByUserId: s?.updatedByUserId ?? null,
    };
  }

  async setSettings(tx: Tx, a: { organisationId: string; companyId: string; actor: PurchaseActor; payablesAccountId: string | null; billPrefix: string; debitNotePrefix: string;
    billStart: number; debitNoteStart: number; requireSeparateApprover: boolean; reason: string }) {
    await this.need(a.actor, 'ledger:policy', a.companyId);
    await this.company(tx, a.companyId);
    const before = await this.getSettings(tx, a.companyId);
    if (a.payablesAccountId) {
      const acc = await tx.account.findFirst({ where: { id: a.payablesAccountId, companyId: a.companyId } });
      if (!acc) throw unprocessable('The payables account does not exist in this company', 'unknown_account');
      if (!acc.isControl || acc.controlKind !== 'TRADE_PAYABLES') throw unprocessable('The payables account must be a TRADE_PAYABLES control account', 'payables_account_invalid');
    }
    if (before.payablesAccountId !== a.payablesAccountId && (await tx.purchaseDocument.count({ where: { companyId: a.companyId, status: 'APPROVED' } })) > 0) {
      throw conflict('Approved purchase documents already post to the payables account; it cannot change', 'payables_account_in_use');
    }
    if (before.numberingFrozen.bill && (a.billPrefix !== before.billPrefix || a.billStart !== before.billStart)) throw conflict('Bill numbering cannot change after the first bill is approved', 'numbering_frozen');
    if (before.numberingFrozen.debitNote && (a.debitNotePrefix !== before.debitNotePrefix || a.debitNoteStart !== before.debitNoteStart)) throw conflict('Debit note numbering cannot change after the first debit note is approved', 'numbering_frozen');
    const data = { payablesAccountId: a.payablesAccountId, billPrefix: a.billPrefix, debitNotePrefix: a.debitNotePrefix, billStart: a.billStart, debitNoteStart: a.debitNoteStart,
      requireSeparateApprover: a.requireSeparateApprover, updatedByUserId: a.actor.userId };
    await tx.purchaseSetting.upsert({ where: { organisationId_companyId: { organisationId: a.organisationId, companyId: a.companyId } }, create: { organisationId: a.organisationId, companyId: a.companyId, ...data }, update: data });
    const after = await this.getSettings(tx, a.companyId);
    await this.audit(tx, { action: 'purchases.settings_changed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'purchase_setting', entityId: a.companyId,
      before: { ...before, updatedAt: undefined }, after: { ...after, updatedAt: undefined }, reason: a.reason });
    return after;
  }

  // ───── Lines ─────
  private async supplier(tx: Tx, companyId: string, roleId: string) {
    const r = await tx.contactRole.findFirst({ where: { id: roleId, companyId } });
    if (!r || r.role !== 'SUPPLIER') throw unprocessable('The supplier must be a supplier role of this company', 'not_a_supplier');
    const profile = await tx.supplierProfile.findFirst({ where: { roleId } });
    return { role: r, profile };
  }

  /** Resolves each line's account (the supplier's default expense account when none is given) and checks accounts and VAT codes. */
  private async checkLines(tx: Tx, a: { companyId: string; issueDate: string; currency: string; base: string; lines: PurchaseLineInput[]; defaultAccountId?: string | null; allowedCodes?: Set<string>; inclusive: boolean }): Promise<Line[]> {
    const vat = await tx.companyVatSetting.findFirst({ where: { companyId: a.companyId } });
    const fx = await tx.companyFxSetting.findFirst({ where: { companyId: a.companyId } });
    const reserved = new Set([vat?.outputAccountId, vat?.inputAccountId, fx?.roundingAccountId, fx?.realisedAccountId, fx?.unrealisedAccountId].filter(Boolean) as string[]);
    const lines: Line[] = a.lines.map((l, i) => {
      const accountId = l.accountId ?? a.defaultAccountId;
      if (!accountId) throw unprocessable(`Line ${i + 1}: give an account (the supplier has no default expense account)`, 'account_required');
      return { description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, accountId, ...(l.taxCodeId ? { taxCodeId: l.taxCodeId } : {}) };
    });
    const accounts = new Map((await tx.account.findMany({ where: { companyId: a.companyId, id: { in: [...new Set(lines.map((l) => l.accountId))] } } })).map((x) => [x.id, x]));
    const d = toDate(a.issueDate);
    for (const [i, l] of lines.entries()) {
      const acc = accounts.get(l.accountId);
      if (!acc) throw unprocessable(`Line ${i + 1}: the account does not exist in this company`, 'unknown_account');
      if (acc.isControl) throw unprocessable(`Line ${i + 1}: ${acc.code} is a control account; purchase lines post to expense, asset or other non-control accounts`, 'control_account_restricted');
      if (reserved.has(acc.id)) throw unprocessable(`Line ${i + 1}: ${acc.code} is reserved for VAT or foreign-exchange postings`, 'system_account_restricted');
      if ((acc.activeFrom && d < acc.activeFrom) || (acc.activeTo && d > acc.activeTo)) throw unprocessable(`Line ${i + 1}: account ${acc.code} is not active on ${a.issueDate}`, 'account_inactive');
      if (l.taxCodeId) {
        if (a.currency !== a.base) throw unprocessable('VAT on foreign-currency documents comes with M5c (DEC-031, DEC-034)', 'vat_foreign_currency_not_supported');
        const code = await tx.taxCode.findFirst({ where: { id: l.taxCodeId } });
        if (!code) throw unprocessable(`Line ${i + 1}: unknown VAT code`, 'unknown_tax_code');
        if (code.direction === 'SALES') throw unprocessable(`Line ${i + 1}: ${code.code} is not a purchases VAT code`, 'tax_code_direction');
        if (code.reverseCharge && a.inclusive) throw unprocessable(`Line ${i + 1}: a reverse-charge line is entered net`, 'reverse_charge_inclusive_not_supported');
        if (a.allowedCodes && !a.allowedCodes.has(code.id)) throw unprocessable(`Line ${i + 1}: a debit note uses only VAT codes of its bill`, 'tax_code_not_on_bill');
      }
    }
    return lines;
  }

  /** Per-line amounts, the PostingService's arithmetic. Reverse charge adds no VAT to the document (the supplier charges none); the pair is posted. */
  private async compute(tx: Tx, a: { lines: Line[]; inclusive: boolean; taxPoint: string; minor: number; strict: boolean; pins?: Pins }) {
    const warnings: string[] = [];
    const out: { net: Money; vat: Money; gross: Money; entered: Money }[] = [];
    for (const [i, l] of a.lines.entries()) {
      const entered = lineAmount(money(l.quantity), money(l.unitPrice), a.minor);
      let vat = ZERO;
      if (l.taxCodeId) {
        const code = await tx.taxCode.findFirstOrThrow({ where: { id: l.taxCodeId } });
        let rate: Money | null = null;
        const pin = a.pins?.get(l.taxCodeId);
        try {
          if (pin) {
            const r = await tx.taxRate.findFirst({ where: { id: pin.taxRateId } });
            if (!r || r.verificationStatus !== 'VERIFIED') throw unprocessable(`Line ${i + 1}: the bill's VAT rate is not verified`, 'tax_rate_unverified');
            rate = r.rate;
          } else rate = (await this.vat.rateFor(tx, l.taxCodeId, a.taxPoint)).rate;
        } catch (e) {
          if (a.strict) throw e;
          warnings.push(`Line ${i + 1}: ${(e as Error).message}`);
        }
        if (rate && !rate.isZero() && !code.reverseCharge) vat = a.inclusive ? vatInGross(entered, rate, a.minor) : vatOnNet(entered, rate, a.minor);
      }
      const net = a.inclusive ? entered.minus(vat) : entered;
      if (a.strict && !net.greaterThan(0)) throw unprocessable(`Line ${i + 1}: the net amount must be greater than zero`, 'invalid_amount');
      out.push({ net, vat, gross: net.plus(vat), entered });
    }
    const sum = (k: 'net' | 'vat' | 'gross') => out.reduce((t, x) => t.plus(x[k]), ZERO);
    return { lines: out, net: sum('net'), vat: sum('vat'), gross: sum('gross'), warnings };
  }

  private async billPins(tx: Tx, bill: DocRow): Promise<Pins> {
    const lines = await tx.journalLine.findMany({ where: { journalId: bill.journalId!, vatRole: 'NET' }, select: { taxCodeId: true, taxRateId: true, taxPoint: true } });
    const pins: Pins = new Map();
    for (const l of lines) if (l.taxCodeId && l.taxRateId && l.taxPoint) pins.set(l.taxCodeId, { taxRateId: l.taxRateId, ratePoint: isoDay(l.taxPoint) });
    return pins;
  }
  private async writeLines(tx: Tx, doc: { organisationId: string; companyId: string; id: string }, revision: number, lines: Line[], amounts: { net: Money; vat: Money; gross: Money }[]) {
    await tx.purchaseDocumentLine.createMany({ data: lines.map((l, i) => ({
      organisationId: doc.organisationId, companyId: doc.companyId, documentId: doc.id, revision, lineNo: i + 1, description: l.description.trim(), quantity: money(l.quantity), unitPrice: money(l.unitPrice),
      accountId: l.accountId, taxCodeId: l.taxCodeId ?? null, net: amounts[i]!.net, vat: amounts[i]!.vat, gross: amounts[i]!.gross,
    })) });
  }
  private async currentLines(tx: Tx, d: DocRow) { return tx.purchaseDocumentLine.findMany({ where: { documentId: d.id, revision: d.revision }, orderBy: { lineNo: 'asc' } }); }
  private static asInput(l: LineRow): Line { return { description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), accountId: l.accountId, ...(l.taxCodeId ? { taxCodeId: l.taxCodeId } : {}) }; }

  // ───── Drafts ─────
  async createBill(tx: Tx, a: { organisationId: string; companyId: string; actor: PurchaseActor; supplierRoleId: string; supplierReference: string; issueDate: string; supplyDate?: string; taxPoint?: string;
    dueDate?: string; currency?: string; amountsIncludeVat: boolean; notes?: string; lines: PurchaseLineInput[] }) {
    await this.need(a.actor, 'purchases:manage', a.companyId);
    const company = await this.company(tx, a.companyId);
    const { role, profile } = await this.supplier(tx, a.companyId, a.supplierRoleId);
    if (role.status !== 'ACTIVE') throw conflict('An ended supplier role cannot be used on a new document', 'contact_role_ended');
    const currency = a.currency ?? profile?.defaultCurrency ?? company.baseCurrency;
    if (!(await tx.currency.findUnique({ where: { code: currency } }))) throw unprocessable(`${currency} is not a known currency`, 'unknown_currency');
    const lines = await this.checkLines(tx, { companyId: a.companyId, issueDate: a.issueDate, currency, base: company.baseCurrency, lines: a.lines, defaultAccountId: profile?.defaultExpenseAccountId, inclusive: a.amountsIncludeVat });
    const minor = await this.minorOf(tx, currency);
    const amounts = await this.compute(tx, { lines, inclusive: a.amountsIncludeVat, taxPoint: a.taxPoint ?? a.issueDate, minor, strict: false });
    const doc = await tx.purchaseDocument.create({ data: {
      organisationId: a.organisationId, companyId: a.companyId, kind: 'BILL', supplierRoleId: role.id, contactId: role.contactId, supplierReference: a.supplierReference.trim(), issueDate: toDate(a.issueDate),
      supplyDate: a.supplyDate ? toDate(a.supplyDate) : null, taxPoint: a.taxPoint ? toDate(a.taxPoint) : null, dueDate: toDate(a.dueDate ?? addDays(a.issueDate, profile?.paymentTermsDays ?? 0)),
      currency, amountsIncludeVat: a.amountsIncludeVat, notes: a.notes ?? null, netTotal: amounts.net, vatTotal: amounts.vat, grossTotal: amounts.gross, createdByUserId: a.actor.userId,
    } });
    await this.writeLines(tx, doc, 1, lines, amounts.lines);
    await this.audit(tx, { action: 'purchase_document.created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'purchase_document', entityId: doc.id,
      after: { kind: 'BILL', supplierRoleId: role.id, supplierReference: doc.supplierReference, currency, gross: fmt(amounts.gross, minor), lines: lines.length } });
    return this.get(tx, a.companyId, doc.id, amounts.warnings);
  }

  async createDebitNote(tx: Tx, a: { organisationId: string; companyId: string; actor: PurchaseActor; originalBillId: string; supplierReference?: string; issueDate: string; supplyDate?: string; taxPoint?: string;
    notes?: string; reason: string; lines?: PurchaseLineInput[] }) {
    await this.need(a.actor, 'purchases:manage', a.companyId);
    const company = await this.company(tx, a.companyId);
    const bill = await tx.purchaseDocument.findFirst({ where: { id: a.originalBillId, companyId: a.companyId } });
    if (!bill || bill.kind !== 'BILL') throw notFound('Bill not found');
    if (bill.status !== 'APPROVED') throw unprocessable('Only an approved bill can be credited', 'bill_not_approved');
    if (bill.outstanding.isZero()) throw unprocessable('The bill has nothing outstanding to credit', 'nothing_to_credit');
    if (a.issueDate < isoDay(bill.issueDate)) throw unprocessable('A debit note cannot be dated before its bill', 'invalid_date');
    let input = a.lines;
    if (!input) {
      if (!bill.outstanding.equals(bill.grossTotal)) throw unprocessable('Part of this bill is already settled or credited; give the lines to credit', 'debit_lines_required');
      input = (await this.currentLines(tx, bill)).map(PurchasesService.asInput);
    }
    const pins = await this.billPins(tx, bill);
    const allowed = new Set((await this.currentLines(tx, bill)).map((l) => l.taxCodeId).filter(Boolean) as string[]);
    const profile = await tx.supplierProfile.findFirst({ where: { roleId: bill.supplierRoleId } });
    const lines = await this.checkLines(tx, { companyId: a.companyId, issueDate: a.issueDate, currency: bill.currency, base: company.baseCurrency, lines: input, defaultAccountId: profile?.defaultExpenseAccountId, allowedCodes: allowed, inclusive: bill.amountsIncludeVat });
    const minor = await this.minorOf(tx, bill.currency);
    const amounts = await this.compute(tx, { lines, inclusive: bill.amountsIncludeVat, taxPoint: a.taxPoint ?? a.issueDate, minor, strict: false, pins });
    const doc = await tx.purchaseDocument.create({ data: {
      organisationId: a.organisationId, companyId: a.companyId, kind: 'DEBIT_NOTE', supplierRoleId: bill.supplierRoleId, contactId: bill.contactId, supplierReference: a.supplierReference?.trim() ?? null,
      issueDate: toDate(a.issueDate), supplyDate: a.supplyDate ? toDate(a.supplyDate) : null, taxPoint: a.taxPoint ? toDate(a.taxPoint) : null, dueDate: toDate(a.issueDate), currency: bill.currency,
      amountsIncludeVat: bill.amountsIncludeVat, notes: a.notes ?? null, originalBillId: bill.id, debitReason: a.reason.trim(), netTotal: amounts.net, vatTotal: amounts.vat, grossTotal: amounts.gross, createdByUserId: a.actor.userId,
    } });
    await this.writeLines(tx, doc, 1, lines, amounts.lines);
    await this.audit(tx, { action: 'purchase_document.created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'purchase_document', entityId: doc.id,
      after: { kind: 'DEBIT_NOTE', originalBillId: bill.id, currency: bill.currency, gross: fmt(amounts.gross, minor), lines: lines.length }, reason: a.reason });
    const w = amounts.gross.greaterThan(bill.outstanding) ? [`The debit note (${fmt(amounts.gross, minor)}) exceeds what is outstanding on the bill (${fmt(bill.outstanding, minor)}); it cannot be approved as it stands`] : [];
    return this.get(tx, a.companyId, doc.id, [...amounts.warnings, ...w]);
  }

  async updateDraft(tx: Tx, a: { organisationId: string; companyId: string; actor: PurchaseActor; id: string; revision: number; supplierReference?: string; issueDate?: string; supplyDate?: string | null;
    taxPoint?: string | null; dueDate?: string; notes?: string | null; amountsIncludeVat?: boolean; reason?: string; lines?: PurchaseLineInput[] }) {
    await this.need(a.actor, 'purchases:manage', a.companyId);
    const company = await this.company(tx, a.companyId);
    await tx.$queryRaw`SELECT id FROM purchase_document WHERE id = ${a.id}::uuid FOR UPDATE`;
    const d = await tx.purchaseDocument.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!d) throw notFound('Purchase document not found');
    if (d.status !== 'DRAFT') throw conflict(`An ${d.status.toLowerCase()} document cannot be edited${d.status === 'APPROVED' ? '; correct it with a debit note' : ''}`, 'document_not_draft');
    if (d.revision !== a.revision) throw conflict(`The draft was changed by someone else (now revision ${d.revision})`, 'stale_revision', { revision: d.revision });
    if (d.kind === 'DEBIT_NOTE' && a.amountsIncludeVat !== undefined && a.amountsIncludeVat !== d.amountsIncludeVat) throw unprocessable('A debit note follows its bill on VAT-inclusive amounts', 'invalid_amount');
    if (d.kind === 'BILL' && a.reason !== undefined) throw unprocessable('A reason belongs to a debit note', 'invalid_field');
    const issueDate = a.issueDate ?? isoDay(d.issueDate);
    const taxPoint = a.taxPoint === undefined ? (d.taxPoint ? isoDay(d.taxPoint) : null) : a.taxPoint;
    const inclusive = a.amountsIncludeVat ?? d.amountsIncludeVat;
    const input: PurchaseLineInput[] = a.lines ?? (await this.currentLines(tx, d)).map(PurchasesService.asInput);
    let pins: Pins | undefined; let allowed: Set<string> | undefined;
    if (d.kind === 'DEBIT_NOTE') {
      const bill = await tx.purchaseDocument.findFirstOrThrow({ where: { id: d.originalBillId! } });
      if (issueDate < isoDay(bill.issueDate)) throw unprocessable('A debit note cannot be dated before its bill', 'invalid_date');
      pins = await this.billPins(tx, bill);
      allowed = new Set((await this.currentLines(tx, bill)).map((l) => l.taxCodeId).filter(Boolean) as string[]);
    }
    const profile = await tx.supplierProfile.findFirst({ where: { roleId: d.supplierRoleId } });
    const lines = await this.checkLines(tx, { companyId: a.companyId, issueDate, currency: d.currency, base: company.baseCurrency, lines: input, defaultAccountId: profile?.defaultExpenseAccountId, allowedCodes: allowed, inclusive });
    const minor = await this.minorOf(tx, d.currency);
    const amounts = await this.compute(tx, { lines, inclusive, taxPoint: taxPoint ?? issueDate, minor, strict: false, pins });
    const dueDate = a.dueDate ?? (d.kind === 'DEBIT_NOTE' ? issueDate : isoDay(d.dueDate) < issueDate ? issueDate : isoDay(d.dueDate));
    if (dueDate < issueDate) throw unprocessable('dueDate cannot precede issueDate', 'invalid_date');
    const revision = d.revision + 1;
    await tx.purchaseDocument.update({ where: { id: d.id }, data: {
      revision, supplierReference: a.supplierReference?.trim() ?? d.supplierReference, issueDate: toDate(issueDate), supplyDate: a.supplyDate === undefined ? d.supplyDate : a.supplyDate ? toDate(a.supplyDate) : null,
      taxPoint: taxPoint ? toDate(taxPoint) : null, dueDate: toDate(dueDate), notes: a.notes === undefined ? d.notes : a.notes, amountsIncludeVat: inclusive, debitReason: a.reason?.trim() ?? d.debitReason,
      netTotal: amounts.net, vatTotal: amounts.vat, grossTotal: amounts.gross,
    } });
    await this.writeLines(tx, d, revision, lines, amounts.lines);
    await this.audit(tx, { action: 'purchase_document.updated', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'purchase_document', entityId: d.id,
      before: { revision: d.revision, gross: fmt(d.grossTotal, minor) }, after: { revision, gross: fmt(amounts.gross, minor), lines: lines.length } });
    return this.get(tx, a.companyId, d.id, amounts.warnings);
  }

  async discard(tx: Tx, a: { organisationId: string; companyId: string; actor: PurchaseActor; id: string; reason: string }) {
    await this.need(a.actor, 'purchases:manage', a.companyId);
    const d = await tx.purchaseDocument.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!d) throw notFound('Purchase document not found');
    if (d.status !== 'DRAFT') throw conflict(d.status === 'APPROVED' ? 'An approved document is never discarded; correct it with a debit note' : 'This draft was already discarded', 'document_not_draft');
    const upd = await tx.purchaseDocument.updateMany({ where: { id: d.id, status: 'DRAFT' }, data: { status: 'DISCARDED', discardedByUserId: a.actor.userId, discardedAt: new Date(), discardedReason: a.reason.trim() } });
    if (upd.count !== 1) throw conflict('The draft changed concurrently', 'document_not_draft');
    await this.audit(tx, { action: 'purchase_document.discarded', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'purchase_document', entityId: d.id,
      before: { status: 'DRAFT' }, after: { status: 'DISCARDED' }, reason: a.reason });
    return this.get(tx, a.companyId, d.id);
  }

  // ───── Approval ─────
  async approve(tx: Tx, a: { organisationId: string; companyId: string; actor: PurchaseActor; id: string; duplicateOverrideReason?: string }) {
    await this.need(a.actor, 'purchases:approve', a.companyId);
    const company = await this.company(tx, a.companyId);
    await tx.$queryRaw`SELECT id FROM purchase_document WHERE id = ${a.id}::uuid FOR UPDATE`;
    const d = await tx.purchaseDocument.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!d) throw notFound('Purchase document not found');
    if (d.status !== 'DRAFT') throw conflict(`This document is already ${d.status.toLowerCase()}`, 'document_not_draft');
    const settings = await tx.purchaseSetting.findFirst({ where: { companyId: a.companyId } });
    if (!settings?.payablesAccountId) throw unprocessable('Set the payables control account in the purchase settings first', 'purchase_settings_missing');
    if (settings.requireSeparateApprover && d.createdByUserId === a.actor.userId) throw forbidden('This company requires a different person to approve a purchase document', 'separate_approver_required');
    const { role } = await this.supplier(tx, a.companyId, d.supplierRoleId);
    if (role.status !== 'ACTIVE') throw conflict('The supplier role has ended; reactivate it to approve this document', 'contact_role_ended');
    const issueDate = isoDay(d.issueDate);
    const taxPoint = d.taxPoint ? isoDay(d.taxPoint) : issueDate;
    if (d.currency !== company.baseCurrency) {
      const vs = await tx.companyVatSetting.findFirst({ where: { companyId: a.companyId } });
      if (vs?.registered && vs.registeredFrom && taxPoint >= isoDay(vs.registeredFrom)) {
        throw unprocessable('A VAT-registered company cannot approve a foreign-currency purchase document until VAT on foreign-currency documents is delivered (M5c, DEC-031, DEC-034)', 'vat_foreign_currency_not_supported');
      }
    }
    let bill: DocRow | null = null; let pins: Pins | undefined; let allowed: Set<string> | undefined;
    if (d.kind === 'DEBIT_NOTE') {
      await tx.$queryRaw`SELECT id FROM purchase_document WHERE id = ${d.originalBillId}::uuid FOR UPDATE`;
      bill = await tx.purchaseDocument.findFirstOrThrow({ where: { id: d.originalBillId! } });
      pins = await this.billPins(tx, bill);
      allowed = new Set((await this.currentLines(tx, bill)).map((l) => l.taxCodeId).filter(Boolean) as string[]);
    }
    const stored = await this.currentLines(tx, d);
    if (stored.length === 0) throw unprocessable('A document needs at least one line', 'too_few_lines');
    const lines = await this.checkLines(tx, { companyId: a.companyId, issueDate, currency: d.currency, base: company.baseCurrency, lines: stored.map(PurchasesService.asInput), allowedCodes: allowed, inclusive: d.amountsIncludeVat });
    const minor = await this.minorOf(tx, d.currency);
    const amounts = await this.compute(tx, { lines, inclusive: d.amountsIncludeVat, taxPoint, minor, strict: true, pins });
    if (bill && amounts.gross.greaterThan(bill.outstanding)) {
      throw unprocessable(`The debit note (${fmt(amounts.gross, minor)}) exceeds what is outstanding on bill ${bill.documentNumber} (${fmt(bill.outstanding, minor)})`, 'debit_exceeds_outstanding');
    }
    // duplicate check (DEC-034): the supplier's own number (case and spaces ignored), or the same date, currency and total
    let possibleDuplicates: string[] = [];
    if (d.kind === 'BILL') {
      const ref = normaliseSupplierReference(d.supplierReference ?? '');
      const byRef = await tx.$queryRaw<{ document_number: string }[]>`
        SELECT document_number FROM purchase_document WHERE company_id = ${a.companyId}::uuid AND kind = 'BILL' AND status = 'APPROVED' AND supplier_role_id = ${d.supplierRoleId}::uuid
           AND id <> ${d.id}::uuid AND upper(regexp_replace(supplier_reference, '\\s', '', 'g')) = ${ref} LIMIT 5`;
      const bySum = await tx.purchaseDocument.findMany({ where: { companyId: a.companyId, kind: 'BILL', status: 'APPROVED', supplierRoleId: d.supplierRoleId, id: { not: d.id },
        issueDate: d.issueDate, currency: d.currency, grossTotal: amounts.gross }, select: { documentNumber: true }, take: 5 });
      possibleDuplicates = [...new Set([...byRef.map((x) => x.document_number), ...bySum.map((x) => x.documentNumber!)])];
      if (possibleDuplicates.length > 0 && !a.duplicateOverrideReason) {
        throw conflict(`Possible duplicate of ${possibleDuplicates.join(', ')} (same supplier and the same supplier reference, or the same date and total); approve with a duplicateOverrideReason if it is genuine`, 'possible_duplicate', { documents: possibleDuplicates });
      }
    }
    const changed = !amounts.gross.equals(d.grossTotal) || !amounts.vat.equals(d.vatTotal) || stored.some((l, i) => !l.net.equals(amounts.lines[i]!.net) || !l.vat.equals(amounts.lines[i]!.vat));
    if (changed) {
      await tx.purchaseDocument.update({ where: { id: d.id }, data: { revision: d.revision + 1, netTotal: amounts.net, vatTotal: amounts.vat, grossTotal: amounts.gross } });
      await this.writeLines(tx, d, d.revision + 1, lines, amounts.lines);
    }
    const start = d.kind === 'BILL' ? settings.billStart : settings.debitNoteStart;
    const seq = await tx.$queryRaw<{ last_number: number }[]>`
      INSERT INTO purchase_sequence (organisation_id, company_id, kind, last_number) VALUES (${a.organisationId}::uuid, ${a.companyId}::uuid, ${d.kind}, ${start})
      ON CONFLICT (organisation_id, company_id, kind) DO UPDATE SET last_number = purchase_sequence.last_number + 1 RETURNING last_number`;
    const number = seq[0]!.last_number;
    const documentNumber = `${d.kind === 'BILL' ? settings.billPrefix : settings.debitNotePrefix}${number}`;
    const snapshot = await buildContactSnapshot(tx, d.supplierRoleId);
    // a bill: Dr lines (+ input VAT or the reverse-charge pair, added by the PostingService) / Cr payables; a debit note mirrors it at the bill's VAT rates
    const isBill = d.kind === 'BILL';
    const g = fmt(amounts.gross, minor);
    const journalLines: PostLineInput[] = [
      { accountId: settings.payablesAccountId, debit: isBill ? '0' : g, credit: isBill ? g : '0', description: `${documentNumber} ${snapshot.name}${d.supplierReference ? ` (${d.supplierReference})` : ''}`.slice(0, 300) },
      ...lines.map((l, i): PostLineInput => {
        const e = fmt(amounts.lines[i]!.entered, minor);
        return { accountId: l.accountId, debit: isBill ? e : '0', credit: isBill ? '0' : e, description: l.description.slice(0, 300),
          ...(l.taxCodeId ? { taxCodeId: l.taxCodeId, ...(pins?.get(l.taxCodeId) ? { vatRate: pins.get(l.taxCodeId)! } : {}) } : {}) };
      }),
    ];
    const coded = lines.some((l) => l.taxCodeId);
    const journal = await this.posting.post(tx, {
      organisationId: a.organisationId, companyId: a.companyId, journalDate: issueDate, sourceType: isBill ? 'PURCHASE_BILL' : 'PURCHASE_DEBIT_NOTE', sourceId: d.id, sourceReference: d.supplierReference ?? documentNumber,
      description: `${isBill ? 'Supplier bill' : 'Supplier debit note'} ${documentNumber} - ${snapshot.name}${d.supplierReference ? ` ${d.supplierReference}` : ''}${bill ? ` (credits ${bill.documentNumber})` : ''}`.slice(0, 500),
      ...(d.currency !== company.baseCurrency ? { currency: d.currency } : {}),
      ...(coded ? { amountsIncludeVat: d.amountsIncludeVat, taxPoint } : {}),
      lines: journalLines, idempotencyKey: `purchases:${d.id}:approve`, actor: a.actor,
    });
    const pay = await tx.journalLine.findFirstOrThrow({ where: { journalId: journal.id, lineNo: 1 } });
    const functionalGross = pay.debit.plus(pay.credit);
    await tx.purchaseDocument.update({ where: { id: d.id }, data: {
      status: 'APPROVED', number, documentNumber, journalId: journal.id, approvedByUserId: a.actor.userId, approvedAt: new Date(), contactSnapshot: snapshot as unknown as Prisma.InputJsonValue,
      outstanding: amounts.gross, functionalGross, functionalOutstanding: functionalGross, exchangeRateId: pay.exchangeRateId, rate: pay.rate,
      duplicateOverrideReason: possibleDuplicates.length > 0 ? a.duplicateOverrideReason!.trim() : null,
    } });
    await this.audit(tx, { action: 'purchase_document.approved', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'purchase_document', entityId: d.id,
      before: { status: 'DRAFT' }, after: { status: 'APPROVED', documentNumber, supplierReference: d.supplierReference, gross: g, currency: d.currency, journalId: journal.id },
      reason: a.duplicateOverrideReason ?? null, metadata: { possibleDuplicates, duplicateOverride: possibleDuplicates.length > 0, preparedBy: d.createdByUserId } });
    const base = { documentId: d.id, companyId: a.companyId, documentNumber, supplierRoleId: d.supplierRoleId, supplierReference: d.supplierReference, issueDate, currency: d.currency, gross: g, journalId: journal.id };
    if (isBill) await publishEvent(tx, Events.billApproved, { aggregateId: d.id, organisationId: a.organisationId, actorUserId: a.actor.userId, payload: { ...base, dueDate: isoDay(d.dueDate) } });
    else {
      await publishEvent(tx, Events.debitNoteApproved, { aggregateId: d.id, organisationId: a.organisationId, actorUserId: a.actor.userId, payload: { ...base, originalBillId: bill!.id } });
      await this.allocate(tx, { organisationId: a.organisationId, companyId: a.companyId, actor: a.actor, billId: bill!.id, debitId: d.id, amount: amounts.gross, date: issueDate });
    }
    return this.get(tx, a.companyId, d.id);
  }

  // ───── Allocation (DEC-030 mirrored): payables are credit-normal, so a bill that carried more than the debit note or payment releases leaves a credit: a gain ─────
  async allocate(tx: Tx, a: { organisationId: string; companyId: string; actor: PurchaseActor; billId: string; debitId?: string; paymentId?: string; amount: Money; date: string }) {
    await this.need(a.actor, 'purchases:approve', a.companyId);
    if (!!a.debitId === !!a.paymentId) throw unprocessable('An allocation applies either a debit note or a payment', 'invalid_allocation');
    await tx.$queryRaw`SELECT id FROM purchase_document WHERE id IN (${a.billId}::uuid, ${a.debitId ?? a.billId}::uuid) ORDER BY id FOR UPDATE`;
    if (a.paymentId) await tx.$queryRaw`SELECT id FROM purchase_payment WHERE id = ${a.paymentId}::uuid FOR UPDATE`;
    const bill = await tx.purchaseDocument.findFirst({ where: { id: a.billId, companyId: a.companyId } });
    if (!bill || bill.kind !== 'BILL') throw notFound('Bill not found');
    if (bill.status !== 'APPROVED') throw unprocessable('Only approved bills are allocated to', 'document_not_approved');
    let src: { label: string; supplierRoleId: string; currency: string; outstanding: Money; functionalOutstanding: Money };
    if (a.debitId) {
      const dn = await tx.purchaseDocument.findFirst({ where: { id: a.debitId, companyId: a.companyId } });
      if (!dn) throw notFound('Purchase document not found');
      if (dn.status !== 'APPROVED') throw unprocessable('Only approved documents are allocated', 'document_not_approved');
      src = { label: dn.documentNumber!, supplierRoleId: dn.supplierRoleId, currency: dn.currency, outstanding: dn.outstanding, functionalOutstanding: dn.functionalOutstanding };
    } else {
      const p = await tx.purchasePayment.findFirst({ where: { id: a.paymentId!, companyId: a.companyId } });
      if (!p) throw notFound('Payment not found');
      if (p.status !== 'POSTED') throw unprocessable('A reversed payment cannot be allocated', 'payment_reversed');
      src = { label: `payment ${p.reference ?? isoDay(p.paymentDate)}`, supplierRoleId: p.supplierRoleId, currency: p.currency, outstanding: p.outstanding, functionalOutstanding: p.functionalOutstanding };
    }
    if (src.supplierRoleId !== bill.supplierRoleId || src.currency !== bill.currency) throw unprocessable('An allocation joins documents of one supplier and currency', 'allocation_mismatch');
    if (!a.amount.greaterThan(0)) throw unprocessable('An allocation must be greater than zero', 'invalid_amount');
    if (a.amount.greaterThan(bill.outstanding) || a.amount.greaterThan(src.outstanding)) throw unprocessable('An allocation cannot exceed what is outstanding on either side', 'allocation_exceeds_outstanding');
    const company = await this.company(tx, a.companyId);
    const fm = await this.minorOf(tx, company.baseCurrency);
    const billFunctional = releaseShare(bill.functionalOutstanding, bill.outstanding, a.amount, fm);
    const debitFunctional = releaseShare(src.functionalOutstanding, src.outstanding, a.amount, fm);
    const diff = billFunctional.minus(debitFunctional);
    const id = randomUUID();
    let fxJournalId: string | null = null;
    if (!diff.isZero()) {
      const fx = await tx.companyFxSetting.findFirst({ where: { companyId: a.companyId } });
      if (!fx?.realisedAccountId) throw unprocessable('This allocation realises an exchange difference but the company has no realised-FX account; designate one in the FX settings', 'fx_realised_account_missing');
      const settings = await tx.purchaseSetting.findFirstOrThrow({ where: { companyId: a.companyId } });
      const amt = fmt(diff.abs(), fm);
      const gain = diff.greaterThan(0);
      const j = await this.posting.post(tx, {
        organisationId: a.organisationId, companyId: a.companyId, journalDate: a.date, sourceType: 'PURCHASE_ALLOCATION_FX', sourceId: id, sourceReference: `${bill.documentNumber}/${src.label}`.slice(0, 100),
        description: `Realised exchange ${gain ? 'gain' : 'loss'}: ${src.label} allocated to ${bill.documentNumber} (${fmt(a.amount, await this.minorOf(tx, bill.currency))} ${bill.currency})`.slice(0, 500),
        lines: [
          { accountId: settings.payablesAccountId!, debit: gain ? amt : '0', credit: gain ? '0' : amt, description: `FX on ${bill.documentNumber}`, adjustsCurrency: bill.currency },
          { accountId: fx.realisedAccountId, debit: gain ? '0' : amt, credit: gain ? amt : '0', description: 'Realised FX' },
        ],
        idempotencyKey: `purchase-allocation:${id}`, actor: a.actor,
      });
      fxJournalId = j.id;
    }
    const row = await tx.purchaseAllocation.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, billId: bill.id, debitId: a.debitId ?? null, paymentId: a.paymentId ?? null, amount: a.amount,
      billFunctional, debitFunctional, fxDifference: diff, fxJournalId, allocatedOn: toDate(a.date), createdByUserId: a.actor.userId } });
    await this.audit(tx, { action: 'purchase_allocation.created', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'purchase_allocation', entityId: id,
      after: { bill: bill.documentNumber, credit: src.label, paymentId: a.paymentId ?? null, amount: a.amount.toFixed(4), currency: bill.currency, realisedFx: fmt(diff, fm), fxJournalId } });
    return this.allocationView(row, fm);
  }

  private allocationView(r: AllocRow, fm: number) {
    return { id: r.id, billId: r.billId, debitId: r.debitId, paymentId: r.paymentId, amount: r.amount.toFixed(4), billFunctional: fmt(r.billFunctional, fm), debitFunctional: fmt(r.debitFunctional, fm),
      /** Positive = gain, negative = loss, in the company currency. */
      realisedFx: fmt(r.fxDifference, fm), fxJournalId: r.fxJournalId, allocatedOn: isoDay(r.allocatedOn), createdByUserId: r.createdByUserId, createdAt: r.createdAt };
  }

  // ───── Reads ─────
  private view(d: DocRow, lines: LineRow[], minor: number, fm: number) {
    const m = (v: Money) => fmt(v, minor);
    const effectiveTaxPoint = d.taxPoint ? isoDay(d.taxPoint) : isoDay(d.issueDate);
    return {
      id: d.id, companyId: d.companyId, kind: d.kind as PurchaseDocumentKind, status: d.status, paymentStatus: paymentStatus(d), number: d.number, documentNumber: d.documentNumber,
      supplierRoleId: d.supplierRoleId, contactId: d.contactId, supplierReference: d.supplierReference, issueDate: isoDay(d.issueDate), supplyDate: d.supplyDate ? isoDay(d.supplyDate) : null, taxPoint: effectiveTaxPoint,
      taxPointExplicit: !!d.taxPoint, taxPointReview: !!d.supplyDate && isoDay(d.supplyDate) !== effectiveTaxPoint, dueDate: isoDay(d.dueDate), currency: d.currency, amountsIncludeVat: d.amountsIncludeVat,
      notes: d.notes, originalBillId: d.originalBillId, debitReason: d.debitReason, revision: d.revision,
      totals: { net: m(d.netTotal), vat: m(d.vatTotal), gross: m(d.grossTotal) }, outstanding: m(d.outstanding),
      functional: d.functionalGross ? { gross: fmt(d.functionalGross, fm), outstanding: fmt(d.functionalOutstanding, fm) } : null,
      rate: d.rate ? d.rate.toFixed(8) : null, exchangeRateId: d.exchangeRateId, journalId: d.journalId, contactSnapshot: d.contactSnapshot, duplicateOverrideReason: d.duplicateOverrideReason,
      createdByUserId: d.createdByUserId, approvedByUserId: d.approvedByUserId, approvedAt: d.approvedAt, discardedByUserId: d.discardedByUserId, discardedAt: d.discardedAt, discardedReason: d.discardedReason,
      createdAt: d.createdAt, updatedAt: d.updatedAt,
      lines: lines.map((l) => ({ lineNo: l.lineNo, description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), accountId: l.accountId, taxCodeId: l.taxCodeId, net: m(l.net), vat: m(l.vat), gross: m(l.gross) })),
    };
  }

  async get(tx: Tx, companyId: string, id: string, warnings: string[] = []) {
    const d = await tx.purchaseDocument.findFirst({ where: { id, companyId } });
    if (!d) throw notFound('Purchase document not found');
    const company = await this.company(tx, companyId);
    const [minor, fm, lines, allocs, debits] = await Promise.all([this.minorOf(tx, d.currency), this.minorOf(tx, company.baseCurrency), this.currentLines(tx, d),
      tx.purchaseAllocation.findMany({ where: { OR: [{ billId: d.id }, { debitId: d.id }] }, orderBy: { createdAt: 'asc' } }),
      d.kind === 'BILL' ? tx.purchaseDocument.findMany({ where: { originalBillId: d.id }, select: { id: true, documentNumber: true, status: true }, orderBy: { createdAt: 'asc' } }) : Promise.resolve([])]);
    return { ...this.view(d, lines, minor, fm), allocations: allocs.map((r) => this.allocationView(r, fm)), debitNotes: debits, warnings };
  }

  async list(tx: Tx, companyId: string, q: { kind?: string; status?: string; paymentStatus?: string; supplierRoleId?: string; from?: string; to?: string; limit: number; cursor?: string }) {
    const company = await this.company(tx, companyId);
    const fm = await this.minorOf(tx, company.baseCurrency);
    const f = tx.purchaseDocument.fields;
    const ps: Prisma.PurchaseDocumentWhereInput = !q.paymentStatus ? {}
      : ['PAID', 'ALLOCATED'].includes(q.paymentStatus) ? { status: 'APPROVED', outstanding: 0, kind: q.paymentStatus === 'PAID' ? 'BILL' : 'DEBIT_NOTE' }
      : ['UNPAID', 'UNALLOCATED'].includes(q.paymentStatus) ? { status: 'APPROVED', outstanding: { equals: f.grossTotal }, kind: q.paymentStatus === 'UNPAID' ? 'BILL' : 'DEBIT_NOTE' }
      : { status: 'APPROVED', outstanding: { gt: 0, lt: f.grossTotal }, kind: q.paymentStatus === 'PART_PAID' ? 'BILL' : 'DEBIT_NOTE' };
    const rows = await tx.purchaseDocument.findMany({
      where: { companyId, ...(q.kind ? { kind: q.kind } : {}), ...(q.status ? { status: q.status } : {}), ...(q.supplierRoleId ? { supplierRoleId: q.supplierRoleId } : {}),
        ...(q.from || q.to ? { issueDate: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } } : {}), ...ps },
      orderBy: [{ issueDate: 'desc' }, { id: 'desc' }], take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const minors = new Map<string, number>();
    for (const c of new Set(rows.map((r) => r.currency))) minors.set(c, await this.minorOf(tx, c));
    const items = rows.slice(0, q.limit).map((d) => { const { lines: _l, ...v } = this.view(d, [], minors.get(d.currency)!, fm); return v; });
    return { items, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  /** Payables reconciliation: open items per currency against the (credit-normal) payables control account, other postings named by journal source. */
  async reconciliation(tx: Tx, companyId: string) {
    const company = await this.company(tx, companyId);
    const fm = await this.minorOf(tx, company.baseCurrency);
    const settings = await tx.purchaseSetting.findFirst({ where: { companyId } });
    if (!settings?.payablesAccountId) throw unprocessable('Set the payables control account in the purchase settings first', 'purchase_settings_missing');
    const docs = await tx.purchaseDocument.groupBy({ by: ['currency', 'kind'], where: { companyId, status: 'APPROVED' }, _sum: { outstanding: true, functionalOutstanding: true } });
    const payments = await tx.purchasePayment.groupBy({ by: ['currency'], where: { companyId, status: 'POSTED' }, _sum: { outstanding: true, functionalOutstanding: true } });
    const ledger = await tx.$queryRaw<{ currency: string; source_type: string; original: string; functional: string }[]>`
      SELECT coalesce(l.original_currency, l.adjusts_currency, ${company.baseCurrency}) AS currency, j.source_type,
             sum(CASE WHEN l.original_currency IS NOT NULL THEN l.original_credit - l.original_debit WHEN l.adjusts_currency IS NOT NULL THEN 0 ELSE l.credit - l.debit END)::text AS original,
             sum(l.credit - l.debit)::text AS functional
        FROM journal_line l JOIN journal j ON j.id = l.journal_id AND j.organisation_id = l.organisation_id
       WHERE l.company_id = ${companyId}::uuid AND l.account_id = ${settings.payablesAccountId}::uuid
       GROUP BY 1, 2`;
    const currencies = [...new Set([...docs.map((d) => d.currency), ...payments.map((x) => x.currency), ...ledger.map((l) => l.currency)])].sort();
    const SUB = new Set(['PURCHASE_BILL', 'PURCHASE_DEBIT_NOTE', 'PURCHASE_ALLOCATION_FX', 'PURCHASE_PAYMENT', 'PURCHASE_PAYMENT_REVERSAL']);
    const rows = [];
    for (const c of currencies) {
      const minor = await this.minorOf(tx, c);
      const sumDocs = (k: 'outstanding' | 'functionalOutstanding') => docs.filter((d) => d.currency === c).reduce((t, d) => (d.kind === 'BILL' ? t.plus(d._sum[k] ?? 0) : t.minus(d._sum[k] ?? 0)), ZERO)
        .minus(money(payments.find((x) => x.currency === c)?._sum[k] ?? 0));
      const led = ledger.filter((l) => l.currency === c);
      const sub = (rowsOf: typeof led, k: 'original' | 'functional') => rowsOf.reduce((t, l) => t.plus(money(l[k])), ZERO);
      const fromDocs = led.filter((l) => SUB.has(l.source_type)), other = led.filter((l) => !SUB.has(l.source_type));
      const openItems = sumDocs('outstanding'), openFunctional = sumDocs('functionalOutstanding');
      const ctl = sub(fromDocs, 'original'), ctlF = sub(fromDocs, 'functional');
      rows.push({
        currency: c, openItems: fmt(openItems, minor), openItemsFunctional: fmt(openFunctional, fm),
        control: { fromPurchaseDocuments: fmt(ctl, minor), fromPurchaseDocumentsFunctional: fmt(ctlF, fm), total: fmt(sub(led, 'original'), minor), totalFunctional: fmt(sub(led, 'functional'), fm) },
        difference: fmt(ctl.minus(openItems), minor), differenceFunctional: fmt(ctlF.minus(openFunctional), fm),
        otherPostings: other.map((l) => ({ sourceType: l.source_type, original: fmt(money(l.original), minor), functional: fmt(money(l.functional), fm) })),
      });
    }
    return { companyId, payablesAccountId: settings.payablesAccountId, functionalCurrency: company.baseCurrency, currencies: rows,
      reconciled: rows.every((r) => money(r.difference).isZero() && money(r.differenceFunctional).isZero()) };
  }

  // ───── Supplier payments (M6b, DEC-035): posted when recorded; allocated at entry or later; reversed only while unallocated ─────
  private async bankAccount(tx: Tx, companyId: string, id: string, date: string) {
    const a = await tx.account.findFirst({ where: { id, companyId } });
    if (!a) throw unprocessable('The bank account does not exist in this company', 'unknown_account');
    if (!['CURRENT_ASSET_BANK', 'CURRENT_ASSET_CASH'].includes(a.subtype)) throw unprocessable(`Account ${a.code} is not a bank or cash account`, 'not_a_bank_account');
    const d = toDate(date);
    if ((a.activeFrom && d < a.activeFrom) || (a.activeTo && d > a.activeTo)) throw unprocessable(`Account ${a.code} is not active on ${date}`, 'account_inactive');
  }

  async recordPayment(tx: Tx, a: { organisationId: string; companyId: string; actor: PurchaseActor; supplierRoleId: string; paymentDate: string; currency?: string; amount: string; bankAccountId: string;
    reference?: string; notes?: string; rateId?: string; allocations: { billId: string; amount: string }[]; duplicateOverrideReason?: string }) {
    await this.need(a.actor, 'purchases:approve', a.companyId);
    const company = await this.company(tx, a.companyId);
    const { role, profile } = await this.supplier(tx, a.companyId, a.supplierRoleId);
    if (role.status !== 'ACTIVE') throw conflict('An ended supplier role cannot receive new payments; reactivate it first', 'contact_role_ended');
    const settings = await tx.purchaseSetting.findFirst({ where: { companyId: a.companyId } });
    if (!settings?.payablesAccountId) throw unprocessable('Set the payables control account in the purchase settings first', 'purchase_settings_missing');
    const currency = a.currency ?? company.baseCurrency;
    const cur = await tx.currency.findUnique({ where: { code: currency } });
    if (!cur) throw unprocessable(`${currency} is not a known currency`, 'unknown_currency');
    const amount = money(a.amount);
    if (!amount.greaterThan(0) || amount.decimalPlaces() > cur.minorUnits) throw unprocessable(`The amount must be greater than zero with at most ${cur.minorUnits} decimal places`, 'invalid_amount');
    if (a.rateId && currency === company.baseCurrency) throw unprocessable('A rate applies only to foreign-currency payments', 'rate_not_applicable');
    await this.bankAccount(tx, a.companyId, a.bankAccountId, a.paymentDate);
    const allocated = a.allocations.reduce((t, x) => t.plus(money(x.amount)), ZERO);
    if (allocated.greaterThan(amount)) throw unprocessable('The allocations exceed the payment', 'allocation_exceeds_outstanding');
    if (new Set(a.allocations.map((x) => x.billId)).size !== a.allocations.length) throw unprocessable('Each bill appears once in the allocations', 'invalid_allocation');
    const dups = await tx.purchasePayment.findMany({ where: { companyId: a.companyId, supplierRoleId: role.id, status: 'POSTED',
      OR: [{ paymentDate: toDate(a.paymentDate), currency, amount }, ...(a.reference ? [{ reference: a.reference }] : [])] }, select: { id: true }, take: 5 });
    if (dups.length > 0 && !a.duplicateOverrideReason) throw conflict('Possible duplicate of an earlier payment to this supplier (same date, currency and amount, or the same reference); record it with a duplicateOverrideReason if it is genuine', 'possible_duplicate', { payments: dups.map((d) => d.id) });
    // DEC-035: recorded, never blocked (the money has gone); the flag lets a review catch payment diversion
    const bankDetailsUnverified = profile?.bankDetailsStatus === 'UNVERIFIED';
    const id = randomUUID();
    const name = (await tx.contact.findFirstOrThrow({ where: { id: role.contactId }, select: { name: true } })).name;
    const amt = fmt(amount, cur.minorUnits);
    const j = await this.posting.post(tx, {
      organisationId: a.organisationId, companyId: a.companyId, journalDate: a.paymentDate, sourceType: 'PURCHASE_PAYMENT', sourceId: id, sourceReference: a.reference ?? null,
      description: `Payment to ${name}${a.reference ? ` (${a.reference})` : ''}`.slice(0, 500),
      ...(currency !== company.baseCurrency ? { currency, ...(a.rateId ? { rateId: a.rateId } : {}) } : {}),
      lines: [
        { accountId: settings.payablesAccountId, debit: amt, credit: '0', description: `Payment ${name}`.slice(0, 300) },
        { accountId: a.bankAccountId, debit: '0', credit: amt, description: `Payment ${name}`.slice(0, 300) },
      ],
      idempotencyKey: `purchase-payment:${id}`, actor: a.actor,
    });
    const pay = await tx.journalLine.findFirstOrThrow({ where: { journalId: j.id, lineNo: 1 } });
    await tx.purchasePayment.create({ data: { id, organisationId: a.organisationId, companyId: a.companyId, supplierRoleId: role.id, contactId: role.contactId, paymentDate: toDate(a.paymentDate), currency,
      amount, outstanding: amount, functionalAmount: pay.debit, functionalOutstanding: pay.debit, bankAccountId: a.bankAccountId, exchangeRateId: pay.exchangeRateId, rate: pay.rate,
      reference: a.reference ?? null, notes: a.notes ?? null, journalId: j.id, duplicateOverrideReason: dups.length > 0 ? a.duplicateOverrideReason!.trim() : null, bankDetailsUnverified, createdByUserId: a.actor.userId } });
    for (const x of a.allocations) {
      const b = await tx.purchaseDocument.findFirst({ where: { id: x.billId, companyId: a.companyId }, select: { issueDate: true } });
      if (!b) throw notFound('Bill not found');
      const date = isoDay(b.issueDate) > a.paymentDate ? isoDay(b.issueDate) : a.paymentDate;
      await this.allocate(tx, { organisationId: a.organisationId, companyId: a.companyId, actor: a.actor, billId: x.billId, paymentId: id, amount: money(x.amount), date });
    }
    await this.audit(tx, { action: 'purchase_payment.recorded', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'purchase_payment', entityId: id,
      after: { supplierRoleId: role.id, paymentDate: a.paymentDate, currency, amount: amt, allocated: fmt(allocated, cur.minorUnits), journalId: j.id, bankDetailsUnverified }, reason: a.duplicateOverrideReason ?? null,
      metadata: { duplicateOverride: dups.length > 0, bankDetailsUnverified } });
    await publishEvent(tx, Events.purchasePaymentRecorded, { aggregateId: id, organisationId: a.organisationId, actorUserId: a.actor.userId,
      payload: { paymentId: id, companyId: a.companyId, supplierRoleId: role.id, paymentDate: a.paymentDate, currency, amount: amt, allocated: fmt(allocated, cur.minorUnits), journalId: j.id, bankDetailsUnverified } });
    return this.getPayment(tx, a.companyId, id);
  }

  async allocatePayment(tx: Tx, a: { organisationId: string; companyId: string; actor: PurchaseActor; paymentId: string; allocations: { billId: string; amount: string }[]; date?: string }) {
    await this.need(a.actor, 'purchases:approve', a.companyId);
    const p = await tx.purchasePayment.findFirst({ where: { id: a.paymentId, companyId: a.companyId } });
    if (!p) throw notFound('Payment not found');
    if (new Set(a.allocations.map((x) => x.billId)).size !== a.allocations.length) throw unprocessable('Each bill appears once in the allocations', 'invalid_allocation');
    for (const x of a.allocations) {
      const b = await tx.purchaseDocument.findFirst({ where: { id: x.billId, companyId: a.companyId }, select: { issueDate: true } });
      if (!b) throw notFound('Bill not found');
      const earliest = isoDay(b.issueDate) > isoDay(p.paymentDate) ? isoDay(b.issueDate) : isoDay(p.paymentDate);
      if (a.date && a.date < earliest) throw unprocessable('An allocation cannot precede the payment or the bill', 'invalid_date');
      await this.allocate(tx, { organisationId: a.organisationId, companyId: a.companyId, actor: a.actor, billId: x.billId, paymentId: p.id, amount: money(x.amount), date: a.date ?? earliest });
    }
    return this.getPayment(tx, a.companyId, p.id);
  }

  async reversePayment(tx: Tx, a: { organisationId: string; companyId: string; actor: PurchaseActor; id: string; reason: string; date?: string }) {
    await this.need(a.actor, 'purchases:approve', a.companyId);
    await tx.$queryRaw`SELECT id FROM purchase_payment WHERE id = ${a.id}::uuid FOR UPDATE`;
    const p = await tx.purchasePayment.findFirst({ where: { id: a.id, companyId: a.companyId } });
    if (!p) throw notFound('Payment not found');
    if (p.status !== 'POSTED') throw conflict('This payment is already reversed', 'payment_reversed');
    if (!p.outstanding.equals(p.amount)) throw conflict('Part of this payment is allocated to bills; an allocated payment cannot be reversed (unallocating is deferred, DEC-026)', 'payment_allocated');
    const date = a.date ?? isoDay(p.paymentDate);
    if (date < isoDay(p.paymentDate)) throw unprocessable('A reversal cannot precede the payment', 'invalid_date');
    // the exact mirror of the posted lines, original amounts and rate included
    const posted = await tx.journalLine.findMany({ where: { journalId: p.journalId }, orderBy: { lineNo: 'asc' } });
    const j = await this.posting.post(tx, {
      organisationId: a.organisationId, companyId: a.companyId, journalDate: date, sourceType: 'PURCHASE_PAYMENT_REVERSAL', sourceId: p.id, sourceReference: p.reference,
      description: `Reversal of payment ${p.reference ?? p.id.slice(0, 8)}: ${a.reason.trim()}`.slice(0, 500),
      lines: [...posted].reverse().map((l) => ({ accountId: l.accountId, debit: l.credit.toFixed(4), credit: l.debit.toFixed(4), description: 'Payment reversed',
        ...(l.originalCurrency ? { original: { currency: l.originalCurrency, debit: l.originalCredit!.toFixed(4), credit: l.originalDebit!.toFixed(4), rate: l.rate!.toFixed(8), rateId: l.exchangeRateId! } } : {}) })),
      idempotencyKey: `purchase-payment-reversal:${p.id}`, actor: a.actor, reason: a.reason,
    });
    await tx.purchasePayment.update({ where: { id: p.id }, data: { status: 'REVERSED', reversalJournalId: j.id, reversedByUserId: a.actor.userId, reversedAt: new Date(), reversedReason: a.reason.trim() } });
    await this.audit(tx, { action: 'purchase_payment.reversed', organisationId: a.organisationId, companyId: a.companyId, actorUserId: a.actor.userId, entityType: 'purchase_payment', entityId: p.id,
      before: { status: 'POSTED' }, after: { status: 'REVERSED', journalId: j.id, date }, reason: a.reason });
    return this.getPayment(tx, a.companyId, p.id);
  }

  async getPayment(tx: Tx, companyId: string, id: string) {
    const p = await tx.purchasePayment.findFirst({ where: { id, companyId } });
    if (!p) throw notFound('Payment not found');
    const company = await this.company(tx, companyId);
    const [minor, fm] = await Promise.all([this.minorOf(tx, p.currency), this.minorOf(tx, company.baseCurrency)]);
    const allocs = await tx.purchaseAllocation.findMany({ where: { paymentId: p.id }, orderBy: { createdAt: 'asc' } });
    return { ...this.paymentView(p, minor, fm), allocations: allocs.map((x) => this.allocationView(x, fm)) };
  }
  private paymentView(p: Awaited<ReturnType<Tx['purchasePayment']['findUniqueOrThrow']>>, minor: number, fm: number) {
    return { id: p.id, companyId: p.companyId, supplierRoleId: p.supplierRoleId, contactId: p.contactId, paymentDate: isoDay(p.paymentDate), currency: p.currency, amount: fmt(p.amount, minor),
      unallocated: fmt(p.outstanding, minor), functional: { amount: fmt(p.functionalAmount, fm), unallocated: fmt(p.functionalOutstanding, fm) }, rate: p.rate ? p.rate.toFixed(8) : null, exchangeRateId: p.exchangeRateId,
      bankAccountId: p.bankAccountId, reference: p.reference, notes: p.notes, journalId: p.journalId, duplicateOverrideReason: p.duplicateOverrideReason, bankDetailsUnverified: p.bankDetailsUnverified, status: p.status,
      reversalJournalId: p.reversalJournalId, reversedByUserId: p.reversedByUserId, reversedAt: p.reversedAt, reversedReason: p.reversedReason, createdByUserId: p.createdByUserId, createdAt: p.createdAt };
  }
  async listPayments(tx: Tx, companyId: string, q: { supplierRoleId?: string; status?: string; unallocated?: boolean; bankDetailsUnverified?: boolean; from?: string; to?: string; limit: number; cursor?: string }) {
    const company = await this.company(tx, companyId);
    const fm = await this.minorOf(tx, company.baseCurrency);
    const rows = await tx.purchasePayment.findMany({
      where: { companyId, ...(q.supplierRoleId ? { supplierRoleId: q.supplierRoleId } : {}), ...(q.status ? { status: q.status } : {}), ...(q.bankDetailsUnverified !== undefined ? { bankDetailsUnverified: q.bankDetailsUnverified } : {}),
        ...(q.unallocated === true ? { status: 'POSTED', outstanding: { gt: 0 } } : q.unallocated === false ? { outstanding: 0 } : {}),
        ...(q.from || q.to ? { paymentDate: { ...(q.from ? { gte: toDate(q.from) } : {}), ...(q.to ? { lte: toDate(q.to) } : {}) } } : {}) },
      orderBy: [{ paymentDate: 'desc' }, { id: 'desc' }], take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const items = [];
    for (const r of rows.slice(0, q.limit)) items.push(this.paymentView(r, await this.minorOf(tx, r.currency), fm));
    return { items, nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  // ───── Supplier statement (what we owe; credit-normal) and aged payables ─────
  async statement(tx: Tx, companyId: string, supplierRoleId: string, q: { from: string; to: string }) {
    const { role } = await this.supplier(tx, companyId, supplierRoleId);
    const docs = await tx.purchaseDocument.findMany({ where: { companyId, supplierRoleId, status: 'APPROVED', issueDate: { lte: toDate(q.to) } } });
    const payments = await tx.purchasePayment.findMany({ where: { companyId, supplierRoleId, paymentDate: { lte: toDate(q.to) } } });
    const revDates = new Map((await tx.journal.findMany({ where: { id: { in: payments.map((p) => p.reversalJournalId).filter(Boolean) as string[] } }, select: { id: true, journalDate: true } })).map((j) => [j.id, isoDay(j.journalDate)]));
    type Entry = { date: string; type: string; reference: string | null; documentNumber: string | null; documentId: string; dueDate: string | null; credit: Money; debit: Money };
    const byCcy = new Map<string, Entry[]>();
    const push = (c: string, e: Entry) => { if (!byCcy.has(c)) byCcy.set(c, []); byCcy.get(c)!.push(e); };
    for (const d of docs) push(d.currency, { date: isoDay(d.issueDate), type: d.kind, reference: d.supplierReference, documentNumber: d.documentNumber, documentId: d.id, dueDate: d.kind === 'BILL' ? isoDay(d.dueDate) : null,
      credit: d.kind === 'BILL' ? d.grossTotal : ZERO, debit: d.kind === 'BILL' ? ZERO : d.grossTotal });
    for (const p of payments) {
      push(p.currency, { date: isoDay(p.paymentDate), type: 'PAYMENT', reference: p.reference, documentNumber: null, documentId: p.id, dueDate: null, credit: ZERO, debit: p.amount });
      const rd = p.reversalJournalId ? revDates.get(p.reversalJournalId) : undefined;
      if (rd && rd <= q.to) push(p.currency, { date: rd, type: 'PAYMENT_REVERSAL', reference: p.reference, documentNumber: null, documentId: p.id, dueDate: null, credit: p.amount, debit: ZERO });
    }
    const currencies = [];
    for (const [c, entries] of [...byCcy.entries()].sort(([x], [y]) => x.localeCompare(y))) {
      const minor = await this.minorOf(tx, c);
      entries.sort((x, y) => x.date.localeCompare(y.date) || x.type.localeCompare(y.type));
      const opening = entries.filter((e) => e.date < q.from).reduce((t, e) => t.plus(e.credit).minus(e.debit), ZERO);
      let bal = opening;
      const lines = entries.filter((e) => e.date >= q.from).map((e) => { bal = bal.plus(e.credit).minus(e.debit); return { date: e.date, type: e.type, reference: e.reference, documentNumber: e.documentNumber, documentId: e.documentId,
        dueDate: e.dueDate, debit: fmt(e.debit, minor), credit: fmt(e.credit, minor), balance: fmt(bal, minor) }; });
      currencies.push({ currency: c, opening: fmt(opening, minor), lines, closing: fmt(bal, minor) });
    }
    return { companyId, supplierRoleId, supplier: await buildContactSnapshot(tx, role.id), from: q.from, to: q.to, currencies };
  }

  async agedPayables(tx: Tx, companyId: string, q: { asOf?: string; supplierRoleId?: string }) {
    await this.company(tx, companyId);
    const asOf = q.asOf ?? isoDay(new Date());
    const d = toDate(asOf);
    const filt = q.supplierRoleId ? { supplierRoleId: q.supplierRoleId } : {};
    const docs = await tx.purchaseDocument.findMany({ where: { companyId, ...filt, status: 'APPROVED', issueDate: { lte: d } } });
    const payments = await tx.purchasePayment.findMany({ where: { companyId, ...filt, paymentDate: { lte: d } } });
    const revDates = new Map((await tx.journal.findMany({ where: { id: { in: payments.map((p) => p.reversalJournalId).filter(Boolean) as string[] } }, select: { id: true, journalDate: true } })).map((j) => [j.id, j.journalDate]));
    const allocs = await tx.purchaseAllocation.findMany({ where: { companyId, allocatedOn: { lte: d } } });
    const used = (pick: (x: AllocRow) => string | null) => { const m = new Map<string, Money>(); for (const x of allocs) { const k = pick(x); if (k) m.set(k, (m.get(k) ?? ZERO).plus(x.amount)); } return m; };
    const toBill = used((x) => x.billId), fromDebit = used((x) => x.debitId), fromPayment = used((x) => x.paymentId);
    const BUCKETS = ['notDue', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;
    type Row = Record<(typeof BUCKETS)[number] | 'unallocatedDebits', Money>;
    const rows = new Map<string, { supplierRoleId: string; currency: string; r: Row }>();
    const row = (s2: string, c: string) => { const k = `${s2}|${c}`; if (!rows.has(k)) rows.set(k, { supplierRoleId: s2, currency: c, r: { notDue: ZERO, days1to30: ZERO, days31to60: ZERO, days61to90: ZERO, over90: ZERO, unallocatedDebits: ZERO } }); return rows.get(k)!.r; };
    for (const x of docs) {
      const open = x.kind === 'BILL' ? x.grossTotal.minus(toBill.get(x.id) ?? ZERO) : x.grossTotal.minus(fromDebit.get(x.id) ?? ZERO);
      if (open.isZero()) continue;
      const r = row(x.supplierRoleId, x.currency);
      if (x.kind !== 'BILL') { r.unallocatedDebits = r.unallocatedDebits.minus(open); continue; }
      const late = Math.round((d.getTime() - x.dueDate.getTime()) / 86_400_000);
      const b = late <= 0 ? 'notDue' : late <= 30 ? 'days1to30' : late <= 60 ? 'days31to60' : late <= 90 ? 'days61to90' : 'over90';
      r[b] = r[b].plus(open);
    }
    for (const p of payments) {
      const rev = p.reversalJournalId ? revDates.get(p.reversalJournalId) : undefined;
      if (rev && rev <= d) continue;
      const open = p.amount.minus(fromPayment.get(p.id) ?? ZERO);
      if (!open.isZero()) { const r = row(p.supplierRoleId, p.currency); r.unallocatedDebits = r.unallocatedDebits.minus(open); }
    }
    const roles = new Map((await tx.contactRole.findMany({ where: { id: { in: [...new Set([...rows.values()].map((x) => x.supplierRoleId))] } }, select: { id: true, accountCode: true, contactId: true } })).map((x) => [x.id, x]));
    const names = new Map((await tx.contact.findMany({ where: { id: { in: [...roles.values()].map((x) => x.contactId) } }, select: { id: true, name: true } })).map((x) => [x.id, x.name]));
    const KEYS = [...BUCKETS, 'unallocatedDebits' as const];
    const out = []; const totals = new Map<string, Row>();
    for (const v of [...rows.values()].sort((x, y) => x.currency.localeCompare(y.currency))) {
      const minor = await this.minorOf(tx, v.currency);
      const tt = totals.get(v.currency) ?? { notDue: ZERO, days1to30: ZERO, days31to60: ZERO, days61to90: ZERO, over90: ZERO, unallocatedDebits: ZERO };
      for (const k of KEYS) tt[k] = tt[k].plus(v.r[k]);
      totals.set(v.currency, tt);
      const rl = roles.get(v.supplierRoleId);
      out.push({ supplierRoleId: v.supplierRoleId, accountCode: rl?.accountCode ?? null, name: names.get(rl?.contactId ?? '') ?? null, currency: v.currency,
        ...Object.fromEntries(KEYS.map((k) => [k, fmt(v.r[k], minor)])), total: fmt(KEYS.reduce((t, k) => t.plus(v.r[k]), ZERO), minor) });
    }
    const currencyTotals = [];
    for (const [c, t] of [...totals.entries()].sort(([x], [y]) => x.localeCompare(y))) {
      const minor = await this.minorOf(tx, c);
      currencyTotals.push({ currency: c, ...Object.fromEntries(KEYS.map((k) => [k, fmt(t[k], minor)])), total: fmt(KEYS.reduce((s2, k) => s2.plus(t[k]), ZERO), minor) });
    }
    return { companyId, asOf, suppliers: out, totals: currencyTotals };
  }
}
