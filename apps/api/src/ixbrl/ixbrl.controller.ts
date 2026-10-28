import { Body, Controller, Delete, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  conceptEntrySchema, createTaxonomyVersionSchema, supersedeTaxonomyVersionSchema, taxonomyListQuerySchema, updateTaxonomyVersionSchema, verifyTaxonomyVersionSchema, type Permission,
} from '@uk/contracts';
import type { Database, Tx } from '@uk/db';
import { TaxonomyService, type TaxonomyActor } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';

const ID = (n: string) => Param(n, ParseUUIDPipe);

@Injectable()
export class IxbrlApiService {
  constructor(@Inject(DB) private readonly db: Database) {}
  actor(org: OrgAccess): TaxonomyActor { return { userId: org.userId, kind: 'USER', can: (p) => org.access.can(p as Permission, {}) }; }
  run<T>(org: OrgAccess, fn: (tx: Tx, a: TaxonomyActor) => Promise<T>) {
    return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, (tx) => fn(tx, this.actor(org)));
  }
}

/** V3-M1 (DEC-093): taxonomy versions and their concept maps (organisation data), verified by a second person before use. */
@Controller('organisations/:organisationId/ixbrl/taxonomy-versions')
@RequireFeature('ixbrl.filing')
export class TaxonomyController {
  constructor(private readonly api: IxbrlApiService, private readonly svc: TaxonomyService) {}

  @Get() @RequirePermissions('org:read')
  list(@Org() org: OrgAccess, @Query(new ZodPipe(taxonomyListQuerySchema)) q: z.output<typeof taxonomyListQuerySchema>) { return this.api.run(org, (tx) => this.svc.list(tx, q)); }
  @Post() @RequirePermissions('ixbrl:rules-manage') @Idempotent()
  create(@Org() org: OrgAccess, @Body(new ZodPipe(createTaxonomyVersionSchema)) b: z.output<typeof createTaxonomyVersionSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.create(tx, { organisationId: org.organisationId, actor, ...b }));
  }
  @Get(':versionId') @RequirePermissions('org:read')
  get(@Org() org: OrgAccess, @ID('versionId') id: string) { return this.api.run(org, (tx) => this.svc.get(tx, id)); }
  @Patch(':versionId') @RequirePermissions('ixbrl:rules-manage')
  update(@Org() org: OrgAccess, @ID('versionId') id: string, @Body(new ZodPipe(updateTaxonomyVersionSchema)) b: z.output<typeof updateTaxonomyVersionSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.update(tx, { organisationId: org.organisationId, actor, id, ...b }));
  }
  @Post(':versionId/entries') @RequirePermissions('ixbrl:rules-manage') @Idempotent()
  addEntry(@Org() org: OrgAccess, @ID('versionId') id: string, @Body(new ZodPipe(conceptEntrySchema)) b: z.output<typeof conceptEntrySchema>) {
    return this.api.run(org, (tx, actor) => this.svc.addEntry(tx, { organisationId: org.organisationId, actor, versionId: id, entry: b }));
  }
  @Put(':versionId/entries/:entryId') @RequirePermissions('ixbrl:rules-manage')
  replaceEntry(@Org() org: OrgAccess, @ID('versionId') id: string, @ID('entryId') entryId: string, @Body(new ZodPipe(conceptEntrySchema)) b: z.output<typeof conceptEntrySchema>) {
    return this.api.run(org, (tx, actor) => this.svc.replaceEntry(tx, { organisationId: org.organisationId, actor, versionId: id, entryId, entry: b }));
  }
  @Delete(':versionId/entries/:entryId') @RequirePermissions('ixbrl:rules-manage')
  removeEntry(@Org() org: OrgAccess, @ID('versionId') id: string, @ID('entryId') entryId: string) {
    return this.api.run(org, (tx, actor) => this.svc.removeEntry(tx, { organisationId: org.organisationId, actor, versionId: id, entryId }));
  }
  @Post(':versionId/verify') @HttpCode(200) @RequirePermissions('ixbrl:rule-verify') @Idempotent()
  verify(@Org() org: OrgAccess, @ID('versionId') id: string, @Body(new ZodPipe(verifyTaxonomyVersionSchema)) b: z.output<typeof verifyTaxonomyVersionSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.verify(tx, { organisationId: org.organisationId, actor, id, ...b }));
  }
  @Post(':versionId/supersede') @RequirePermissions('ixbrl:rules-manage') @Idempotent()
  supersede(@Org() org: OrgAccess, @ID('versionId') id: string, @Body(new ZodPipe(supersedeTaxonomyVersionSchema)) b: z.output<typeof supersedeTaxonomyVersionSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.supersede(tx, { organisationId: org.organisationId, actor, id, ...b }));
  }
}
