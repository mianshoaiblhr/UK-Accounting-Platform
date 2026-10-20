import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { createThresholdSetSchema, sizeTestQuerySchema, supersedeThresholdSetSchema, updateThresholdSetSchema, verifyThresholdSetSchema } from '@uk/contracts';
import { SizeTestService, SizeThresholdService } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { AccountsApiService } from './standards.controller';

const ID = (n: string) => Param(n, ParseUUIDPipe);
type In<S extends z.ZodTypeAny> = z.output<S>;

/**
 * V2-M5b (DEC-066): size threshold sets (authored with accounts:rules-manage while unverified, verified by another person with
 * accounts:rule-verify) and the size test of a framework year (ledger:read). Behind `accounts.production`.
 */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('accounts.production')
export class SizeTestController {
  constructor(private readonly api: AccountsApiService, private readonly thresholds: SizeThresholdService, private readonly sizes: SizeTestService) {}

  @Get('size-threshold-sets') @RequirePermissions('ledger:read')
  list(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, c, (tx) => this.thresholds.list(tx)); }
  @Post('size-threshold-sets') @RequirePermissions('accounts:rules-manage') @Idempotent()
  create(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createThresholdSetSchema)) b: In<typeof createThresholdSetSchema>) {
    return this.api.run(org, c, (tx, x) => this.thresholds.create(tx, { ...x, ...b }));
  }
  @Get('size-threshold-sets/:setId') @RequirePermissions('ledger:read')
  get(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('setId') id: string) { return this.api.run(org, c, (tx) => this.thresholds.get(tx, id)); }
  @Patch('size-threshold-sets/:setId') @RequirePermissions('accounts:rules-manage')
  update(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('setId') id: string, @Body(new ZodPipe(updateThresholdSetSchema)) b: In<typeof updateThresholdSetSchema>) {
    return this.api.run(org, c, (tx, x) => this.thresholds.update(tx, { ...x, id, ...b }));
  }
  @Post('size-threshold-sets/:setId/verify') @HttpCode(200) @RequirePermissions('accounts:rule-verify') @Idempotent()
  verify(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('setId') id: string, @Body(new ZodPipe(verifyThresholdSetSchema)) b: In<typeof verifyThresholdSetSchema>) {
    return this.api.run(org, c, (tx, x) => this.thresholds.verify(tx, { ...x, id, ...b }));
  }
  @Post('size-threshold-sets/:setId/supersede') @RequirePermissions('accounts:rules-manage') @Idempotent()
  supersede(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('setId') id: string, @Body(new ZodPipe(supersedeThresholdSetSchema)) b: In<typeof supersedeThresholdSetSchema>) {
    return this.api.run(org, c, (tx, x) => this.thresholds.supersede(tx, { ...x, id, ...b }));
  }
  @Get('size-test') @RequirePermissions('ledger:read')
  test(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(sizeTestQuerySchema)) q: In<typeof sizeTestQuerySchema>) { return this.api.run(org, c, (tx) => this.sizes.test(tx, c, q)); }
}
