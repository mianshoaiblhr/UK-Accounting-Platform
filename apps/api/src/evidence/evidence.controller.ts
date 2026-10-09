import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { createEvidenceLinkSchema, evidenceLinkQuerySchema, revokeEvidenceLinkSchema } from '@uk/contracts';
import { Org, RequirePermissions } from '../common/decorators';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { EvidenceService } from './evidence.service';

@Controller('organisations/:organisationId/evidence-links')
export class EvidenceController {
  constructor(private readonly svc: EvidenceService) {}

  @Post() @RequirePermissions('evidence:manage')
  create(@Org() org: OrgAccess, @Body(new ZodPipe(createEvidenceLinkSchema)) b: z.output<typeof createEvidenceLinkSchema>) { return this.svc.create(org, b); }

  @Get() @RequirePermissions('evidence:read')
  list(@Org() org: OrgAccess, @Query(new ZodPipe(evidenceLinkQuerySchema)) q: z.output<typeof evidenceLinkQuerySchema>) { return this.svc.list(org, q); }

  @Post(':linkId/revoke') @HttpCode(200) @RequirePermissions('evidence:manage')
  revoke(@Org() org: OrgAccess, @Param('linkId', ParseUUIDPipe) id: string, @Body(new ZodPipe(revokeEvidenceLinkSchema)) b: z.output<typeof revokeEvidenceLinkSchema>) { return this.svc.revoke(org, id, b.reason); }
}
