import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import type { z } from 'zod';
import { createPracticeSchema, setGrantSchema, updatePracticeSchema } from '@uk/contracts';
import { Idempotent, Org, RequirePermissions } from '../common/decorators';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { PracticesService } from './practices.service';

/**
 * Route permissions are checked twice by the central OrgGuard: coarse (held anywhere) and, because the path names a
 * practice/company, exactly for that target.
 */
@Controller('organisations/:organisationId')
export class PracticesController {
  constructor(private readonly svc: PracticesService) {}

  @Post('practices') @RequirePermissions('practice:manage') @Idempotent()
  create(@Org() org: OrgAccess, @Body(new ZodPipe(createPracticeSchema)) b: z.output<typeof createPracticeSchema>) { return this.svc.create(org, b); }

  @Get('practices') @RequirePermissions('practice:read')
  list(@Org() org: OrgAccess) { return this.svc.list(org); }

  @Get('practices/:practiceId') @RequirePermissions('practice:read')
  get(@Org() org: OrgAccess, @Param('practiceId', ParseUUIDPipe) id: string) { return this.svc.get(org, id); }

  @Patch('practices/:practiceId') @RequirePermissions('practice:manage')
  update(@Org() org: OrgAccess, @Param('practiceId', ParseUUIDPipe) id: string, @Body(new ZodPipe(updatePracticeSchema)) b: z.output<typeof updatePracticeSchema>) { return this.svc.update(org, id, b); }

  @Get('practices/:practiceId/members') @RequirePermissions('practice:read')
  members(@Org() org: OrgAccess, @Param('practiceId', ParseUUIDPipe) id: string) { return this.svc.listMembers(org, id); }

  @Put('practices/:practiceId/members/:membershipId') @RequirePermissions('practice:member:manage')
  setMember(@Org() org: OrgAccess, @Param('practiceId', ParseUUIDPipe) id: string, @Param('membershipId', ParseUUIDPipe) m: string, @Body(new ZodPipe(setGrantSchema)) b: z.output<typeof setGrantSchema>) {
    return this.svc.setMember(org, id, m, b.roleId);
  }

  @Delete('practices/:practiceId/members/:membershipId') @HttpCode(204) @RequirePermissions('practice:member:manage')
  removeMember(@Org() org: OrgAccess, @Param('practiceId', ParseUUIDPipe) id: string, @Param('membershipId', ParseUUIDPipe) m: string) { return this.svc.removeMember(org, id, m); }

  @Get('companies/:companyId/access') @RequirePermissions('company:access:manage')
  companyAccess(@Org() org: OrgAccess, @Param('companyId', ParseUUIDPipe) id: string) { return this.svc.listCompanyAccess(org, id); }

  @Put('companies/:companyId/access/:membershipId') @RequirePermissions('company:access:manage')
  setCompanyAccess(@Org() org: OrgAccess, @Param('companyId', ParseUUIDPipe) id: string, @Param('membershipId', ParseUUIDPipe) m: string, @Body(new ZodPipe(setGrantSchema)) b: z.output<typeof setGrantSchema>) {
    return this.svc.setCompanyAccess(org, id, m, b.roleId);
  }

  @Delete('companies/:companyId/access/:membershipId') @HttpCode(204) @RequirePermissions('company:access:manage')
  removeCompanyAccess(@Org() org: OrgAccess, @Param('companyId', ParseUUIDPipe) id: string, @Param('membershipId', ParseUUIDPipe) m: string) { return this.svc.removeCompanyAccess(org, id, m); }
}
