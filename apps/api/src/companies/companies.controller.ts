import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { createCompanySchema, createPeriodSchema, paginationSchema, updateCompanySchema } from '@uk/contracts';
import type { FeatureFlagService } from '@uk/platform';
import { Idempotent, Org, RequirePermissions } from '../common/decorators';
import { FEATURES } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { CompaniesService } from './companies.service';

@Controller('organisations/:organisationId/companies')
export class CompaniesController {
  constructor(private readonly svc: CompaniesService, @Inject(FEATURES) private readonly flags: FeatureFlagService) {}

  @Post() @RequirePermissions('company:create') @Idempotent()
  create(@Org() org: OrgAccess, @Body(new ZodPipe(createCompanySchema)) b: z.output<typeof createCompanySchema>) { return this.svc.create(org, b); }

  @Get() @RequirePermissions('company:read')
  list(@Org() org: OrgAccess, @Query(new ZodPipe(paginationSchema)) q: z.output<typeof paginationSchema>) { return this.svc.list(org, q); }

  @Get(':companyId') @RequirePermissions('company:read')
  get(@Org() org: OrgAccess, @Param('companyId', ParseUUIDPipe) id: string) { return this.svc.get(org, id); }

  /**
   * What the caller may do in this company and which features are on (M9, DEC-049): for screens to hide what the person may not do.
   * Read-only; the guards on every route stay the only enforcement. A company the caller cannot see is 404, as for GET company.
   */
  @Get(':companyId/my-access') @RequirePermissions('company:read')
  async myAccess(@Org() org: OrgAccess, @Param('companyId', ParseUUIDPipe) id: string) {
    await this.svc.get(org, id);
    const [permissions, flags] = await Promise.all([org.access.effectivePermissions(id), this.flags.list(org.organisationId)]);
    return { companyId: id, permissions: [...permissions].sort(), features: Object.fromEntries(flags.map((f) => [f.key, f.enabled])) };
  }

  @Patch(':companyId') @RequirePermissions('company:update')
  update(@Org() org: OrgAccess, @Param('companyId', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateCompanySchema)) b: z.output<typeof updateCompanySchema>) {
    return this.svc.update(org, id, b);
  }

  @Get(':companyId/periods/next') @RequirePermissions('period:read')
  nextPeriod(@Org() org: OrgAccess, @Param('companyId', ParseUUIDPipe) id: string) { return this.svc.nextPeriod(org, id); }

  @Get(':companyId/periods') @RequirePermissions('period:read')
  periods(@Org() org: OrgAccess, @Param('companyId', ParseUUIDPipe) id: string) { return this.svc.listPeriods(org, id); }

  @Post(':companyId/periods') @RequirePermissions('period:manage') @Idempotent()
  createPeriod(@Org() org: OrgAccess, @Param('companyId', ParseUUIDPipe) id: string, @Body(new ZodPipe(createPeriodSchema)) b: z.output<typeof createPeriodSchema>) {
    return this.svc.createPeriod(org, id, b);
  }
}
