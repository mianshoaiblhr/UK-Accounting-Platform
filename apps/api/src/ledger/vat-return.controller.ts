import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { createVatReturnSchema, explainVatFlagSchema, vatClientApprovalSchema, vatReturnListQuerySchema, vatReturnStepSchema } from '@uk/contracts';
import { VatReturnService } from '@uk/accounting';
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
