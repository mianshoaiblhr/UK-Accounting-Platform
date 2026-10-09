import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { accountListQuerySchema, createAccountSchema, journalListQuerySchema, ledgerQuerySchema, periodTransitionSchema, postJournalSchema, reverseJournalSchema, trialBalanceQuerySchema, updateAccountSchema, type PeriodAction } from '@uk/contracts';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { LedgerApiService } from './ledger.service';

const ID = (n: string) => Param(n, ParseUUIDPipe);

/**
 * V1 ledger API (flag `bookkeeping.core`). The route permission is checked for exactly the company in the path by the organisation guard;
 * the accounting rules (period, accounts, balance, control accounts, ...) are enforced by the PostingService, not here.
 */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('bookkeeping.core')
export class LedgerController {
  constructor(private readonly svc: LedgerApiService) {}

  // ───── Chart of accounts ─────
  @Get('accounts') @RequirePermissions('account:read')
  listAccounts(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(accountListQuerySchema)) q: z.output<typeof accountListQuerySchema>) { return this.svc.listAccounts(org, c, q); }
  @Post('accounts') @RequirePermissions('account:manage') @Idempotent()
  createAccount(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createAccountSchema)) b: z.output<typeof createAccountSchema>) { return this.svc.createAccount(org, c, b); }
  @Post('accounts/initialise') @HttpCode(201) @RequirePermissions('account:manage')
  initialise(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.svc.initialiseChart(org, c); }
  @Get('accounts/:accountId') @RequirePermissions('account:read')
  getAccount(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('accountId') id: string) { return this.svc.getAccount(org, c, id); }
  @Patch('accounts/:accountId') @RequirePermissions('account:manage')
  updateAccount(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('accountId') id: string, @Body(new ZodPipe(updateAccountSchema)) b: z.output<typeof updateAccountSchema>) { return this.svc.updateAccount(org, c, id, b); }

  // ───── Journals (posted only through the PostingService) ─────
  @Post('journals') @RequirePermissions('journal:post') @Idempotent()
  post(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(postJournalSchema)) b: z.output<typeof postJournalSchema>) { return this.svc.postJournal(org, c, b); }
  @Get('journals') @RequirePermissions('ledger:read')
  listJournals(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(journalListQuerySchema)) q: z.output<typeof journalListQuerySchema>) { return this.svc.listJournals(org, c, q); }
  @Get('journals/:journalId') @RequirePermissions('ledger:read')
  getJournal(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('journalId') id: string) { return this.svc.getJournal(org, c, id); }
  @Post('journals/:journalId/reverse') @RequirePermissions('journal:post') @Idempotent()
  reverse(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('journalId') id: string, @Body(new ZodPipe(reverseJournalSchema)) b: z.output<typeof reverseJournalSchema>) { return this.svc.reverseJournal(org, c, id, b); }

  // ───── General ledger and reports (read the ledger only) ─────
  @Get('ledger') @RequirePermissions('ledger:read')
  generalLedger(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(ledgerQuerySchema)) q: z.output<typeof ledgerQuerySchema>) { return this.svc.generalLedger(org, c, q); }
  @Get('reports/trial-balance') @RequirePermissions('ledger:read')
  trialBalance(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(trialBalanceQuerySchema)) q: z.output<typeof trialBalanceQuerySchema>) { return this.svc.trialBalance(org, c, q); }

  // ───── Period states (close / reopen need period:manage, lock / unlock need period:lock - checked again in the service) ─────
  private transition(org: OrgAccess, c: string, id: string, action: PeriodAction, b: z.output<typeof periodTransitionSchema>) { return this.svc.transitionPeriod(org, c, id, action, b.reason); }
  @Post('periods/:periodId/close') @HttpCode(200) @RequirePermissions('period:manage')
  close(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') id: string, @Body(new ZodPipe(periodTransitionSchema)) b: z.output<typeof periodTransitionSchema>) { return this.transition(org, c, id, 'close', b); }
  @Post('periods/:periodId/reopen') @HttpCode(200) @RequirePermissions('period:manage')
  reopen(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') id: string, @Body(new ZodPipe(periodTransitionSchema)) b: z.output<typeof periodTransitionSchema>) { return this.transition(org, c, id, 'reopen', b); }
  @Post('periods/:periodId/lock') @HttpCode(200) @RequirePermissions('period:lock')
  lock(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') id: string, @Body(new ZodPipe(periodTransitionSchema)) b: z.output<typeof periodTransitionSchema>) { return this.transition(org, c, id, 'lock', b); }
  @Post('periods/:periodId/unlock') @HttpCode(200) @RequirePermissions('period:lock')
  unlock(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('periodId') id: string, @Body(new ZodPipe(periodTransitionSchema)) b: z.output<typeof periodTransitionSchema>) { return this.transition(org, c, id, 'unlock', b); }
}
