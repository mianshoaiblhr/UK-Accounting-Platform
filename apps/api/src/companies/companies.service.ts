import { Inject, Injectable } from '@nestjs/common';
import { conflict, notFound } from '@uk/core';
import { Prisma, type Database, type Tx } from '@uk/db';
import { AuditService } from '../audit/audit.service';
import { DB } from '../common/tokens';
import { canAccessCompany, type OrgAccess } from '../common/types';

@Injectable()
export class CompaniesService {
  constructor(@Inject(DB) private readonly db: Database, private readonly audit: AuditService) {}

  private t<T>(org: OrgAccess, fn: (tx: Tx) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, fn); }

  private scopeFilter(org: OrgAccess) {
    return org.companyScope === 'ALL' ? {} : { id: { in: [...org.assignedCompanyIds] } };
  }

  async create(org: OrgAccess, input: { name: string; companyNumber?: string; legalForm: string }) {
    try {
      return await this.t(org, async (tx) => {
        const company = await tx.company.create({
          data: { organisationId: org.organisationId, name: input.name, companyNumber: input.companyNumber?.toUpperCase(), legalForm: input.legalForm },
        });
        if (org.companyScope === 'ASSIGNED') {
          // Creators with assigned-only scope must be able to see what they create.
          await tx.companyAssignment.create({ data: { organisationId: org.organisationId, membershipId: org.membershipId, companyId: company.id } });
        }
        await this.audit.record({ action: 'company.created', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'company', entityId: company.id, metadata: { name: company.name } }, tx);
        return company;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw conflict('A company with this number already exists in the organisation', 'company_exists');
      throw e;
    }
  }

  async list(org: OrgAccess, q: { limit: number; cursor?: string }) {
    const rows = await this.t(org, (tx) => tx.company.findMany({
      where: { ...this.scopeFilter(org), status: 'ACTIVE' }, orderBy: { id: 'asc' }, take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    }));
    return { items: rows.slice(0, q.limit), nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.id : null };
  }

  async get(org: OrgAccess, companyId: string) {
    if (!canAccessCompany(org, companyId)) throw notFound('Company not found');
    const c = await this.t(org, (tx) => tx.company.findUnique({ where: { id: companyId } }));
    if (!c) throw notFound('Company not found');
    return c;
  }

  async rename(org: OrgAccess, companyId: string, name: string) {
    await this.get(org, companyId);
    return this.t(org, async (tx) => {
      const c = await tx.company.update({ where: { id: companyId }, data: { name } });
      await this.audit.record({ action: 'company.updated', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'company', entityId: companyId, metadata: { name } }, tx);
      return c;
    });
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
        await this.audit.record({ action: 'period.created', organisationId: org.organisationId, actorUserId: org.userId, entityType: 'accounting_period', entityId: p.id, metadata: { companyId, ...input } }, tx);
        return p;
      });
    } catch (e) {
      if (String((e as Error).message).includes('period_no_overlap')) throw conflict('Accounting period overlaps an existing period', 'period_overlap');
      throw e;
    }
  }
}
