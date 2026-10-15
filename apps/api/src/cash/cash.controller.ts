import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { z } from 'zod';
import { attachCashTransactionSchema, cashTransactionListQuerySchema, createCashTransactionSchema, reverseCashTransactionSchema, type Permission } from '@uk/contracts';
import { notFound } from '@uk/core';
import type { Database, Tx } from '@uk/db';
import { CashService, type CashActor } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { EvidenceService } from '../evidence/evidence.service';

const ID = (n: string) => Param(n, ParseUUIDPipe);

@Injectable()
export class CashApiService {
  constructor(@Inject(DB) private readonly db: Database, private readonly cash: CashService, private readonly evidence: EvidenceService) {}
  actor(org: OrgAccess): CashActor { return { kind: 'USER', userId: org.userId, can: (p, companyId) => org.access.can(p as Permission, { companyId }) }; }
  run<T>(org: OrgAccess, fn: (tx: Tx, a: CashActor) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, (tx) => fn(tx, this.actor(org))); }
  async attach(org: OrgAccess, companyId: string, id: string, b: z.output<typeof attachCashTransactionSchema>) {
    await this.run(org, (tx) => this.cash.get(tx, companyId, id));
    return this.evidence.create(org, { sourceType: 'document', sourceId: b.documentId, targetType: 'cash_transaction', targetId: id, kind: 'ATTACHED_TO', note: b.note });
  }
  async attachments(org: OrgAccess, companyId: string, id: string) {
    const exists = await this.run(org, (tx) => tx.cashTransaction.findFirst({ where: { id, companyId }, select: { id: true } }));
    if (!exists) throw notFound('Cash transaction not found');
    return this.evidence.list(org, { entityType: 'cash_transaction', entityId: id, direction: 'in', limit: 100 });
  }
}

/** Cash transactions (M6c): money in and out of a bank or cash account without a source document, with VAT per line; posted when recorded, corrected by a mirror reversal. */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('bookkeeping.core')
export class CashController {
  constructor(private readonly api: CashApiService, private readonly cash: CashService) {}

  @Post('cash-transactions') @RequirePermissions('cash:record') @Idempotent()
  record(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createCashTransactionSchema)) b: z.output<typeof createCashTransactionSchema>) {
    return this.api.run(org, (tx, actor) => this.cash.record(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Get('cash-transactions') @RequirePermissions('cash:read')
  list(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(cashTransactionListQuerySchema)) q: z.output<typeof cashTransactionListQuerySchema>) { return this.api.run(org, (tx) => this.cash.list(tx, c, q)); }
  @Get('cash-transactions/:transactionId') @RequirePermissions('cash:read')
  get(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('transactionId') id: string) { return this.api.run(org, (tx) => this.cash.get(tx, c, id)); }
  @Post('cash-transactions/:transactionId/reverse') @HttpCode(200) @RequirePermissions('cash:record') @Idempotent()
  reverse(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('transactionId') id: string, @Body(new ZodPipe(reverseCashTransactionSchema)) b: z.output<typeof reverseCashTransactionSchema>) {
    return this.api.run(org, (tx, actor) => this.cash.reverse(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Get('cash-transactions/:transactionId/attachments') @RequirePermissions('cash:read')
  attachments(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('transactionId') id: string) { return this.api.attachments(org, c, id); }
  @Post('cash-transactions/:transactionId/attachments') @RequirePermissions('cash:record') @Idempotent()
  attach(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('transactionId') id: string, @Body(new ZodPipe(attachCashTransactionSchema)) b: z.output<typeof attachCashTransactionSchema>) { return this.api.attach(org, c, id, b); }
}
