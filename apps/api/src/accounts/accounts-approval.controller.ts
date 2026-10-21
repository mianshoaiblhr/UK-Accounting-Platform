import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { accountsApprovalQuerySchema, clientApprovalSchema, generatePackageSchema, partnerReviewSchema } from '@uk/contracts';
import { AccountsApprovalService } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { YearEndApiService } from './year-end.controller';

const ID = (n: string) => Param(n, ParseUUIDPipe);
type In<S extends z.ZodTypeAny> = z.output<S>;

/**
 * V2-M6c (DEC-070): partner review (accounts:review), client approval (accounts:review and period:lock; it locks the year) and the filing-ready
 * package (accounts:prepare); reads need ledger:read. Behind `accounts.production`.
 */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('accounts.production')
export class AccountsApprovalController {
  constructor(private readonly api: YearEndApiService, private readonly approvals: AccountsApprovalService) {}

  @Get('accounts-approval') @RequirePermissions('ledger:read')
  get(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(accountsApprovalQuerySchema)) q: In<typeof accountsApprovalQuerySchema>) { return this.api.run(org, c, (tx) => this.approvals.status(tx, c, q)); }
  @Post('accounts-approval/partner-review') @HttpCode(200) @RequirePermissions('accounts:review') @Idempotent()
  review(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(partnerReviewSchema)) b: In<typeof partnerReviewSchema>) { return this.api.run(org, c, (tx, x) => this.approvals.partnerReview(tx, { ...x, ...b })); }
  @Post('accounts-approval/client-approval') @HttpCode(200) @RequirePermissions('accounts:review', 'period:lock') @Idempotent()
  approve(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(clientApprovalSchema)) b: In<typeof clientApprovalSchema>) { return this.api.run(org, c, (tx, x) => this.approvals.clientApproval(tx, { ...x, ...b })); }
  @Get('accounts-package') @RequirePermissions('ledger:read')
  package(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(accountsApprovalQuerySchema)) q: In<typeof accountsApprovalQuerySchema>) { return this.api.run(org, c, (tx) => this.approvals.package(tx, c, q)); }
  @Post('accounts-package') @RequirePermissions('accounts:prepare') @Idempotent()
  generate(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(generatePackageSchema)) b: In<typeof generatePackageSchema>) { return this.api.run(org, c, (tx, x) => this.approvals.generatePackage(tx, { ...x, ...b })); }
}
