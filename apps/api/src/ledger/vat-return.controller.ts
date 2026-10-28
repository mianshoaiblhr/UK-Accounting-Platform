import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  createVatPresentationRuleSchema, createVatReturnSchema, explainVatFlagSchema, recordVatFilingSchema, simulateVatFilingSchema, supersedeVatPresentationRuleSchema, vatClientApprovalSchema,
  vatReturnListQuerySchema, vatReturnStepSchema, verifyVatPresentationRuleSchema,
} from '@uk/contracts';
import { VatFilingService, VatReturnService } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { VatApiService } from './vat.controller';

const ID = (n: string) => Param(n, ParseUUIDPipe);

/** V5-M1 (DEC-090): the VAT return per client and period: preparation, flag explanations, review and the client's approval (which locks the period). Nothing is filed. */
@Controller('organisations/:organisationId/companies/:companyId/vat-returns')
@RequireFeature('vat.returns')
export class VatReturnController {
  constructor(private readonly api: VatApiService, private readonly svc: VatReturnService) {}

  @Get() @RequirePermissions('ledger:read')
  list(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(vatReturnListQuerySchema)) q: z.output<typeof vatReturnListQuerySchema>) { return this.api.run(org, (tx) => this.svc.list(tx, c, q)); }
  @Post() @RequirePermissions('vat:prepare') @Idempotent()
  create(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createVatReturnSchema)) b: z.output<typeof createVatReturnSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.create(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Get(':returnId') @RequirePermissions('ledger:read')
  get(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('returnId') id: string) { return this.api.run(org, (tx) => this.svc.get(tx, c, id)); }
  @Post(':returnId/prepare') @HttpCode(200) @RequirePermissions('vat:prepare') @Idempotent()
  prepare(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('returnId') id: string, @Body(new ZodPipe(vatReturnStepSchema)) b: z.output<typeof vatReturnStepSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.prepare(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  /** Either vat:prepare or vat:review may explain a flag; the service checks which the caller holds. */
  @Post(':returnId/flag-explanations') @HttpCode(200) @RequirePermissions('ledger:read') @Idempotent()
  explain(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('returnId') id: string, @Body(new ZodPipe(explainVatFlagSchema)) b: z.output<typeof explainVatFlagSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.explainFlag(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Post(':returnId/review') @HttpCode(200) @RequirePermissions('vat:review') @Idempotent()
  review(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('returnId') id: string, @Body(new ZodPipe(vatReturnStepSchema)) b: z.output<typeof vatReturnStepSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.review(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Post(':returnId/client-approval') @HttpCode(200) @RequirePermissions('vat:review', 'period:lock') @Idempotent()
  approve(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('returnId') id: string, @Body(new ZodPipe(vatClientApprovalSchema)) b: z.output<typeof vatClientApprovalSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.clientApproval(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
}

/** V5-M2 (DEC-091): the presentation rule of boxes 6 to 9 (verified by a second person), the filing package and the filing record. Nothing is sent to HMRC. */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('vat.returns')
export class VatFilingController {
  constructor(private readonly api: VatApiService, private readonly svc: VatFilingService) {}

  @Get('vat-presentation-rules') @RequirePermissions('ledger:read')
  rules(@Org() org: OrgAccess) { return this.api.run(org, (tx) => this.svc.listRules(tx)); }
  @Post('vat-presentation-rules') @RequirePermissions('vat:manage') @Idempotent()
  addRule(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createVatPresentationRuleSchema)) b: z.output<typeof createVatPresentationRuleSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.addRule(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Post('vat-presentation-rules/:ruleId/supersede') @RequirePermissions('vat:manage') @Idempotent()
  supersede(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('ruleId') id: string, @Body(new ZodPipe(supersedeVatPresentationRuleSchema)) b: z.output<typeof supersedeVatPresentationRuleSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.supersedeRule(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Post('vat-presentation-rules/:ruleId/verify') @HttpCode(200) @RequirePermissions('tax:rule-verify') @Idempotent()
  verify(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('ruleId') id: string, @Body(new ZodPipe(verifyVatPresentationRuleSchema)) b: z.output<typeof verifyVatPresentationRuleSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.verifyRule(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Get('vat-returns/:returnId/package') @RequirePermissions('ledger:read')
  pkg(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('returnId') id: string) { return this.api.run(org, (tx) => this.svc.getPackage(tx, c, id)); }
  @Get('vat-returns/:returnId/filings') @RequirePermissions('ledger:read')
  filings(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('returnId') id: string) { return this.api.run(org, (tx) => this.svc.listFilings(tx, c, id)); }
  @Post('vat-returns/:returnId/filings') @RequirePermissions('vat:file') @Idempotent()
  record(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('returnId') id: string, @Body(new ZodPipe(recordVatFilingSchema)) b: z.output<typeof recordVatFilingSchema>) {
    const { declarationConfirmed: _confirmed, ...rest } = b;
    return this.api.run(org, (tx, actor) => this.svc.record(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...rest }));
  }
  @Post('vat-returns/:returnId/simulated-submissions') @RequirePermissions('vat:file') @Idempotent()
  simulate(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('returnId') id: string, @Body(new ZodPipe(simulateVatFilingSchema)) _b: z.output<typeof simulateVatFilingSchema>) {
    return this.api.run(org, (tx, actor) => this.svc.simulate(tx, { organisationId: org.organisationId, companyId: c, actor, id }));
  }
}
