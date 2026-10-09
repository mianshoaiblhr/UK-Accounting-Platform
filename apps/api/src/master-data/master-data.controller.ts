import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { contactListQuerySchema, createAddressSchema, createContactSchema, createOfficerSchema, reasonQuerySchema, updateAddressSchema, updateContactSchema, updateOfficerSchema } from '@uk/contracts';
import { Idempotent, Org, RequirePermissions } from '../common/decorators';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { MasterDataService } from './master-data.service';

const activeQuery = z.object({ active: z.enum(['true', 'false']).default('false').transform((v) => v === 'true') });
const ID = (n: string) => Param(n, ParseUUIDPipe);

/** Route permissions are the coarse gate; the exact decision (the contact's / company's own access) is made by org.access in the service. */
@Controller('organisations/:organisationId')
export class MasterDataController {
  constructor(private readonly svc: MasterDataService) {}

  // Contacts
  @Post('contacts') @RequirePermissions('contact:manage') @Idempotent()
  createContact(@Org() org: OrgAccess, @Body(new ZodPipe(createContactSchema)) b: z.output<typeof createContactSchema>) { return this.svc.createContact(org, b); }
  @Get('contacts') @RequirePermissions('contact:read')
  listContacts(@Org() org: OrgAccess, @Query(new ZodPipe(contactListQuerySchema)) q: z.output<typeof contactListQuerySchema>) { return this.svc.listContacts(org, q); }
  @Get('contacts/:contactId') @RequirePermissions('contact:read')
  getContact(@Org() org: OrgAccess, @ID('contactId') id: string) { return this.svc.getContact(org, id); }
  @Patch('contacts/:contactId') @RequirePermissions('contact:manage')
  updateContact(@Org() org: OrgAccess, @ID('contactId') id: string, @Body(new ZodPipe(updateContactSchema)) b: z.output<typeof updateContactSchema>) { return this.svc.updateContact(org, id, b); }
  @Post('contacts/:contactId/archive') @HttpCode(200) @RequirePermissions('contact:manage')
  archiveContact(@Org() org: OrgAccess, @ID('contactId') id: string, @Query(new ZodPipe(reasonQuerySchema)) q: z.output<typeof reasonQuerySchema>) { return this.svc.setContactStatus(org, id, 'ARCHIVED', q.reason); }
  @Post('contacts/:contactId/restore') @HttpCode(200) @RequirePermissions('contact:manage')
  restoreContact(@Org() org: OrgAccess, @ID('contactId') id: string) { return this.svc.setContactStatus(org, id, 'ACTIVE'); }

  // Contact addresses
  @Get('contacts/:contactId/addresses') @RequirePermissions('contact:read')
  contactAddresses(@Org() org: OrgAccess, @ID('contactId') id: string) { return this.svc.listAddresses(org, { contactId: id }); }
  @Post('contacts/:contactId/addresses') @RequirePermissions('contact:manage') @Idempotent()
  addContactAddress(@Org() org: OrgAccess, @ID('contactId') id: string, @Body(new ZodPipe(createAddressSchema)) b: z.output<typeof createAddressSchema>) { return this.svc.createAddress(org, { contactId: id }, b); }
  @Patch('contacts/:contactId/addresses/:addressId') @RequirePermissions('contact:manage')
  patchContactAddress(@Org() org: OrgAccess, @ID('contactId') id: string, @ID('addressId') a: string, @Body(new ZodPipe(updateAddressSchema)) b: z.output<typeof updateAddressSchema>) { return this.svc.updateAddress(org, { contactId: id }, a, b); }
  @Delete('contacts/:contactId/addresses/:addressId') @HttpCode(204) @RequirePermissions('contact:manage')
  deleteContactAddress(@Org() org: OrgAccess, @ID('contactId') id: string, @ID('addressId') a: string, @Query(new ZodPipe(reasonQuerySchema)) q: z.output<typeof reasonQuerySchema>) { return this.svc.deleteAddress(org, { contactId: id }, a, q.reason); }

  // Company addresses (registered office, trading, correspondence)
  @Get('companies/:companyId/addresses') @RequirePermissions('company:read')
  companyAddresses(@Org() org: OrgAccess, @ID('companyId') id: string) { return this.svc.listAddresses(org, { companyId: id }); }
  @Post('companies/:companyId/addresses') @RequirePermissions('company:update') @Idempotent()
  addCompanyAddress(@Org() org: OrgAccess, @ID('companyId') id: string, @Body(new ZodPipe(createAddressSchema)) b: z.output<typeof createAddressSchema>) { return this.svc.createAddress(org, { companyId: id }, b); }
  @Patch('companies/:companyId/addresses/:addressId') @RequirePermissions('company:update')
  patchCompanyAddress(@Org() org: OrgAccess, @ID('companyId') id: string, @ID('addressId') a: string, @Body(new ZodPipe(updateAddressSchema)) b: z.output<typeof updateAddressSchema>) { return this.svc.updateAddress(org, { companyId: id }, a, b); }
  @Delete('companies/:companyId/addresses/:addressId') @HttpCode(204) @RequirePermissions('company:update')
  deleteCompanyAddress(@Org() org: OrgAccess, @ID('companyId') id: string, @ID('addressId') a: string, @Query(new ZodPipe(reasonQuerySchema)) q: z.output<typeof reasonQuerySchema>) { return this.svc.deleteAddress(org, { companyId: id }, a, q.reason); }

  // Directors / officers
  @Get('companies/:companyId/officers') @RequirePermissions('company:read')
  officers(@Org() org: OrgAccess, @ID('companyId') id: string, @Query(new ZodPipe(activeQuery)) q: z.output<typeof activeQuery>) { return this.svc.listOfficers(org, id, q.active); }
  @Post('companies/:companyId/officers') @RequirePermissions('company:update') @Idempotent()
  appoint(@Org() org: OrgAccess, @ID('companyId') id: string, @Body(new ZodPipe(createOfficerSchema)) b: z.output<typeof createOfficerSchema>) { return this.svc.appointOfficer(org, id, b); }
  @Patch('companies/:companyId/officers/:officerId') @RequirePermissions('company:update')
  resign(@Org() org: OrgAccess, @ID('companyId') id: string, @ID('officerId') o: string, @Body(new ZodPipe(updateOfficerSchema)) b: z.output<typeof updateOfficerSchema>) { return this.svc.setResignation(org, id, o, b.resignedOn); }
}
