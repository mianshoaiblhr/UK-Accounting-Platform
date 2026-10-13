import { Inject, Injectable } from '@nestjs/common';
import { buildContactSnapshot } from '@uk/accounting';
import type { ContactRoleKind } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable, type FieldEncryption } from '@uk/core';
import { Prisma, type Database, type Tx } from '@uk/db';
import { AuditService } from '../audit/audit.service';
import { CRYPTO, DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';

/** Clear-text bank details exist only inside this service, between decrypt and response, and are never logged or audited. */
interface BankDetails { accountName: string; sortCode?: string; accountNumber?: string; iban?: string; bic?: string }
type RoleRow = Awaited<ReturnType<Tx['contactRole']['findUniqueOrThrow']>>;
type ContactRow = Awaited<ReturnType<Tx['contact']['findUniqueOrThrow']>>;

/** "Sort code **-**-56, account ****5678" / "IBAN GB** **** 1234": enough to recognise, never enough to pay. */
export function maskBankDetails(b: BankDetails): string {
  const parts: string[] = [];
  if (b.sortCode && b.accountNumber) parts.push(`sort code **-**-${b.sortCode.slice(-2)}, account ****${b.accountNumber.slice(-4)}`);
  if (b.iban) parts.push(`IBAN ${b.iban.slice(0, 2)}** **** ${b.iban.slice(-4)}`);
  return `${b.accountName.slice(0, 1)}*** - ${parts.join('; ')}`;
}

/**
 * Customers and suppliers are ROLES of the shared contact (DEC-011, DEC-023): one contact can be both, a role belongs to one company, and roles are
 * ended, never deleted. Supplier bank details are field-encrypted (AAD = role id), masked everywhere, readable only with `contact:bank-details`
 * (each view audited), and a change is UNVERIFIED until a different person verifies it.
 */
@Injectable()
export class ContactRolesService {
  constructor(@Inject(DB) private readonly db: Database, @Inject(CRYPTO) private readonly crypto: FieldEncryption, private readonly audit: AuditService) {}
  private t<T>(org: OrgAccess, fn: (tx: Tx) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, fn); }

  private async minor(tx: Tx, companyId: string) {
    const c = await tx.company.findUnique({ where: { id: companyId }, select: { baseCurrency: true } });
    if (!c) throw notFound('Company not found');
    return (await tx.currency.findUnique({ where: { code: c.baseCurrency } }))?.minorUnits ?? 2;
  }

  private view(r: RoleRow, contact: ContactRow, customer: Awaited<ReturnType<Tx['customerProfile']['findUnique']>>, supplier: Awaited<ReturnType<Tx['supplierProfile']['findUnique']>>, minor: number) {
    return {
      id: r.id, companyId: r.companyId, contactId: r.contactId, role: r.role, accountCode: r.accountCode, status: r.status, endedAt: r.endedAt, endedReason: r.endedReason, createdAt: r.createdAt,
      contact: { id: contact.id, name: contact.name, kind: contact.kind, email: contact.email, vatNumber: contact.vatNumber, companyId: contact.companyId, status: contact.status },
      customer: customer ? { paymentTermsDays: customer.paymentTermsDays, creditLimit: customer.creditLimit?.toFixed(minor) ?? null, defaultCurrency: customer.defaultCurrency } : null,
      supplier: supplier ? {
        paymentTermsDays: supplier.paymentTermsDays, defaultCurrency: supplier.defaultCurrency, defaultExpenseAccountId: supplier.defaultExpenseAccountId,
        bankDetails: { status: supplier.bankDetailsStatus, masked: supplier.bankDetailsMasked, changedAt: supplier.bankDetailsChangedAt, changedByUserId: supplier.bankDetailsChangedByUserId,
          verifiedAt: supplier.bankDetailsVerifiedAt, verifiedByUserId: supplier.bankDetailsVerifiedByUserId },
      } : null,
    };
  }
  private async load(tx: Tx, companyId: string, id: string) {
    const r = await tx.contactRole.findFirst({ where: { id, companyId } });
    if (!r) throw notFound('Customer or supplier not found');
    const [contact, customer, supplier] = await Promise.all([tx.contact.findUniqueOrThrow({ where: { id: r.contactId } }), tx.customerProfile.findUnique({ where: { roleId: r.id } }), tx.supplierProfile.findUnique({ where: { roleId: r.id } })]);
    return { r, contact, customer, supplier };
  }

  private async checkExpenseAccount(tx: Tx, companyId: string, accountId: string | null | undefined) {
    if (!accountId) return;
    const a = await tx.account.findFirst({ where: { id: accountId, companyId } });
    if (!a) throw unprocessable('The default expense account does not exist in this company', 'unknown_account');
    if (a.isControl || !['EXPENSE', 'ASSET'].includes(a.type) || a.activeTo) throw unprocessable(`Account ${a.code} cannot be a supplier's default: use an active expense or asset account that is not a control account`, 'invalid_account');
  }
  /** Explicit, case-insensitive check (the unique index stays the backstop for a race). */
  private async checkAccountCode(tx: Tx, companyId: string, role: string, code: string | null | undefined, exceptId?: string) {
    if (!code) return;
    const clash = await tx.contactRole.findFirst({ where: { companyId, role, accountCode: { equals: code, mode: 'insensitive' }, ...(exceptId ? { NOT: { id: exceptId } } : {}) }, select: { id: true } });
    if (clash) throw conflict('This account code is already used by another customer or supplier of the company', 'account_code_exists');
  }
  private async checkCurrency(tx: Tx, code: string | null | undefined) {
    if (code && !(await tx.currency.findUnique({ where: { code } }))) throw unprocessable(`${code} is not a known currency`, 'unknown_currency');
  }
  private unique(e: unknown): unknown {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const target = String((e.meta as { target?: unknown })?.target ?? e.message);
      return target.includes('account_code') || target.includes('upper') ? conflict('This account code is already used by another customer or supplier of the company', 'account_code_exists')
        : conflict('This contact already has that role in this company', 'contact_role_exists');
    }
    if (e instanceof Prisma.PrismaClientKnownRequestError || e instanceof Prisma.PrismaClientUnknownRequestError) {
      if (String((e as Error).message).includes('belongs to another company')) return unprocessable('This contact belongs to another company and cannot take a role here', 'contact_other_company');
    }
    return e;
  }

  async create(org: OrgAccess, companyId: string, input: { contactId: string; role: ContactRoleKind; accountCode?: string; paymentTermsDays: number; defaultCurrency?: string; creditLimit?: string; defaultExpenseAccountId?: string }) {
    return this.t(org, async (tx) => {
      const contact = await tx.contact.findUnique({ where: { id: input.contactId } });
      if (!contact) throw unprocessable('Unknown contact', 'unknown_contact');
      await org.access.requireResource('contact:read', contact.companyId, 'Contact not found');
      if (contact.status !== 'ACTIVE') throw unprocessable('An archived contact cannot take a new role', 'contact_archived');
      if (contact.companyId && contact.companyId !== companyId) throw unprocessable('This contact belongs to another company and cannot take a role here', 'contact_other_company');
      await this.checkCurrency(tx, input.defaultCurrency);
      await this.checkExpenseAccount(tx, companyId, input.defaultExpenseAccountId);
      if (await tx.contactRole.findFirst({ where: { companyId, contactId: contact.id, role: input.role }, select: { id: true } })) throw conflict('This contact already has that role in this company', 'contact_role_exists');
      await this.checkAccountCode(tx, companyId, input.role, input.accountCode);
      let role: RoleRow;
      try {
        role = await tx.contactRole.create({ data: { organisationId: org.organisationId, companyId, contactId: contact.id, role: input.role, accountCode: input.accountCode ?? null, createdByUserId: org.userId } });
      } catch (e) { throw this.unique(e); }
      if (input.role === 'CUSTOMER') {
        await tx.customerProfile.create({ data: { roleId: role.id, organisationId: org.organisationId, companyId, paymentTermsDays: input.paymentTermsDays, creditLimit: input.creditLimit ?? null, defaultCurrency: input.defaultCurrency ?? null } });
      } else {
        await tx.supplierProfile.create({ data: { roleId: role.id, organisationId: org.organisationId, companyId, paymentTermsDays: input.paymentTermsDays, defaultCurrency: input.defaultCurrency ?? null, defaultExpenseAccountId: input.defaultExpenseAccountId ?? null } });
      }
      await this.audit.record({ action: 'contact_role.created', organisationId: org.organisationId, actorUserId: org.userId, companyId, entityType: 'contact_role', entityId: role.id,
        after: { contactId: contact.id, role: input.role, accountCode: input.accountCode ?? null, paymentTermsDays: input.paymentTermsDays, creditLimit: input.creditLimit ?? null, defaultCurrency: input.defaultCurrency ?? null } }, tx);
      const l = await this.load(tx, companyId, role.id);
      return this.view(l.r, l.contact, l.customer, l.supplier, await this.minor(tx, companyId));
    });
  }

  async list(org: OrgAccess, companyId: string, q: { limit: number; cursor?: string; role?: ContactRoleKind; status: 'ACTIVE' | 'ENDED' | 'ALL'; q?: string }) {
    return this.t(org, async (tx) => {
      const rows = await tx.contactRole.findMany({
        where: { companyId, ...(q.role ? { role: q.role } : {}), ...(q.status !== 'ALL' ? { status: q.status } : {}), ...(q.cursor ? { id: { lt: q.cursor } } : {}),
          ...(q.q ? { OR: [{ accountCode: { contains: q.q, mode: 'insensitive' } }, { contactId: { in: (await tx.contact.findMany({ where: { name: { contains: q.q, mode: 'insensitive' } }, select: { id: true }, take: 500 })).map((c) => c.id) } }] } : {}) },
        orderBy: { id: 'desc' }, take: q.limit + 1,
      });
      const page = rows.slice(0, q.limit);
      const ids = page.map((r) => r.id);
      const [contacts, customers, suppliers, minor] = await Promise.all([
        tx.contact.findMany({ where: { id: { in: page.map((r) => r.contactId) } } }), tx.customerProfile.findMany({ where: { roleId: { in: ids } } }), tx.supplierProfile.findMany({ where: { roleId: { in: ids } } }), this.minor(tx, companyId)]);
      const c = new Map(contacts.map((x) => [x.id, x])), cu = new Map(customers.map((x) => [x.roleId, x])), su = new Map(suppliers.map((x) => [x.roleId, x]));
      return { items: page.map((r) => this.view(r, c.get(r.contactId)!, cu.get(r.id) ?? null, su.get(r.id) ?? null, minor)), nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null };
    });
  }

  async get(org: OrgAccess, companyId: string, id: string) {
    return this.t(org, async (tx) => { const l = await this.load(tx, companyId, id); return this.view(l.r, l.contact, l.customer, l.supplier, await this.minor(tx, companyId)); });
  }

  async update(org: OrgAccess, companyId: string, id: string, input: { accountCode?: string | null; paymentTermsDays?: number; defaultCurrency?: string | null; creditLimit?: string | null; defaultExpenseAccountId?: string | null; reason?: string }) {
    return this.t(org, async (tx) => {
      const l = await this.load(tx, companyId, id);
      if (l.r.status !== 'ACTIVE') throw conflict('An ended role cannot be changed; reactivate it first', 'contact_role_ended');
      if (l.r.role === 'CUSTOMER' && input.defaultExpenseAccountId !== undefined) throw unprocessable('A default expense account applies to suppliers', 'invalid_field');
      if (l.r.role === 'SUPPLIER' && input.creditLimit !== undefined) throw unprocessable('A credit limit applies to customers', 'invalid_field');
      if (input.creditLimit !== undefined && !input.reason) throw unprocessable('Changing a credit limit needs a reason', 'reason_required');
      await this.checkCurrency(tx, input.defaultCurrency);
      await this.checkExpenseAccount(tx, companyId, input.defaultExpenseAccountId);
      await this.checkAccountCode(tx, companyId, l.r.role, input.accountCode, id);
      const minor = await this.minor(tx, companyId);
      const before = this.view(l.r, l.contact, l.customer, l.supplier, minor);
      try {
        if (input.accountCode !== undefined) await tx.contactRole.update({ where: { id }, data: { accountCode: input.accountCode } });
      } catch (e) { throw this.unique(e); }
      const common = { ...(input.paymentTermsDays !== undefined ? { paymentTermsDays: input.paymentTermsDays } : {}), ...(input.defaultCurrency !== undefined ? { defaultCurrency: input.defaultCurrency } : {}) };
      if (l.r.role === 'CUSTOMER') await tx.customerProfile.update({ where: { roleId: id }, data: { ...common, ...(input.creditLimit !== undefined ? { creditLimit: input.creditLimit } : {}) } });
      else await tx.supplierProfile.update({ where: { roleId: id }, data: { ...common, ...(input.defaultExpenseAccountId !== undefined ? { defaultExpenseAccountId: input.defaultExpenseAccountId } : {}) } });
      const a = await this.load(tx, companyId, id);
      const after = this.view(a.r, a.contact, a.customer, a.supplier, minor);
      const pick = (v: typeof before) => ({ accountCode: v.accountCode, ...(v.customer ? { paymentTermsDays: v.customer.paymentTermsDays, creditLimit: v.customer.creditLimit, defaultCurrency: v.customer.defaultCurrency } : {}),
        ...(v.supplier ? { paymentTermsDays: v.supplier.paymentTermsDays, defaultCurrency: v.supplier.defaultCurrency, defaultExpenseAccountId: v.supplier.defaultExpenseAccountId } : {}) });
      await this.audit.record({ action: 'contact_role.updated', organisationId: org.organisationId, actorUserId: org.userId, companyId, entityType: 'contact_role', entityId: id, before: pick(before), after: pick(after), reason: input.reason ?? null }, tx);
      return after;
    });
  }

  /** Ending a role keeps it (and its history) for reporting and evidence. Once documents exist (M5/M6), a role with open documents cannot be ended. */
  async setStatus(org: OrgAccess, companyId: string, id: string, status: 'ACTIVE' | 'ENDED', reason?: string) {
    return this.t(org, async (tx) => {
      const l = await this.load(tx, companyId, id);
      if (l.r.status === status) throw conflict(status === 'ENDED' ? 'This role has already ended' : 'This role is active', 'invalid_role_state');
      if (status === 'ACTIVE' && l.contact.status !== 'ACTIVE') throw unprocessable('Restore the contact before reactivating its role', 'contact_archived');
      if (status === 'ENDED') {
        // DEC-023 / V1-CON-02: not while the role has drafts or approved documents with something outstanding
        const open = await tx.salesDocument.count({ where: { customerRoleId: id, OR: [{ status: 'DRAFT' }, { status: 'APPROVED', outstanding: { gt: 0 } }] } })
          + await tx.salesReceipt.count({ where: { customerRoleId: id, status: 'POSTED', outstanding: { gt: 0 } } })
          + await tx.purchaseDocument.count({ where: { supplierRoleId: id, OR: [{ status: 'DRAFT' }, { status: 'APPROVED', outstanding: { gt: 0 } }] } })
          + await tx.purchasePayment.count({ where: { supplierRoleId: id, status: 'POSTED', outstanding: { gt: 0 } } });
        if (open > 0) throw conflict(`This role has ${open} open sales item(s) (drafts, approved documents with an amount outstanding, or unallocated receipts); settle, credit, allocate or discard them first`, 'contact_role_has_open_documents', { openDocuments: open });
      }
      await tx.contactRole.update({ where: { id }, data: status === 'ENDED' ? { status, endedAt: new Date(), endedByUserId: org.userId, endedReason: reason! } : { status, endedAt: null, endedByUserId: null, endedReason: null } });
      await this.audit.record({ action: status === 'ENDED' ? 'contact_role.ended' : 'contact_role.reactivated', organisationId: org.organisationId, actorUserId: org.userId, companyId, entityType: 'contact_role', entityId: id,
        before: { status: l.r.status }, after: { status }, reason: reason ?? null }, tx);
      const a = await this.load(tx, companyId, id);
      return this.view(a.r, a.contact, a.customer, a.supplier, await this.minor(tx, companyId));
    });
  }

  // ───── Supplier bank details (DEC-023) ─────
  private async supplier(tx: Tx, companyId: string, id: string) {
    const l = await this.load(tx, companyId, id);
    if (l.r.role !== 'SUPPLIER' || !l.supplier) throw unprocessable('Bank details are held for suppliers', 'not_a_supplier');
    return l;
  }

  async setBankDetails(org: OrgAccess, companyId: string, id: string, input: BankDetails & { reason: string }) {
    return this.t(org, async (tx) => {
      const l = await this.supplier(tx, companyId, id);
      if (l.r.status !== 'ACTIVE') throw conflict('An ended role cannot be changed; reactivate it first', 'contact_role_ended');
      const clear: BankDetails = { accountName: input.accountName, sortCode: input.sortCode, accountNumber: input.accountNumber, iban: input.iban, bic: input.bic };
      const masked = maskBankDetails(clear);
      await tx.supplierProfile.update({ where: { roleId: id }, data: {
        bankDetailsEnc: this.crypto.encrypt(JSON.stringify(clear), `supplier_bank:${id}`), bankDetailsMasked: masked, bankDetailsStatus: 'UNVERIFIED',
        bankDetailsChangedByUserId: org.userId, bankDetailsChangedAt: new Date(), bankDetailsVerifiedByUserId: null, bankDetailsVerifiedAt: null } });
      await this.audit.record({ action: 'supplier.bank_details_changed', organisationId: org.organisationId, actorUserId: org.userId, companyId, entityType: 'contact_role', entityId: id,
        before: { masked: l.supplier!.bankDetailsMasked, status: l.supplier!.bankDetailsStatus }, after: { masked, status: 'UNVERIFIED' }, reason: input.reason }, tx);
      const a = await this.load(tx, companyId, id);
      return this.view(a.r, a.contact, a.customer, a.supplier, await this.minor(tx, companyId));
    });
  }

  /** The only read of clear bank details; every call is audited (who, when, which supplier - never the values). */
  async viewBankDetails(org: OrgAccess, companyId: string, id: string) {
    return this.t(org, async (tx) => {
      const l = await this.supplier(tx, companyId, id);
      if (!l.supplier!.bankDetailsEnc) throw notFound('No bank details are held for this supplier');
      const clear = JSON.parse(this.crypto.decrypt(l.supplier!.bankDetailsEnc, `supplier_bank:${id}`)) as BankDetails;
      await this.audit.record({ action: 'supplier.bank_details_viewed', organisationId: org.organisationId, actorUserId: org.userId, companyId, entityType: 'contact_role', entityId: id,
        metadata: { masked: l.supplier!.bankDetailsMasked, status: l.supplier!.bankDetailsStatus } }, tx);
      return { ...clear, status: l.supplier!.bankDetailsStatus, masked: l.supplier!.bankDetailsMasked, changedAt: l.supplier!.bankDetailsChangedAt, changedByUserId: l.supplier!.bankDetailsChangedByUserId,
        verifiedAt: l.supplier!.bankDetailsVerifiedAt, verifiedByUserId: l.supplier!.bankDetailsVerifiedByUserId };
    });
  }

  /** A second person confirms the change (for example by calling the supplier on a number already on file). Payments (M6) refuse UNVERIFIED details. */
  async verifyBankDetails(org: OrgAccess, companyId: string, id: string, note?: string) {
    return this.t(org, async (tx) => {
      const l = await this.supplier(tx, companyId, id);
      const s = l.supplier!;
      if (s.bankDetailsStatus === 'NONE') throw unprocessable('No bank details to verify', 'no_bank_details');
      if (s.bankDetailsStatus === 'VERIFIED') throw conflict('These bank details are already verified', 'already_verified');
      if (s.bankDetailsChangedByUserId === org.userId) throw forbidden('Bank details must be verified by someone other than the person who entered them', 'self_verification_not_allowed');
      const upd = await tx.supplierProfile.updateMany({ where: { roleId: id, bankDetailsStatus: 'UNVERIFIED', bankDetailsEnc: s.bankDetailsEnc }, data: { bankDetailsStatus: 'VERIFIED', bankDetailsVerifiedByUserId: org.userId, bankDetailsVerifiedAt: new Date() } });
      if (upd.count !== 1) throw conflict('The bank details changed while you were verifying them; review the new details', 'bank_details_changed');
      await this.audit.record({ action: 'supplier.bank_details_verified', organisationId: org.organisationId, actorUserId: org.userId, companyId, entityType: 'contact_role', entityId: id,
        before: { status: 'UNVERIFIED' }, after: { status: 'VERIFIED', masked: s.bankDetailsMasked }, reason: note ?? null }, tx);
      const a = await this.load(tx, companyId, id);
      return this.view(a.r, a.contact, a.customer, a.supplier, await this.minor(tx, companyId));
    });
  }

  /**
   * What a document captures about its counterparty when it is issued (M5/M6 store this on the document), so a later edit of the contact never
   * rewrites an invoice: legal name, kind, VAT number, account code and the primary billing address (or the first address when none is primary).
   */
  async snapshot(org: OrgAccess, companyId: string, id: string) {
    return this.t(org, async (tx) => {
      const l = await this.load(tx, companyId, id);
      if (l.r.status !== 'ACTIVE') throw conflict('An ended role cannot be used on a new document', 'contact_role_ended');
      // the same function stores the snapshot on sales documents at approval (M5a)
      return buildContactSnapshot(tx, l.r.id);
    });
  }
}
