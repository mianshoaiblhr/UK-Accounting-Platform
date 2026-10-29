import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  associatedCompaniesSchema, createCtAdjustmentRuleSchema, createCtAdjustmentSchema, createCtRuleSchema, ctAdjustmentRuleListQuerySchema, ctRuleListQuerySchema, deriveCtPeriodsSchema, supersedeCtAdjustmentRuleSchema,
  approveCtComputationSchema, createLossOpeningSchema, ctComputationQuerySchema, prepareCtComputationSchema, supersedeLossOpeningSchema, verifyLossOpeningSchema,
  createPoolOpeningSchema, poolOpeningListQuerySchema, storeCapitalAllowancesSchema, supersedePoolOpeningSchema, verifyPoolOpeningSchema,
  supersedeCtRuleSchema, taxProfileSchema, verifyCtAdjustmentRuleSchema, verifyCtRuleSchema, withdrawCtAdjustmentSchema,
} from '@uk/contracts';
import { CapitalAllowanceService, CorporationTaxService, CtComputationService, ctPeriodView } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { VatApiService } from '../ledger/vat.controller';

const ID = (n: string) => Param(n, ParseUUIDPipe);

/** V4-M1 (DEC-097): Corporation Tax rules (verified by a second person), the company's tax profile and its CT accounting periods. */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('corporation.tax')
export class CorporationTaxController {
  constructor(private readonly api: VatApiService, private readonly svc: CorporationTaxService, private readonly ca: CapitalAllowanceService, private readonly comp: CtComputationService) {}

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

  // ───── V4-M2 (DEC-099): tax adjustments and the adjusted profit ─────
  @Get('ct-adjustment-rules') @RequirePermissions('ledger:read')
  listAdjustmentRules(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(ctAdjustmentRuleListQuerySchema)) q: z.output<typeof ctAdjustmentRuleListQuerySchema>) { return this.api.run(org, (tx) => this.svc.listAdjustmentRules(tx, c, q)); }
  @Post('ct-adjustment-rules') @RequirePermissions('ct:prepare') @Idempotent()
  addAdjustmentRule(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createCtAdjustmentRuleSchema)) b: z.output<typeof createCtAdjustmentRuleSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.addAdjustmentRule(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Post('ct-adjustment-rules/:ruleId/supersede') @RequirePermissions('ct:prepare') @Idempotent()
  supersedeAdjustmentRule(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('ruleId') id: string, @Body(new ZodPipe(supersedeCtAdjustmentRuleSchema)) b: z.output<typeof supersedeCtAdjustmentRuleSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.supersedeAdjustmentRule(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Post('ct-adjustment-rules/:ruleId/verify') @HttpCode(200) @RequirePermissions('tax:rule-verify') @Idempotent()
  verifyAdjustmentRule(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('ruleId') id: string, @Body(new ZodPipe(verifyCtAdjustmentRuleSchema)) b: z.output<typeof verifyCtAdjustmentRuleSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.verifyAdjustmentRule(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Get('ct-periods/:periodId/adjustments') @RequirePermissions('ledger:read')
  listAdjustments(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') id: string) { return this.api.run(org, (tx) => this.svc.listAdjustments(tx, c, id)); }
  @Post('ct-periods/:periodId/adjustments') @RequirePermissions('ct:prepare') @Idempotent()
  addAdjustment(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') id: string, @Body(new ZodPipe(createCtAdjustmentSchema)) b: z.output<typeof createCtAdjustmentSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.addAdjustment(tx, { organisationId: org.organisationId, companyId: c, actor, periodId: id, ...b }));
  }
  @Post('ct-periods/:periodId/adjustments/:adjustmentId/withdraw') @HttpCode(200) @RequirePermissions('ct:prepare') @Idempotent()
  withdrawAdjustment(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') periodId: string, @ID('adjustmentId') id: string, @Body(new ZodPipe(withdrawCtAdjustmentSchema)) b: z.output<typeof withdrawCtAdjustmentSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.withdrawAdjustment(tx, { organisationId: org.organisationId, companyId: c, actor, periodId, id, ...b }));
  }
  /** Read from the ledger each time; nothing is stored. */
  @Get('ct-periods/:periodId/adjusted-profit') @RequirePermissions('ledger:read')
  adjustedProfit(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') id: string) { return this.api.run(org, (tx) => this.svc.adjustedProfit(tx, c, id)); }

  // ───── V4-M3 (DEC-100): capital allowances ─────
  @Get('ca-pool-openings') @RequirePermissions('ledger:read')
  listOpenings(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(poolOpeningListQuerySchema)) q: z.output<typeof poolOpeningListQuerySchema>) { return this.api.run(org, (tx) => this.ca.listOpenings(tx, c, q)); }
  @Post('ca-pool-openings') @RequirePermissions('ct:prepare') @Idempotent()
  addOpening(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createPoolOpeningSchema)) b: z.output<typeof createPoolOpeningSchema>) {
    return this.api.run(org, (tx, actor) => this.ca.addOpening(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Post('ca-pool-openings/:openingId/supersede') @RequirePermissions('ct:prepare') @Idempotent()
  supersedeOpening(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('openingId') id: string, @Body(new ZodPipe(supersedePoolOpeningSchema)) b: z.output<typeof supersedePoolOpeningSchema>) {
    return this.api.run(org, (tx, actor) => this.ca.supersedeOpening(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Post('ca-pool-openings/:openingId/verify') @HttpCode(200) @RequirePermissions('tax:rule-verify') @Idempotent()
  verifyOpening(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('openingId') id: string, @Body(new ZodPipe(verifyPoolOpeningSchema)) b: z.output<typeof verifyPoolOpeningSchema>) {
    return this.api.run(org, (tx, actor) => this.ca.verifyOpening(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  /** Worked live from the register and the rules; nothing is written. */
  @Get('ct-periods/:periodId/capital-allowances') @RequirePermissions('ledger:read')
  previewCa(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') id: string) { return this.api.run(org, (tx) => this.ca.preview(tx, c, id)); }
  @Post('ct-periods/:periodId/capital-allowances') @RequirePermissions('ct:prepare') @Idempotent()
  storeCa(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') id: string, @Body(new ZodPipe(storeCapitalAllowancesSchema)) b: z.output<typeof storeCapitalAllowancesSchema>) {
    return this.api.run(org, (tx, actor) => this.ca.store(tx, { organisationId: org.organisationId, companyId: c, actor, periodId: id, ...b }));
  }
  @Get('ct-periods/:periodId/capital-allowances/computations') @RequirePermissions('ledger:read')
  listCa(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') id: string) { return this.api.run(org, (tx) => this.ca.list(tx, c, id)); }

  // ───── V4-M4 (DEC-101): losses, the computation and the canonical CT600 ─────
  @Get('ct-loss-openings') @RequirePermissions('ledger:read')
  listLossOpenings(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, (tx) => this.comp.listLossOpenings(tx, c)); }
  @Post('ct-loss-openings') @RequirePermissions('ct:prepare') @Idempotent()
  addLossOpening(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createLossOpeningSchema)) b: z.output<typeof createLossOpeningSchema>) {
    return this.api.run(org, (tx, actor) => this.comp.addLossOpening(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Post('ct-loss-openings/:openingId/supersede') @RequirePermissions('ct:prepare') @Idempotent()
  supersedeLossOpening(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('openingId') id: string, @Body(new ZodPipe(supersedeLossOpeningSchema)) b: z.output<typeof supersedeLossOpeningSchema>) {
    return this.api.run(org, (tx, actor) => this.comp.supersedeLossOpening(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Post('ct-loss-openings/:openingId/verify') @HttpCode(200) @RequirePermissions('tax:rule-verify') @Idempotent()
  verifyLossOpening(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('openingId') id: string, @Body(new ZodPipe(verifyLossOpeningSchema)) b: z.output<typeof verifyLossOpeningSchema>) {
    return this.api.run(org, (tx, actor) => this.comp.verifyLossOpening(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  /** Worked live; nothing is written. */
  @Get('ct-periods/:periodId/computation') @RequirePermissions('ledger:read')
  previewComputation(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') id: string, @Query(new ZodPipe(ctComputationQuerySchema)) q: z.output<typeof ctComputationQuerySchema>) {
    return this.api.run(org, (tx) => this.comp.preview(tx, c, id, q));
  }
  @Post('ct-periods/:periodId/computation') @RequirePermissions('ct:prepare') @Idempotent()
  prepareComputation(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') id: string, @Body(new ZodPipe(prepareCtComputationSchema)) b: z.output<typeof prepareCtComputationSchema>) {
    return this.api.run(org, (tx, actor) => this.comp.prepare(tx, { organisationId: org.organisationId, companyId: c, actor, periodId: id, ...b }));
  }
  @Get('ct-periods/:periodId/computations') @RequirePermissions('ledger:read')
  listComputations(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') id: string) { return this.api.run(org, (tx) => this.comp.list(tx, c, id)); }
  @Post('ct-periods/:periodId/computations/:computationId/approve') @HttpCode(200) @RequirePermissions('ct:approve') @Idempotent()
  approveComputation(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') periodId: string, @ID('computationId') id: string, @Body(new ZodPipe(approveCtComputationSchema)) b: z.output<typeof approveCtComputationSchema>) {
    return this.api.run(org, (tx, actor) => this.comp.approve(tx, { organisationId: org.organisationId, companyId: c, actor, periodId, id, ...b }));
  }
  @Get('ct-periods/:periodId/ct600') @RequirePermissions('ledger:read')
  ct600(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') id: string) { return this.api.run(org, (tx) => this.comp.ct600(tx, c, id)); }
}
