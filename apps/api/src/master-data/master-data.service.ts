import { Inject, Injectable } from '@nestjs/common';
import { conflict, notFound, unprocessable } from '@uk/core';
import { Prisma, type Address, type Contact, type Database, type Tx } from '@uk/db';
import { changeSet } from '@uk/platform';
import { AuditService } from '../audit/audit.service';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';

const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const addressDto = (a: Address) => { const { isPrimary, ...rest } = a; return { ...rest, primary: isPrimary }; };
const CONTACT_KEYS = ['name', 'email', 'phone', 'reference', 'labels', 'notes', 'status'] as const;
const ADDRESS_KEYS = ['kind', 'line1', 'line2', 'line3', 'city', 'region', 'postcode', 'countryCode', 'isPrimary'] as const;

type Owner = { type: 'contact'; id: string; companyId: string | null } | { type: 'company'; id: string; companyId: string };

/**
 * Contacts, addresses and officers. Access follows the OWNER: a company-linked contact (or a company's address / officer) is
 * governed by the caller's rights on that company; an organisation-level contact by the organisation role. All decisions go
 * through org.access (the central authoriser).
 */
@Injectable()
export class MasterDataService {
  constructor(@Inject(DB) private readonly db: Database, private readonly audit: AuditService) {}
  private t<T>(org: OrgAccess, fn: (tx: Tx) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, fn); }
  private fk(e: unknown, map: Record<string, [string, string]>) {
    if (e instanceof Prisma.PrismaClientKnownRequestError || e instanceof Prisma.PrismaClientUnknownRequestError) {
      const msg = String((e as Error).message);
      for (const [needle, [code, text]] of Object.entries(map)) if (msg.includes(needle)) return unprocessable(text, code);
    }
    return e;
  }

  // ───────────── Contacts ─────────────
  async createContact(org: OrgAccess, input: { companyId?: string; kind: 'PERSON' | 'ORGANISATION'; name: string; email?: string; phone?: string; reference?: string; labels: string[]; notes?: string }) {
    await org.access.requireResource('contact:manage', input.companyId ?? null, 'Company not found');
    return this.t(org, async (tx) => {
      const c = await tx.contact.create({ data: { organisationId: org.organisationId, createdByUserId: org.userId, companyId: input.companyId, kind: input.kind, name: input.name, email: input.email, phone: input.phone, reference: input.reference, labels: input.labels, notes: input.notes } });
      await this.audit.record({ action: 'contact.created', organisationId: org.organisationId, actorUserId: org.userId, companyId: c.companyId, entityType: 'contact', entityId: c.id, after: { kind: c.kind, name: c.name, email: c.email, labels: c.labels } }, tx);
      return c;
    });
  }

  async listContacts(org: OrgAccess, q: { limit: number; cursor?: string; companyId?: string; kind?: string; status: string; q?: string }) {
    const visible = await org.access.companyWhere('contact:read');
    const rows = await this.t(org, (tx) => tx.contact.findMany({
      where: { AND: [visible, q.companyId ? { companyId: q.companyId } : {}], status: q.status as never, ...(q.kind ? { kind: q.kind as never } : {}), ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}) },
      orderBy: { id: 'asc' }, take: q.limit + 1, ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    }));
    return { items: rows.slice(0, q.limit), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  private async loadContact(org: OrgAccess, id: string, perm: 'contact:read' | 'contact:manage'): Promise<Contact> {
    const c = await this.t(org, (tx) => tx.contact.findUnique({ where: { id } }));
    if (!c) throw notFound('Contact not found');
    await org.access.requireResource(perm, c.companyId, 'Contact not found');
    return c;
  }
  getContact(org: OrgAccess, id: string) { return this.loadContact(org, id, 'contact:read'); }

  async updateContact(org: OrgAccess, id: string, input: Partial<Pick<Contact, 'name' | 'email' | 'phone' | 'reference' | 'labels' | 'notes'>>) {
    const before = await this.loadContact(org, id, 'contact:manage');
    return this.t(org, async (tx) => {
      const c = await tx.contact.update({ where: { id }, data: input });
      await this.audit.record({ action: 'contact.updated', organisationId: org.organisationId, actorUserId: org.userId, companyId: c.companyId, entityType: 'contact', entityId: id, ...changeSet(before, c, CONTACT_KEYS) }, tx);
      return c;
    });
  }

  async setContactStatus(org: OrgAccess, id: string, status: 'ACTIVE' | 'ARCHIVED', reason?: string) {
    const before = await this.loadContact(org, id, 'contact:manage');
    if (before.status === status) return before;
    return this.t(org, async (tx) => {
      const c = await tx.contact.update({ where: { id }, data: { status } });
      await this.audit.record({ action: status === 'ARCHIVED' ? 'contact.archived' : 'contact.restored', organisationId: org.organisationId, actorUserId: org.userId, companyId: c.companyId, entityType: 'contact', entityId: id, before: { status: before.status }, after: { status }, reason }, tx);
      return c;
    });
  }

  // ───────────── Addresses (owned by a contact or a company) ─────────────
  private async owner(org: OrgAccess, o: { contactId?: string; companyId?: string }, write: boolean): Promise<Owner> {
    if (o.contactId) { const c = await this.loadContact(org, o.contactId, write ? 'contact:manage' : 'contact:read'); return { type: 'contact', id: c.id, companyId: c.companyId }; }
    await org.access.requireCompany(write ? 'company:update' : 'company:read', o.companyId!);
    return { type: 'company', id: o.companyId!, companyId: o.companyId! };
  }
  private ownerWhere(o: Owner) { return o.type === 'contact' ? { contactId: o.id } : { companyId: o.id }; }

  async listAddresses(org: OrgAccess, o: { contactId?: string; companyId?: string }) {
    const owner = await this.owner(org, o, false);
    return { items: (await this.t(org, (tx) => tx.address.findMany({ where: this.ownerWhere(owner), orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] }))).map(addressDto) };
  }

  async createAddress(org: OrgAccess, o: { contactId?: string; companyId?: string }, input: { kind: Address['kind']; line1: string; line2?: string; line3?: string; city: string; region?: string; postcode?: string; countryCode: string; primary: boolean }) {
    const owner = await this.owner(org, o, true);
    try {
      return await this.t(org, async (tx) => {
        if (input.primary) await tx.address.updateMany({ where: { ...this.ownerWhere(owner), kind: input.kind, isPrimary: true }, data: { isPrimary: false } });
        const a = await tx.address.create({ data: { organisationId: org.organisationId, ...this.ownerWhere(owner), kind: input.kind, line1: input.line1, line2: input.line2, line3: input.line3, city: input.city, region: input.region, postcode: input.postcode?.toUpperCase(), countryCode: input.countryCode, isPrimary: input.primary } });
        await this.audit.record({ action: 'address.created', organisationId: org.organisationId, actorUserId: org.userId, companyId: owner.companyId, entityType: 'address', entityId: a.id, after: { owner: owner.type, ownerId: owner.id, kind: a.kind, city: a.city, postcode: a.postcode, countryCode: a.countryCode, primary: a.isPrimary } }, tx);
        return addressDto(a);
      });
    } catch (e) { throw this.fk(e, { address_country_code_fkey: ['unknown_country', 'Unknown country code'], address_gb_postcode_ck: ['invalid_postcode', 'Not a valid UK postcode'] }); }
  }

  private async loadAddress(org: OrgAccess, o: { contactId?: string; companyId?: string }, addressId: string, write: boolean) {
    const owner = await this.owner(org, o, write);
    const a = await this.t(org, (tx) => tx.address.findFirst({ where: { id: addressId, ...this.ownerWhere(owner) } }));
    if (!a) throw notFound('Address not found');
    return { owner, a };
  }

  async updateAddress(org: OrgAccess, o: { contactId?: string; companyId?: string }, addressId: string, input: Partial<{ kind: Address['kind']; line1: string; line2: string | null; line3: string | null; city: string; region: string | null; postcode: string | null; countryCode: string; primary: boolean }>) {
    const { owner, a: before } = await this.loadAddress(org, o, addressId, true);
    const { primary, ...rest } = input;
    const data = { ...rest, ...(rest.postcode ? { postcode: rest.postcode.toUpperCase() } : {}), ...(primary !== undefined ? { isPrimary: primary } : {}) };
    try {
      return await this.t(org, async (tx) => {
        const kind = data.kind ?? before.kind;
        if (primary) await tx.address.updateMany({ where: { ...this.ownerWhere(owner), kind, isPrimary: true, NOT: { id: addressId } }, data: { isPrimary: false } });
        const a = await tx.address.update({ where: { id: addressId }, data });
        await this.audit.record({ action: 'address.updated', organisationId: org.organisationId, actorUserId: org.userId, companyId: owner.companyId, entityType: 'address', entityId: addressId, ...changeSet(before, a, ADDRESS_KEYS) }, tx);
        return addressDto(a);
      });
    } catch (e) { throw this.fk(e, { address_country_code_fkey: ['unknown_country', 'Unknown country code'], address_gb_postcode_ck: ['invalid_postcode', 'Not a valid UK postcode'] }); }
  }

  async deleteAddress(org: OrgAccess, o: { contactId?: string; companyId?: string }, addressId: string, reason?: string) {
    const { owner, a } = await this.loadAddress(org, o, addressId, true);
    await this.t(org, async (tx) => {
      await tx.address.delete({ where: { id: addressId } });
      await this.audit.record({ action: 'address.deleted', organisationId: org.organisationId, actorUserId: org.userId, companyId: owner.companyId, entityType: 'address', entityId: addressId, before: { kind: a.kind, line1: a.line1, city: a.city, postcode: a.postcode, countryCode: a.countryCode }, after: null, reason }, tx);
    });
  }

  // ───────────── Directors / officers ─────────────
  async listOfficers(org: OrgAccess, companyId: string, activeOnly: boolean) {
    await org.access.requireCompany('company:read', companyId);
    const rows = await this.t(org, (tx) => tx.companyOfficer.findMany({
      where: { companyId, ...(activeOnly ? { resignedOn: null } : {}) }, include: { contact: { select: { id: true, name: true, kind: true } } }, orderBy: [{ appointedOn: 'asc' }, { id: 'asc' }],
    }));
    return { items: rows.map((r) => ({ id: r.id, companyId: r.companyId, role: r.role, appointedOn: isoDay(r.appointedOn), resignedOn: isoDay(r.resignedOn), contact: r.contact })) };
  }

  async appointOfficer(org: OrgAccess, companyId: string, input: { contactId: string; role: 'DIRECTOR' | 'SECRETARY' | 'PERSON_WITH_SIGNIFICANT_CONTROL' | 'MEMBER' | 'PARTNER' | 'TRUSTEE' | 'OTHER'; appointedOn: string; resignedOn?: string }) {
    await org.access.requireCompany('company:update', companyId);
    const contact = await this.t(org, (tx) => tx.contact.findUnique({ where: { id: input.contactId } }));
    if (!contact) throw unprocessable('Unknown contact', 'unknown_contact');
    await org.access.requireResource('contact:read', contact.companyId, 'Contact not found');
    try {
      return await this.t(org, async (tx) => {
        const o = await tx.companyOfficer.create({ data: { organisationId: org.organisationId, companyId, contactId: input.contactId, role: input.role, appointedOn: new Date(input.appointedOn), resignedOn: input.resignedOn ? new Date(input.resignedOn) : null } });
        await this.audit.record({ action: 'officer.appointed', organisationId: org.organisationId, actorUserId: org.userId, companyId, entityType: 'company_officer', entityId: o.id, after: { contactId: o.contactId, role: o.role, appointedOn: input.appointedOn, resignedOn: input.resignedOn ?? null } }, tx);
        return { id: o.id, companyId, role: o.role, appointedOn: isoDay(o.appointedOn), resignedOn: isoDay(o.resignedOn), contact: { id: contact.id, name: contact.name, kind: contact.kind } };
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('This person already holds that office from that date', 'officer_exists');
      throw this.fk(e, { 'organisation-level or belong to the same company': ['contact_company_mismatch', 'The contact belongs to a different company'] });
    }
  }

  /** Resigning keeps the row (history); `resignedOn: null` reinstates (correcting a mistake) and is audited like any change. */
  async setResignation(org: OrgAccess, companyId: string, officerId: string, resignedOn: string | null) {
    await org.access.requireCompany('company:update', companyId);
    return this.t(org, async (tx) => {
      const before = await tx.companyOfficer.findFirst({ where: { id: officerId, companyId }, include: { contact: { select: { id: true, name: true, kind: true } } } });
      if (!before) throw notFound('Officer not found');
      if (resignedOn && resignedOn < isoDay(before.appointedOn)!) throw unprocessable('resignedOn cannot precede appointedOn', 'invalid_dates');
      const o = await tx.companyOfficer.update({ where: { id: officerId }, data: { resignedOn: resignedOn ? new Date(resignedOn) : null } });
      await this.audit.record({ action: resignedOn ? 'officer.resigned' : 'officer.reinstated', organisationId: org.organisationId, actorUserId: org.userId, companyId, entityType: 'company_officer', entityId: officerId, before: { resignedOn: isoDay(before.resignedOn) }, after: { resignedOn } }, tx);
      return { id: o.id, companyId, role: o.role, appointedOn: isoDay(o.appointedOn), resignedOn: isoDay(o.resignedOn), contact: before.contact };
    });
  }
}
