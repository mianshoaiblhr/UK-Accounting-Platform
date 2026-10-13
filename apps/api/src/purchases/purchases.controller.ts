import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import type { z } from 'zod';
import {
  agedPayablesQuerySchema, allocatePaymentSchema, approvePurchaseDocumentSchema, attachPurchaseDocumentSchema, createPaymentSchema, paymentListQuerySchema, reversePaymentSchema, supplierStatementQuerySchema, createBillSchema, createDebitNoteSchema, discardPurchaseDocumentSchema, purchaseDocumentListQuerySchema, purchaseSettingsSchema, updatePurchaseDraftSchema,
  type Permission,
} from '@uk/contracts';
import { notFound } from '@uk/core';
import type { Database, Tx } from '@uk/db';
import { PurchasesService, type PurchaseActor } from '@uk/accounting';
import { Idempotent, Org, RequireFeature, RequirePermissions } from '../common/decorators';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';
import { ZodPipe } from '../common/zod.pipe';
import { EvidenceService } from '../evidence/evidence.service';

const ID = (n: string) => Param(n, ParseUUIDPipe);

@Injectable()
export class PurchasesApiService {
  constructor(@Inject(DB) private readonly db: Database, private readonly purchases: PurchasesService, private readonly evidence: EvidenceService) {}
  actor(org: OrgAccess): PurchaseActor { return { kind: 'USER', userId: org.userId, can: (p, companyId) => org.access.can(p as Permission, { companyId }) }; }
  run<T>(org: OrgAccess, fn: (tx: Tx, a: PurchaseActor) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, (tx) => fn(tx, this.actor(org))); }
  async attach(org: OrgAccess, companyId: string, id: string, b: z.output<typeof attachPurchaseDocumentSchema>) {
    await this.run(org, (tx) => this.purchases.get(tx, companyId, id));
    return this.evidence.create(org, { sourceType: 'document', sourceId: b.documentId, targetType: 'purchase_document', targetId: id, kind: 'ATTACHED_TO', note: b.note });
  }
  async attachments(org: OrgAccess, companyId: string, id: string) {
    const exists = await this.run(org, (tx) => tx.purchaseDocument.findFirst({ where: { id, companyId }, select: { id: true } }));
    if (!exists) throw notFound('Purchase document not found');
    return this.evidence.list(org, { entityType: 'purchase_document', entityId: id, direction: 'in', limit: 100 });
  }
}

/** Purchase documents (M6a): supplier bills and debit notes - drafts, approval (internally numbered, posted, immutable), debit-note allocation, payables reconciliation. */
@Controller('organisations/:organisationId/companies/:companyId')
@RequireFeature('bookkeeping.core')
export class PurchasesController {
  constructor(private readonly api: PurchasesApiService, private readonly purchases: PurchasesService) {}

  @Get('purchase-settings') @RequirePermissions('purchases:read')
  settings(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, (tx) => this.purchases.getSettings(tx, c)); }
  @Put('purchase-settings') @RequirePermissions('ledger:policy')
  setSettings(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(purchaseSettingsSchema)) b: z.output<typeof purchaseSettingsSchema>) {
    return this.api.run(org, (tx, actor) => this.purchases.setSettings(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Post('purchases/bills') @RequirePermissions('purchases:manage') @Idempotent()
  createBill(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createBillSchema)) b: z.output<typeof createBillSchema>) {
    return this.api.run(org, (tx, actor) => this.purchases.createBill(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Get('purchases/bills') @RequirePermissions('purchases:read')
  bills(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(purchaseDocumentListQuerySchema)) q: z.output<typeof purchaseDocumentListQuerySchema>) {
    return this.api.run(org, (tx) => this.purchases.list(tx, c, { ...q, kind: 'BILL' }));
  }
  @Post('purchases/debit-notes') @RequirePermissions('purchases:manage') @Idempotent()
  createDebitNote(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createDebitNoteSchema)) b: z.output<typeof createDebitNoteSchema>) {
    return this.api.run(org, (tx, actor) => this.purchases.createDebitNote(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Get('purchases/debit-notes') @RequirePermissions('purchases:read')
  debitNotes(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(purchaseDocumentListQuerySchema)) q: z.output<typeof purchaseDocumentListQuerySchema>) {
    return this.api.run(org, (tx) => this.purchases.list(tx, c, { ...q, kind: 'DEBIT_NOTE' }));
  }
  @Get('purchases/documents') @RequirePermissions('purchases:read')
  documents(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(purchaseDocumentListQuerySchema)) q: z.output<typeof purchaseDocumentListQuerySchema>) {
    return this.api.run(org, (tx) => this.purchases.list(tx, c, q));
  }
  @Get('purchases/documents/:documentId') @RequirePermissions('purchases:read')
  get(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('documentId') id: string) { return this.api.run(org, (tx) => this.purchases.get(tx, c, id)); }
  @Patch('purchases/documents/:documentId') @RequirePermissions('purchases:manage')
  update(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('documentId') id: string, @Body(new ZodPipe(updatePurchaseDraftSchema)) b: z.output<typeof updatePurchaseDraftSchema>) {
    return this.api.run(org, (tx, actor) => this.purchases.updateDraft(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Post('purchases/documents/:documentId/approve') @HttpCode(200) @RequirePermissions('purchases:approve') @Idempotent()
  approve(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('documentId') id: string, @Body(new ZodPipe(approvePurchaseDocumentSchema)) b: z.output<typeof approvePurchaseDocumentSchema>) {
    return this.api.run(org, (tx, actor) => this.purchases.approve(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Post('purchases/documents/:documentId/discard') @HttpCode(200) @RequirePermissions('purchases:manage')
  discard(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('documentId') id: string, @Body(new ZodPipe(discardPurchaseDocumentSchema)) b: z.output<typeof discardPurchaseDocumentSchema>) {
    return this.api.run(org, (tx, actor) => this.purchases.discard(tx, { organisationId: org.organisationId, companyId: c, actor, id, reason: b.reason }));
  }
  @Get('purchases/documents/:documentId/attachments') @RequirePermissions('purchases:read')
  attachments(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('documentId') id: string) { return this.api.attachments(org, c, id); }
  @Post('purchases/documents/:documentId/attachments') @RequirePermissions('purchases:manage') @Idempotent()
  attach(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('documentId') id: string, @Body(new ZodPipe(attachPurchaseDocumentSchema)) b: z.output<typeof attachPurchaseDocumentSchema>) { return this.api.attach(org, c, id, b); }
  // ───── Supplier payments (M6b) ─────
  @Post('purchases/payments') @RequirePermissions('purchases:approve') @Idempotent()
  recordPayment(@Org() org: OrgAccess, @ID('companyId') c: string, @Body(new ZodPipe(createPaymentSchema)) b: z.output<typeof createPaymentSchema>) {
    return this.api.run(org, (tx, actor) => this.purchases.recordPayment(tx, { organisationId: org.organisationId, companyId: c, actor, ...b }));
  }
  @Get('purchases/payments') @RequirePermissions('purchases:read')
  payments(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(paymentListQuerySchema)) q: z.output<typeof paymentListQuerySchema>) { return this.api.run(org, (tx) => this.purchases.listPayments(tx, c, q)); }
  @Get('purchases/payments/:paymentId') @RequirePermissions('purchases:read')
  payment(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('paymentId') id: string) { return this.api.run(org, (tx) => this.purchases.getPayment(tx, c, id)); }
  @Post('purchases/payments/:paymentId/allocations') @HttpCode(200) @RequirePermissions('purchases:approve') @Idempotent()
  allocatePayment(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('paymentId') id: string, @Body(new ZodPipe(allocatePaymentSchema)) b: z.output<typeof allocatePaymentSchema>) {
    return this.api.run(org, (tx, actor) => this.purchases.allocatePayment(tx, { organisationId: org.organisationId, companyId: c, actor, paymentId: id, ...b }));
  }
  @Post('purchases/payments/:paymentId/reverse') @HttpCode(200) @RequirePermissions('purchases:approve') @Idempotent()
  reversePayment(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('paymentId') id: string, @Body(new ZodPipe(reversePaymentSchema)) b: z.output<typeof reversePaymentSchema>) {
    return this.api.run(org, (tx, actor) => this.purchases.reversePayment(tx, { organisationId: org.organisationId, companyId: c, actor, id, ...b }));
  }
  @Get('purchases/suppliers/:roleId/statement') @RequirePermissions('purchases:read')
  statement(@Org() org: OrgAccess, @ID('companyId') c: string, @ID('roleId') id: string, @Query(new ZodPipe(supplierStatementQuerySchema)) q: z.output<typeof supplierStatementQuerySchema>) {
    return this.api.run(org, (tx) => this.purchases.statement(tx, c, id, q));
  }
  @Get('purchases/aged-payables') @RequirePermissions('purchases:read')
  aged(@Org() org: OrgAccess, @ID('companyId') c: string, @Query(new ZodPipe(agedPayablesQuerySchema)) q: z.output<typeof agedPayablesQuerySchema>) { return this.api.run(org, (tx) => this.purchases.agedPayables(tx, c, q)); }

  @Get('purchases/reconciliation') @RequirePermissions('purchases:read')
  reconciliation(@Org() org: OrgAccess, @ID('companyId') c: string) { return this.api.run(org, (tx) => this.purchases.reconciliation(tx, c)); }
}
