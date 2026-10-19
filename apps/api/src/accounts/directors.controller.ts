import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import type { z } from 'zod';
import {
  closeLoanAccountSchema, createLoanAccountSchema, createRelatedPartySchema, endRelatedPartySchema, loanAccountListQuerySchema, loanReportQuerySchema, loanStatementQuerySchema,
  relatedPartyListQuerySchema, relatedPartyReportQuerySchema, setLoanThresholdsSchema,
} from '@uk/contracts';
import { DirectorService } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { YearEndApiService } from './year-end.controller';

const ID = (n: string) => Param(n, ParseUUIDPipe);
type In<S extends z.ZodTypeAny> = z.output<S>;

/** V2-M4 (DEC-062): director and shareholder loan accounts, review thresholds, related parties. Registers over the ledger; behind `accounts.production`. */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('accounts.production')
export class DirectorsController {
  constructor(private readonly api: YearEndApiService, private readonly d: DirectorService) {}

  @Get('director-loan-accounts') @RequirePermissions('ledger:read')
  list(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(loanAccountListQuerySchema)) q: In<typeof loanAccountListQuerySchema>) { return this.api.run(org, c, (tx) => this.d.listLoanAccounts(tx, c, q)); }
  @Post('director-loan-accounts') @RequirePermissions('accounts:prepare') @Idempotent()
  create(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createLoanAccountSchema)) b: In<typeof createLoanAccountSchema>) { return this.api.run(org, c, (tx, x) => this.d.createLoanAccount(tx, { ...x, ...b })); }
  @Get('director-loan-accounts/report') @RequirePermissions('ledger:read')
  report(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(loanReportQuerySchema)) q: In<typeof loanReportQuerySchema>) { return this.api.run(org, c, (tx) => this.d.loanReport(tx, c, q)); }
  @Get('director-loan-accounts/:loanAccountId') @RequirePermissions('ledger:read')
  get(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('loanAccountId') id: string) { return this.api.run(org, c, (tx) => this.d.getLoanAccount(tx, c, id)); }
  @Get('director-loan-accounts/:loanAccountId/statement') @RequirePermissions('ledger:read')
  statement(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('loanAccountId') id: string, @Query(new ZodPipe(loanStatementQuerySchema)) q: In<typeof loanStatementQuerySchema>) { return this.api.run(org, c, (tx) => this.d.loanStatement(tx, c, id, q)); }
  @Post('director-loan-accounts/:loanAccountId/close') @HttpCode(200) @RequirePermissions('accounts:prepare') @Idempotent()
  close(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('loanAccountId') id: string, @Body(new ZodPipe(closeLoanAccountSchema)) b: In<typeof closeLoanAccountSchema>) { return this.api.run(org, c, (tx, x) => this.d.closeLoanAccount(tx, { ...x, id, ...b })); }

  @Get('director-loan-thresholds') @RequirePermissions('ledger:read')
  thresholds(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, c, (tx) => this.d.getThresholds(tx, c)); }
  @Put('director-loan-thresholds') @RequirePermissions('accounts:prepare') @Idempotent()
  setThresholds(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(setLoanThresholdsSchema)) b: In<typeof setLoanThresholdsSchema>) { return this.api.run(org, c, (tx, x) => this.d.setThresholds(tx, { ...x, ...b })); }

  @Get('related-parties') @RequirePermissions('ledger:read')
  parties(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(relatedPartyListQuerySchema)) q: In<typeof relatedPartyListQuerySchema>) { return this.api.run(org, c, (tx) => this.d.listRelatedParties(tx, c, q)); }
  @Post('related-parties') @RequirePermissions('accounts:prepare') @Idempotent()
  createParty(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createRelatedPartySchema)) b: In<typeof createRelatedPartySchema>) { return this.api.run(org, c, (tx, x) => this.d.createRelatedParty(tx, { ...x, ...b })); }
  @Get('related-parties/report') @RequirePermissions('ledger:read')
  partyReport(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(relatedPartyReportQuerySchema)) q: In<typeof relatedPartyReportQuerySchema>) { return this.api.run(org, c, (tx) => this.d.relatedPartyReport(tx, c, q)); }
  @Get('related-parties/:relatedPartyId') @RequirePermissions('ledger:read')
  party(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('relatedPartyId') id: string) { return this.api.run(org, c, (tx) => this.d.getRelatedParty(tx, c, id)); }
  @Post('related-parties/:relatedPartyId/end') @HttpCode(200) @RequirePermissions('accounts:prepare') @Idempotent()
  endParty(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('relatedPartyId') id: string, @Body(new ZodPipe(endRelatedPartySchema)) b: In<typeof endRelatedPartySchema>) { return this.api.run(org, c, (tx, x) => this.d.endRelatedParty(tx, { ...x, id, ...b })); }
}
