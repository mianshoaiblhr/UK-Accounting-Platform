import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { associatedCompaniesSchema, createCtRuleSchema, ctRuleListQuerySchema, deriveCtPeriodsSchema, supersedeCtRuleSchema, taxProfileSchema, verifyCtRuleSchema } from '@uk/contracts';
import { CorporationTaxService, ctPeriodView } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { VatApiService } from '../ledger/vat.controller';

const ID = (n: string) => Param(n, ParseUUIDPipe);

/** V4-M1 (DEC-097): Corporation Tax rules (verified by a second person), the company's tax profile and its CT accounting periods. */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('corporation.tax')
export class CorporationTaxController {
  constructor(private readonly api: VatApiService, private readonly svc: CorporationTaxService) {}

  @Get('ct-rules') @RequirePermissions('ledger:read')
  listRules(@Org() org: OrgAccess, @Query(new ZodPipe(ctRuleListQuerySchema)) q: z.output<typeof ctRuleListQuerySchema>) { return this.api.run(org, (tx) => this.svc.listRules(tx, q)); }
  @Post('ct-rules') @RequirePermissions('ct:manage') @Idempotent()
  addRule(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createCtRuleSchema)) b: z.output<typeof createCtRuleSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.addRule(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Get('ct-rules/:ruleId') @RequirePermissions('ledger:read')
  getRule(@Org() org: OrgAccess, @ID('ruleId') id: string) { return this.api.run(org, (tx) => this.svc.getRule(tx, id)); }
  @Post('ct-rules/:ruleId/supersede') @RequirePermissions('ct:manage') @Idempotent()
  supersede(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('ruleId') id: string, @Body(new ZodPipe(supersedeCtRuleSchema)) b: z.output<typeof supersedeCtRuleSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.supersedeRule(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Post('ct-rules/:ruleId/verify') @HttpCode(200) @RequirePermissions('tax:rule-verify') @Idempotent()
  verify(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('ruleId') id: string, @Body(new ZodPipe(verifyCtRuleSchema)) b: z.output<typeof verifyCtRuleSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.verifyRule(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }

  @Get('tax-profile') @RequirePermissions('ledger:read')
  getProfile(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, (tx) => this.svc.getProfile(tx, c)); }
  @Put('tax-profile') @RequirePermissions('ct:prepare')
  setProfile(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(taxProfileSchema)) b: z.output<typeof taxProfileSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.setProfile(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }

  @Get('ct-periods') @RequirePermissions('ledger:read')
  listPeriods(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, (tx) => this.svc.listPeriods(tx, c)); }
  /** Idempotent: deriving a year again returns its periods with `created: false`. */
  @Post('ct-periods/derive') @HttpCode(200) @RequirePermissions('ct:prepare') @Idempotent()
  derive(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(deriveCtPeriodsSchema)) b: z.output<typeof deriveCtPeriodsSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.derivePeriods(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Get('ct-periods/:periodId') @RequirePermissions('ledger:read')
  async getPeriod(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') id: string) { return ctPeriodView(await this.api.run(org, (tx) => this.svc.getPeriod(tx, c, id))); }
  @Post('ct-periods/:periodId/associated-companies') @HttpCode(200) @RequirePermissions('ct:prepare') @Idempotent()
  setAssociated(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') id: string, @Body(new ZodPipe(associatedCompaniesSchema)) b: z.output<typeof associatedCompaniesSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.setAssociated(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
}
