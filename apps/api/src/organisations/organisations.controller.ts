import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import type { z } from 'zod';
import { acceptInvitationSchema, createRoleSchema, inviteMemberSchema, updateMemberSchema } from '@uk/contracts';
import { Auth, Idempotent, Org, RequirePermissions } from '../common/decorators';
import type { AuthInfo, OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { OrganisationsService } from './organisations.service';

@Controller()
export class OrganisationsController {
  constructor(private readonly svc: OrganisationsService) {}

  @Get('organisations/:organisationId') @RequirePermissions('org:read')
  get(@Org() org: OrgAccess) { return this.svc.get(org); }

  @Get('organisations/:organisationId/me') @RequirePermissions('org:read')
  me(@Org() org: OrgAccess) {
    return { organisationId: org.organisationId, role: org.roleKey, permissions: [...org.permissions], companyScope: org.companyScope, companyIds: org.assignedCompanyIds };
  }

  @Get('organisations/:organisationId/roles') @RequirePermissions('role:read')
  async roles(@Org() org: OrgAccess) { return { items: await this.svc.listRoles(org), permissionCatalogue: this.svc.permissionCatalogue() }; }

  @Post('organisations/:organisationId/roles') @RequirePermissions('role:manage') @Idempotent()
  createRole(@Org() org: OrgAccess, @Body(new ZodPipe(createRoleSchema)) b: z.output<typeof createRoleSchema>) { return this.svc.createRole(org, b); }

  @Get('organisations/:organisationId/members') @RequirePermissions('member:read')
  async members(@Org() org: OrgAccess) { return { items: await this.svc.listMembers(org) }; }

  @Patch('organisations/:organisationId/members/:membershipId') @RequirePermissions('member:manage')
  updateMember(@Org() org: OrgAccess, @Param('membershipId', ParseUUIDPipe) id: string, @Body(new ZodPipe(updateMemberSchema)) b: z.output<typeof updateMemberSchema>) {
    return this.svc.updateMember(org, id, b);
  }

  @Delete('organisations/:organisationId/members/:membershipId') @HttpCode(204) @RequirePermissions('member:manage')
  removeMember(@Org() org: OrgAccess, @Param('membershipId', ParseUUIDPipe) id: string) { return this.svc.removeMember(org, id); }

  @Post('organisations/:organisationId/invitations') @RequirePermissions('member:invite') @Idempotent()
  invite(@Org() org: OrgAccess, @Body(new ZodPipe(inviteMemberSchema)) b: z.output<typeof inviteMemberSchema>) { return this.svc.invite(org, b); }

  @Get('organisations/:organisationId/invitations') @RequirePermissions('member:read')
  async invitations(@Org() org: OrgAccess) { return { items: await this.svc.listInvitations(org) }; }

  @Delete('organisations/:organisationId/invitations/:invitationId') @HttpCode(204) @RequirePermissions('member:invite')
  revoke(@Org() org: OrgAccess, @Param('invitationId', ParseUUIDPipe) id: string) { return this.svc.revokeInvitation(org, id); }

  /** Not org-scoped: the caller is not yet a member. */
  @Post('invitations/accept') @HttpCode(200)
  accept(@Auth() a: AuthInfo, @Body(new ZodPipe(acceptInvitationSchema)) b: z.output<typeof acceptInvitationSchema>) {
    return this.svc.acceptInvitation(a.userId, a.email, b.token);
  }
}
