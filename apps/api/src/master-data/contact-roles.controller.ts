import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import type { z } from 'zod';
import { bankDetailsSchema, contactRoleListQuerySchema, createContactRoleSchema, endContactRoleSchema, updateContactRoleSchema, verifyBankDetailsSchema } from '@uk/contracts';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { ContactRolesService } from './contact-roles.service';

const ID = (n: string) => Param(n, ParseUUIDPipe);

/** Customers and suppliers (M4a): roles of the shared contact, per company. Supplier bank details need their own permission and a second-person verification. */
@Controller('organisations/:organisationId/companies/:companyId/contact-roles')
@RequireFeature('bookkeeping.core')
export class ContactRolesController {
  constructor(private readonly svc: ContactRolesService) {}

  @Get() @RequirePermissions('contact:read')
  list(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(contactRoleListQuerySchema)) q: z.output<typeof contactRoleListQuerySchema>) { return this.svc.list(org, c, q); }
  @Post() @RequirePermissions('contact:manage') @Idempotent()
  create(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createContactRoleSchema)) b: z.output<typeof createContactRoleSchema>) { return this.svc.create(org, c, b); }
  @Get(':roleId') @RequirePermissions('contact:read')
  get(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('roleId') id: string) { return this.svc.get(org, c, id); }
  @Patch(':roleId') @RequirePermissions('contact:manage')
  update(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('roleId') id: string, @Body(new ZodPipe(updateContactRoleSchema)) b: z.output<typeof updateContactRoleSchema>) { return this.svc.update(org, c, id, b); }
  @Post(':roleId/end') @HttpCode(200) @RequirePermissions('contact:manage')
  end(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('roleId') id: string, @Body(new ZodPipe(endContactRoleSchema)) b: z.output<typeof endContactRoleSchema>) { return this.svc.setStatus(org, c, id, 'ENDED', b.reason); }
  @Post(':roleId/reactivate') @HttpCode(200) @RequirePermissions('contact:manage')
  reactivate(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('roleId') id: string) { return this.svc.setStatus(org, c, id, 'ACTIVE'); }
  @Get(':roleId/snapshot') @RequirePermissions('contact:read')
  snapshot(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('roleId') id: string) { return this.svc.snapshot(org, c, id); }

  @Put(':roleId/bank-details') @RequirePermissions('contact:bank-details')
  setBank(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('roleId') id: string, @Body(new ZodPipe(bankDetailsSchema)) b: z.output<typeof bankDetailsSchema>) { return this.svc.setBankDetails(org, c, id, b); }
  @Get(':roleId/bank-details') @RequirePermissions('contact:bank-details')
  viewBank(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('roleId') id: string) { return this.svc.viewBankDetails(org, c, id); }
  @Post(':roleId/bank-details/verify') @HttpCode(200) @RequirePermissions('contact:bank-details')
  verifyBank(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('roleId') id: string, @Body(new ZodPipe(verifyBankDetailsSchema)) b: z.output<typeof verifyBankDetailsSchema>) { return this.svc.verifyBankDetails(org, c, id, b.note); }
}
