import { Inject, Injectable } from '@nestjs/common';
import { Events, companyPermissions, nextAccountingPeriod } from '@uk/contracts';
import { conflict, forbidden, notFound, unprocessable } from '@uk/core';
import { changeSet, publishEvent } from '@uk/platform';
import { Prisma, type Company, type Database, type Tx } from '@uk/db';
import { AuditService } from '../audit/audit.service';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';

const isoDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
/** API shape of a company: the year-end pair is exposed as one object, dates as plain yyyy-mm-dd. */
export const companyDto = (c: Company) => {
  const { yearEndMonth, yearEndDay, incorporationDate, ...rest } = c;
  return { ...rest, incorporationDate: isoDay(incorporationDate), yearEnd: yearEndMonth && yearEndDay ? { month: yearEndMonth, day: yearEndDay } : null };
};

interface ProfileInput {
  legalForm?: string; incorporationDate?: string | null; yearEnd?: { month: number; day: number } | null;
  baseCurrency?: string; countryCode?: string; taxJurisdictionCode?: string | null;
}

/** Reference values must exist (clear 422 instead of a raw foreign-key error). */
async function assertReferences(tx: Tx, p: ProfileInput) {
  if (p.baseCurrency && !(await tx.currency.findUnique({ where: { code: p.baseCurrency } }))) throw unprocessable(`Unknown currency ${p.baseCurrency}`, 'unknown_currency');
  if (p.countryCode && !(await tx.country.findUnique({ where: { alpha2: p.countryCode } }))) throw unprocessable(`Unknown country ${p.countryCode}`, 'unknown_country');
  if (p.taxJurisdictionCode && !(await tx.taxJurisdiction.findFirst({ where: { code: p.taxJurisdictionCode } }))) throw unprocessable(`Unknown tax jurisdiction ${p.taxJurisdictionCode}`, 'unknown_tax_jurisdiction');
}
const profileData = (p: ProfileInput) => ({
  ...(p.legalForm !== undefined ? { legalForm: p.legalForm } : {}),
  ...(p.incorporationDate !== undefined ? { incorporationDate: p.incorporationDate ? new Date(p.incorporationDate) : null } : {}),
  ...(p.yearEnd !== undefined ? { yearEndMonth: p.yearEnd?.month ?? null, yearEndDay: p.yearEnd?.day ?? null } : {}),
  ...(p.baseCurrency !== undefined ? { baseCurrency: p.baseCurrency } : {}),
  ...(p.countryCode !== undefined ? { countryCode: p.countryCode } : {}),
  ...(p.taxJurisdictionCode !== undefined ? { taxJurisdictionCode: p.taxJurisdictionCode } : {}),
});
const PROFILE_KEYS = ['name', 'legalForm', 'incorporationDate', 'yearEndMonth', 'yearEndDay', 'baseCurrency', 'countryCode', 'taxJurisdictionCode'] as const;
const auditView = (c: Company) => ({ ...c, incorporationDate: isoDay(c.incorporationDate) }) as unknown as Record<string, unknown>;

@Injectable()
export class CompaniesService {
  constructor(@Inject(DB) private readonly db: Database, private readonly audit: AuditService) {}

  private t<T>(org: OrgAccess, fn: (tx: Tx) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, fn); }

  /**
   * The managing practice is an explicit relationship: required for PRACTICE organisations (defaulted when there is
   * exactly one), forbidden for direct BUSINESS organisations (also enforced by a database trigger).
   */
  private async resolvePractice(org: OrgAccess, tx: Tx, requested?: string): Promise<string | null> {
    if (org.organisationType === 'BUSINESS') {
      if (requested) throw unprocessable('Direct business organisations do not have practices', 'practice_not_allowed');
      if (!(await org.access.can('company:create'))) throw forbidden('You do not have permission to perform this action', 'permission_denied');
      return null;
    }
    let practiceId = requested;
    if (!practiceId) {
      const all = await tx.practice.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, take: 2 });
      if (all.length !== 1) throw unprocessable('practiceId is required', 'practice_required');
      practiceId = all[0]!.id;
    }
    if (!(await tx.practice.findUnique({ where: { id: practiceId }, select: { id: true } }))) throw notFound('Practice not found');
    if (!(await org.access.can('company:create', { practiceId }))) throw forbidden('You do not have permission to create companies in this practice', 'permission_denied');
    return practiceId;
  }

  async create(org: OrgAccess, input: { name: string; companyNumber?: string; legalForm: string; practiceId?: string } & ProfileInput) {
    try {
      return await this.t(org, async (tx) => {
        const practiceId = await this.resolvePractice(org, tx, input.practiceId);
        await assertReferences(tx, input);
        const company = await tx.company.create({
          data: { organisationId: org.organisationId, practiceId, name: input.name, companyNumber: input.companyNumber?.toUpperCase(), ...profileData(input) },
        });
        // A creator must be able to see what they create: if no existing grant covers the new company, grant their own role on it.
        const snap = org.access.snapshot;
        if (!companyPermissions(snap, { id: company.id, practiceId }).has('company:read')) {
          const roleId = (await tx.organisationMembership.findUniqueOrThrow({ where: { id: org.membershipId }, select: { roleId: true } })).roleId;
          await tx.companyMembership.create({ data: { organisationId: org.organisationId, membershipId: org.membershipId, companyId: company.id, roleId } });
        }
        await this.audit.record({ action: 'company.created', organisationId: org.organisationId, actorUserId: org.userId, companyId: company.id, entityType: 'company', entityId: company.id, after: { name: company.name, companyNumber: company.companyNumber, practiceId, legalForm: company.legalForm, baseCurrency: company.baseCurrency, countryCode: company.countryCode, incorporationDate: isoDay(company.incorporationDate), yearEnd: companyDto(company).yearEnd } }, tx);
        await publishEvent(tx, Events.companyCreated, { aggregateId: company.id, organisationId: org.organisationId, actorUserId: org.userId, payload: { companyId: company.id, name: company.name } });
        return companyDto(company);
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('A company with this number already exists in the organisation', 'company_exists');
      throw e;
    }
  }

  async list(org: OrgAccess, q: { limit: number; cursor?: string }) {
    const scope = await org.access.companyTableWhere('company:read');
    const rows = await this.t(org, (tx) => tx.company.findMany({
      where: { ...scope, status: 'ACTIVE' }, orderBy: { id: 'asc' }, take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    }));
    return { items: rows.slice(0, q.limit).map(companyDto), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  async get(org: OrgAccess, companyId: string) {
    await org.access.requireCompany('company:read', companyId);
    const c = await this.t(org, (tx) => tx.company.findUnique({ where: { id: companyId } }));
    if (!c) throw notFound('Company not found');
    return companyDto(c);
  }

  /** Updates the name and/or the company profile (legal form, incorporation date, financial year-end, base currency, country, tax jurisdiction). */
  async update(org: OrgAccess, companyId: string, input: ProfileInput & { name?: string }) {
    await this.get(org, companyId);
    return this.t(org, async (tx) => {
      await assertReferences(tx, input);
      const before = await tx.company.findUniqueOrThrow({ where: { id: companyId } });
      const c = await tx.company.update({ where: { id: companyId }, data: { ...(input.name !== undefined ? { name: input.name } : {}), ...profileData(input) } });
      await this.audit.record({ action: 'company.updated', organisationId: org.organisationId, actorUserId: org.userId, companyId, entityType: 'company', entityId: companyId, ...changeSet(auditView(before), auditView(c), PROFILE_KEYS) }, tx);
      return companyDto(c);
    });
  }

  /** The accounting period that should follow the latest one, derived from the company's financial year-end. */
  async nextPeriod(org: OrgAccess, companyId: string) {
    const c = await this.t(org, async (tx) => ({ company: await tx.company.findUniqueOrThrow({ where: { id: companyId } }), last: await tx.accountingPeriod.findFirst({ where: { companyId }, orderBy: { endDate: 'desc' } }) }));
    if (!c.company.yearEndMonth || !c.company.yearEndDay) throw unprocessable('Set the company financial year-end first', 'year_end_not_set');
    const next = nextAccountingPeriod({ month: c.company.yearEndMonth, day: c.company.yearEndDay }, { lastPeriodEnd: isoDay(c.last?.endDate ?? null), incorporationDate: isoDay(c.company.incorporationDate) });
    if (!next) throw unprocessable('Set the incorporation date (or create a first period) so the next period can be derived', 'no_period_basis');
    return next;
  }

  async listPeriods(org: OrgAccess, companyId: string) {
    await this.get(org, companyId);
    return { items: await this.t(org, (tx) => tx.accountingPeriod.findMany({ where: { companyId }, orderBy: { startDate: 'asc' } })) };
  }

  async createPeriod(org: OrgAccess, companyId: string, input: { startDate: string; endDate: string }) {
    await this.get(org, companyId);
    try {
      return await this.t(org, async (tx) => {
        const p = await tx.accountingPeriod.create({
          data: { organisationId: org.organisationId, companyId, startDate: new Date(input.startDate), endDate: new Date(input.endDate) },
        });
        await this.audit.record({ action: 'period.created', organisationId: org.organisationId, actorUserId: org.userId, companyId, entityType: 'accounting_period', entityId: p.id, after: { startDate: input.startDate, endDate: input.endDate } }, tx);
        await publishEvent(tx, Events.accountingPeriodCreated, { aggregateId: p.id, organisationId: org.organisationId, actorUserId: org.userId, payload: { periodId: p.id, companyId, startDate: input.startDate, endDate: input.endDate } });
        return p;
      });
    } catch (e) {
      if (String((e as Error).message).includes('period_no_overlap')) throw conflict('Accounting period overlaps an existing period', 'period_overlap');
      throw e;
    }
  }
}
