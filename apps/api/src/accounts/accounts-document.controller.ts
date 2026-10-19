import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { accountsDocumentQuerySchema, accountsFactQuerySchema, setAccountsFactSchema } from '@uk/contracts';
import { AccountsDocumentService } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { YearEndApiService } from './year-end.controller';

const ID = (n: string) => Param(n, ParseUUIDPipe);
type In<S extends z.ZodTypeAny> = z.output<S>;

/** V2-M5a (DEC-063): the accounts document of a framework year and the preparer's facts. Behind `accounts.production`. */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('accounts.production')
export class AccountsDocumentController {
  constructor(private readonly api: YearEndApiService, private readonly doc: AccountsDocumentService) {}

  @Get('accounts-document') @RequirePermissions('ledger:read')
  document(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(accountsDocumentQuerySchema)) q: In<typeof accountsDocumentQuerySchema>) { return this.api.run(org, c, (tx) => this.doc.document(tx, c, q)); }
  @Get('accounts-facts') @RequirePermissions('ledger:read')
  facts(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(accountsFactQuerySchema)) q: In<typeof accountsFactQuerySchema>) { return this.api.run(org, c, (tx) => this.doc.facts(tx, c, q.yearStart)); }
  @Post('accounts-facts') @RequirePermissions('accounts:prepare') @Idempotent()
  setFact(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(setAccountsFactSchema)) b: In<typeof setAccountsFactSchema>) { return this.api.run(org, c, (tx, x) => this.doc.setFact(tx, { ...x, ...b })); }
}
