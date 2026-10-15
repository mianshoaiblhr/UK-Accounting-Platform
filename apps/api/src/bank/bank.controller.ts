import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { z as zod } from 'zod';
import {
  JobTypes, bankTransferListQuerySchema, closeBankAccountSchema, createBankAccountSchema, createBankTransferSchema, requestStatementImportSchema, reverseBankTransferSchema,
  statementImportListQuerySchema, statementLineListQuerySchema, updateBankAccountSchema, voidStatementImportSchema, type Permission,
} from '@uk/contracts';
import type { Database, Tx } from '@uk/db';
import type { JobProducer } from '@uk/jobs';
import { BankService, type BankActor } from '@uk/accounting';
import { BankStatementService } from '@uk/platform';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import { DB, JOBS } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { DocumentsService } from '../documents/documents.service';

const ID = (n: string) => Param(n, ParseUUIDPipe);
const accountListQuery = zod.object({ status: zod.enum(['ACTIVE', 'CLOSED']).optional() }).strict();

@Injectable()
export class BankApiService {
  constructor(@Inject(DB) private readonly db: Database, @Inject(JOBS) private readonly jobs: JobProducer, private readonly statements: BankStatementService, private readonly documents: DocumentsService) {}
  actor(org: OrgAccess): BankActor { return { kind: 'USER', userId: org.userId, can: (p, companyId) => org.access.can(p as Permission, { companyId }) }; }
  run<T>(org: OrgAccess, fn: (tx: Tx, a: BankActor) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, (tx) => fn(tx, this.actor(org))); }

  /** Records the request, then queues the job once the request is committed (ADR-61: the worker stages the lines; nothing is posted). */
  async requestImport(org: OrgAccess, companyId: string, bankAccountId: string, b: z.output<typeof requestStatementImportSchema>) {
    await this.documents.readableVersion(org, b.documentId, b.versionId);
    const imp = await this.run(org, (tx) => this.statements.request(tx, { organisationId: org.organisationId, companyId, userId: org.userId, bankAccountId, documentId: b.documentId, versionId: b.versionId,
      mapping: b.mapping, duplicateOverrideReason: b.duplicateOverrideReason }));
    const { record } = await this.jobs.enqueue(JobTypes.bankStatementImport, { importId: imp.id }, { organisationId: org.organisationId, userId: org.userId, companyId, idempotencyKey: `bank-import:${imp.id}` });
    return this.run(org, async (tx) => { await this.statements.attachJob(tx, imp.id, record.id); return this.statements.getImport(tx, companyId, imp.id); });
  }
}

/** Bank (M7a): bank accounts, CSV statement imports staged by the worker, statement lines, transfers between bank and cash accounts. */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('bookkeeping.core')
export class BankController {
  constructor(private readonly api: BankApiService, private readonly bank: BankService, private readonly statements: BankStatementService) {}

  @Post('bank-accounts') @RequirePermissions('bank:manage') @Idempotent()
  create(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createBankAccountSchema)) b: z.output<typeof createBankAccountSchema>) {
    return this.api.run(org, (tx, actor) => this.bank.create(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Get('bank-accounts') @RequirePermissions('bank:read')
  list(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(accountListQuery)) q: z.output<typeof accountListQuery>) { return this.api.run(org, (tx) => this.bank.list(tx, c, q)); }
  @Get('bank-accounts/:bankAccountId') @RequirePermissions('bank:read')
  get(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('bankAccountId') id: string) { return this.api.run(org, (tx) => this.bank.get(tx, c, id)); }
  @Patch('bank-accounts/:bankAccountId') @RequirePermissions('bank:manage')
  update(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('bankAccountId') id: string, @Body(new ZodPipe(updateBankAccountSchema)) b: z.output<typeof updateBankAccountSchema>) {
    return this.api.run(org, (tx, actor) => this.bank.update(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Post('bank-accounts/:bankAccountId/close') @HttpCode(200) @RequirePermissions('bank:manage')
  close(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('bankAccountId') id: string, @Body(new ZodPipe(closeBankAccountSchema)) b: z.output<typeof closeBankAccountSchema>) {
    return this.api.run(org, (tx, actor) => this.bank.close(tx, { organisationId: org.organisationId, companyId: c, actor, id, reason: b.reason }));
  }
  @Get('bank-accounts/:bankAccountId/details') @RequirePermissions('bank:manage')
  details(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('bankAccountId') id: string) { return this.api.run(org, (tx, actor) => this.bank.details(tx, { organisationId: org.organisationId, companyId: c, actor, id })); }

  @Post('bank-accounts/:bankAccountId/statement-imports') @HttpCode(202) @RequirePermissions('bank:manage') @Idempotent()
  requestImport(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('bankAccountId') id: string, @Body(new ZodPipe(requestStatementImportSchema)) b: z.output<typeof requestStatementImportSchema>) {
    return this.api.requestImport(org, c, id, b);
  }
  @Get('bank-accounts/:bankAccountId/statement-imports') @RequirePermissions('bank:read')
  imports(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('bankAccountId') id: string, @Query(new ZodPipe(statementImportListQuerySchema)) q: z.output<typeof statementImportListQuerySchema>) {
    return this.api.run(org, (tx) => this.statements.listImports(tx, c, id, q));
  }
  @Get('statement-imports/:importId') @RequirePermissions('bank:read')
  getImport(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('importId') id: string) { return this.api.run(org, (tx) => this.statements.getImport(tx, c, id)); }
  @Post('statement-imports/:importId/void') @HttpCode(200) @RequirePermissions('bank:manage')
  voidImport(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('importId') id: string, @Body(new ZodPipe(voidStatementImportSchema)) b: z.output<typeof voidStatementImportSchema>) {
    return this.api.run(org, (tx) => this.statements.void(tx, { organisationId: org.organisationId, companyId: c, userId: org.userId, importId: id, reason: b.reason }));
  }
  @Get('bank-accounts/:bankAccountId/statement-lines') @RequirePermissions('bank:read')
  lines(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('bankAccountId') id: string, @Query(new ZodPipe(statementLineListQuerySchema)) q: z.output<typeof statementLineListQuerySchema>) {
    return this.api.run(org, (tx) => this.statements.listLines(tx, c, id, q));
  }

  @Post('bank-transfers') @RequirePermissions('bank:transfer') @Idempotent()
  transfer(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createBankTransferSchema)) b: z.output<typeof createBankTransferSchema>) {
    return this.api.run(org, (tx, actor) => this.bank.transfer(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Get('bank-transfers') @RequirePermissions('bank:read')
  transfers(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(bankTransferListQuerySchema)) q: z.output<typeof bankTransferListQuerySchema>) { return this.api.run(org, (tx) => this.bank.listTransfers(tx, c, q)); }
  @Get('bank-transfers/:transferId') @RequirePermissions('bank:read')
  getTransfer(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('transferId') id: string) { return this.api.run(org, (tx) => this.bank.getTransfer(tx, c, id)); }
  @Post('bank-transfers/:transferId/reverse') @HttpCode(200) @RequirePermissions('bank:transfer') @Idempotent()
  reverseTransfer(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('transferId') id: string, @Body(new ZodPipe(reverseBankTransferSchema)) b: z.output<typeof reverseBankTransferSchema>) {
    return this.api.run(org, (tx, actor) => this.bank.reverseTransfer(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
}
