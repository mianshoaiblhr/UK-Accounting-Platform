import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { z } from 'zod';
import { asOfQuerySchema } from '@uk/contracts';
import type { Database } from '@uk/db';
import { Org, RequirePermissions } from '../common/decorators';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';

/** Read-only reference data (ISO 4217 / ISO 3166-1 / effective-dated tax jurisdictions). Changes ship as migrations. */
@Controller('organisations/:organisationId/reference')
export class ReferenceController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get('currencies') @RequirePermissions('org:read')
  async currencies(@Org() org: OrgAccess) {
    const rows = await this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, (tx) => tx.currency.findMany({ orderBy: { code: 'asc' } }));
    return { items: rows.map((r) => ({ code: r.code, numericCode: r.numericCode, name: r.name, minorUnits: r.minorUnits })) };
  }

  @Get('countries') @RequirePermissions('org:read')
  async countries(@Org() org: OrgAccess) {
    const rows = await this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, (tx) => tx.country.findMany({ orderBy: { name: 'asc' } }));
    return { items: rows.map((r) => ({ alpha2: r.alpha2, alpha3: r.alpha3, numericCode: r.numericCode, name: r.name })) };
  }

  /** Jurisdiction definitions in force on `asOf` (default: today), optionally for one country. */
  @Get('tax-jurisdictions') @RequirePermissions('org:read')
  async taxJurisdictions(@Org() org: OrgAccess, @Query(new ZodPipe(asOfQuerySchema)) q: z.output<typeof asOfQuerySchema>) {
    const asOf = new Date(q.asOf ?? new Date().toISOString().slice(0, 10));
    const rows = await this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, (tx) => tx.taxJurisdiction.findMany({
      where: { validFrom: { lte: asOf }, OR: [{ validTo: null }, { validTo: { gt: asOf } }], ...(q.countryCode ? { countryCode: q.countryCode } : {}) }, orderBy: { code: 'asc' },
    }));
    return { items: rows.map((r) => ({ id: r.id, code: r.code, countryCode: r.countryCode, name: r.name, authority: r.authority, validFrom: r.validFrom.toISOString().slice(0, 10), validTo: r.validTo ? r.validTo.toISOString().slice(0, 10) : null })) };
  }

  /**
   * Retention classification: every category with its period and which document types fall in it. Classification only - nothing is purged.
   * All periods are PROVISIONAL until the DPO/legal decision is recorded (status says so).
   */
  @Get('retention-categories') @RequirePermissions('org:read')
  async retentionCategories(@Org() org: OrgAccess) {
    const rows = await this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, (tx) => tx.retentionCategory.findMany({
      orderBy: { code: 'asc' }, include: { rules: { where: { subjectKind: 'DOCUMENT_TYPE' }, orderBy: { subject: 'asc' } } } }));
    return { items: rows.map((c) => ({ code: c.code, name: c.name, kind: c.kind, years: c.periodYears, days: c.periodDays, trigger: c.periodTrigger, basis: c.basis, status: c.status, documentTypes: c.rules.map((r) => r.subject) })) };
  }
}
