import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { createCompanySchema, createPeriodSchema, paginationSchema, updateCompanySchema } from '@uk/contracts';
import { Idempotent, Org, RequirePermissions } from '../common/decorators';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { CompaniesService } from './companies.service';

@Controller('organisations/:organisationId/companies')
export class CompaniesController {
  constructor(private readonly svc: CompaniesService) {}

  @Post() @RequirePermissions('company:create') @Idempotent()
  create(@Org() org: OrgAccess, @Body(new ZodPipe(createCompanySchema)) b: z.output<typeof createCompanySchema>) { return this.svc.create(org, b); }

  @Get() @RequirePermissions('company:read')
  list(@Org() org: OrgAccess, @Query(new ZodPipe(paginationSchema)) q: z.output<typeof paginationSchema>) { return this.svc.list(org, q); }

  @Get(':companyId') @RequirePermissions('company:read')
  get(@Org() org: OrgAccess, @Param('companyId', ParseUUIDPipe) id: string) { return this.svc.get(org, id); }

  @Patch(':companyId') @RequirePermissions('company:update')
  rename(@Org() org: OrgAccess, @Param('companyId', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateCompanySchema)) b: z.output<typeof updateCompanySchema>) {
    return this.svc.rename(org, id, b.name);
  }

  @Get(':companyId/periods') @RequirePermissions('period:read')
  periods(@Org() org: OrgAccess, @Param('companyId', ParseUUIDPipe) id: string) { return this.svc.listPeriods(org, id); }

  @Post(':companyId/periods') @RequirePermissions('period:manage') @Idempotent()
  createPeriod(@Org() org: OrgAccess, @Param('companyId', ParseUUIDPipe) id: string, @Body(new ZodPipe(createPeriodSchema)) b: z.output<typeof createPeriodSchema>) {
    return this.svc.createPeriod(org, id, b);
  }
}
