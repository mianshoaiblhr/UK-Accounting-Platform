import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { explainReviewFlagSchema, reopenReviewFlagSchema, reviewChecklistQuerySchema, setReviewSettingsSchema, signOffReviewFlagSchema } from '@uk/contracts';
import { ReviewService } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { YearEndApiService } from './year-end.controller';

const ID = (n: string) => Param(n, ParseUUIDPipe);
type In<S extends z.ZodTypeAny> = z.output<S>;

/**
 * V2-M6a (DEC-068): the review checklist of a framework year (ledger:read), the firm's review settings (accounts:prepare), and the responses to
 * flags: explained by a preparer (accounts:prepare), signed off or reopened by a second person (accounts:review). Behind `accounts.production`.
 */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('accounts.production')
export class ReviewController {
  constructor(private readonly api: YearEndApiService, private readonly review: ReviewService) {}

  @Get('review-settings') @RequirePermissions('ledger:read')
  settings(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, c, (tx) => this.review.settings(tx, c)); }
  @Post('review-settings') @RequirePermissions('accounts:prepare') @Idempotent()
  setSettings(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(setReviewSettingsSchema)) b: In<typeof setReviewSettingsSchema>) { return this.api.run(org, c, (tx, x) => this.review.setSettings(tx, { ...x, ...b })); }
  @Get('review-checklist') @RequirePermissions('ledger:read')
  checklist(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(reviewChecklistQuerySchema)) q: In<typeof reviewChecklistQuerySchema>) { return this.api.run(org, c, (tx) => this.review.checklist(tx, c, q)); }
  @Post('review-flags/explain') @HttpCode(200) @RequirePermissions('accounts:prepare') @Idempotent()
  explain(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(explainReviewFlagSchema)) b: In<typeof explainReviewFlagSchema>) { return this.api.run(org, c, (tx, x) => this.review.explain(tx, { ...x, ...b })); }
  @Post('review-flags/sign-off') @HttpCode(200) @RequirePermissions('accounts:review') @Idempotent()
  signOff(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(signOffReviewFlagSchema)) b: In<typeof signOffReviewFlagSchema>) { return this.api.run(org, c, (tx, x) => this.review.signOff(tx, { ...x, ...b })); }
  @Post('review-flags/reopen') @HttpCode(200) @RequirePermissions('accounts:review') @Idempotent()
  reopen(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(reopenReviewFlagSchema)) b: In<typeof reopenReviewFlagSchema>) { return this.api.run(org, c, (tx, x) => this.review.reopen(tx, { ...x, ...b })); }
}
