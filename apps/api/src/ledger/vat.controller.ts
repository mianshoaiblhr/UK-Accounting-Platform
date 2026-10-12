import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { createTaxCodeSchema, createTaxRateSchema, supersedeTaxRateSchema, taxCodeListQuerySchema, vatSettingsSchema, vatWorkpaperQuerySchema, verifyTaxRateSchema, type Permission } from '@uk/contracts';
import type { Database, Tx } from '@uk/db';
import { VatService, type VatActor } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';

const ID = (n: string) => Param(n, ParseUUIDPipe);
const periodQuery = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();

@Injectable()
export class VatApiService {
  constructor(@Inject(DB) private readonly db: Database, private readonly vat: VatService) {}
  private t<T>(org: OrgAccess, fn: (tx: Tx) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, fn); }
  actor(org: OrgAccess): VatActor {
    return { userId: org.userId, kind: 'USER', can: (p, companyId) => org.access.can(p as Permission, { companyId }), canReadDocument: (d) => org.access.canReadDocument({ ...d, createdByUserId: d.createdByUserId ?? '' }) };
  }
  run<T>(org: OrgAccess, fn: (tx: Tx, a: VatActor) => Promise<T>) { return this.t(org, (tx) => fn(tx, this.actor(org))); }
}

/** VAT foundation (M4b): codes, sourced rate versions (verified by a second person), settings, return periods and the nine-box workpaper. */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('bookkeeping.core')
export class VatController {
  constructor(private readonly api: VatApiService, private readonly vat: VatService) {}

  @Get('tax-codes') @RequirePermissions('ledger:read')
  list(@Org() org: OrgAccess, @Query(new ZodPipe(taxCodeListQuerySchema)) _q: z.output<typeof taxCodeListQuerySchema>) { return this.api.run(org, (tx) => this.vat.listCodes(tx)); }
  @Post('tax-codes') @RequirePermissions('vat:manage') @Idempotent()
  create(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createTaxCodeSchema)) b: z.output<typeof createTaxCodeSchema>) {
    return this.api.run(org, (tx, actor) => this.vat.createCode(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Get('tax-codes/:taxCodeId') @RequirePermissions('ledger:read')
  get(@Org() org: OrgAccess, @ID('taxCodeId') id: string) { return this.api.run(org, (tx) => this.vat.getCode(tx, id)); }
  @Post('tax-codes/:taxCodeId/rates') @RequirePermissions('vat:manage') @Idempotent()
  addRate(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('taxCodeId') id: string, @Body(new ZodPipe(createTaxRateSchema)) b: z.output<typeof createTaxRateSchema>) {
    return this.api.run(org, (tx, actor) => this.vat.addRate(tx, { organisationId: org.organisationId, companyId: c, actor, taxCodeId: id, ...b }));
  }
  @Post('tax-rates/:rateId/supersede') @RequirePermissions('vat:manage') @Idempotent()
  supersede(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('rateId') id: string, @Body(new ZodPipe(supersedeTaxRateSchema)) b: z.output<typeof supersedeTaxRateSchema>) {
    return this.api.run(org, (tx, actor) => this.vat.supersedeRate(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Post('tax-rates/:rateId/verify') @HttpCode(200) @RequirePermissions('tax:rule-verify') @Idempotent()
  verify(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('rateId') id: string, @Body(new ZodPipe(verifyTaxRateSchema)) b: z.output<typeof verifyTaxRateSchema>) {
    return this.api.run(org, (tx, actor) => this.vat.verifyRate(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Get('vat-settings') @RequirePermissions('ledger:read')
  settings(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, (tx) => this.vat.getSettings(tx, c)); }
  @Put('vat-settings') @RequirePermissions('vat:manage')
  setSettings(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(vatSettingsSchema)) b: z.output<typeof vatSettingsSchema>) {
    return this.api.run(org, (tx, actor) => this.vat.setSettings(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Get('vat/period') @RequirePermissions('ledger:read')
  period(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(periodQuery)) q: z.output<typeof periodQuery>) { return this.api.run(org, (tx) => this.vat.period(tx, c, q.date)); }
  @Get('vat/workpaper') @RequirePermissions('ledger:read')
  workpaper(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(vatWorkpaperQuerySchema)) q: z.output<typeof vatWorkpaperQuerySchema>) { return this.api.run(org, (tx) => this.vat.workpaper(tx, c, q)); }
}
