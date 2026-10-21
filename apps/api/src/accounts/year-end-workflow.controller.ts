import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { reopenYearEndStepSchema, signOffYearEndStepSchema, yearEndWorkflowQuerySchema } from '@uk/contracts';
import { YearEndWorkflowService } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { YearEndApiService } from './year-end.controller';

const ID = (n: string) => Param(n, ParseUUIDPipe);
type In<S extends z.ZodTypeAny> = z.output<S>;

/** V2-M6b (DEC-069): the 14-step year-end workflow of a framework year (ledger:read); step sign-off and reopen (accounts:prepare). Behind `accounts.production`. */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('accounts.production')
export class YearEndWorkflowController {
  constructor(private readonly api: YearEndApiService, private readonly workflow: YearEndWorkflowService) {}

  @Get('year-end-workflow') @RequirePermissions('ledger:read')
  get(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(yearEndWorkflowQuerySchema)) q: In<typeof yearEndWorkflowQuerySchema>) { return this.api.run(org, c, (tx) => this.workflow.workflow(tx, c, q)); }
  @Post('year-end-workflow/sign-off') @HttpCode(200) @RequirePermissions('accounts:prepare') @Idempotent()
  signOff(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(signOffYearEndStepSchema)) b: In<typeof signOffYearEndStepSchema>) { return this.api.run(org, c, (tx, x) => this.workflow.signOff(tx, { ...x, ...b })); }
  @Post('year-end-workflow/reopen') @HttpCode(200) @RequirePermissions('accounts:prepare') @Idempotent()
  reopen(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(reopenYearEndStepSchema)) b: In<typeof reopenYearEndStepSchema>) { return this.api.run(org, c, (tx, x) => this.workflow.reopen(tx, { ...x, ...b })); }
}
