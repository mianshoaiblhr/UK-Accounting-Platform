import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { Permission, PeriodAction, RequestKind, accountListQuerySchema, createJournalRequestSchema, requestListQuerySchema, setLedgerPolicySchema, createAccountSchema, journalListQuerySchema, ledgerQuerySchema, postJournalSchema, trialBalanceQuerySchema, updateAccountSchema } from '@uk/contracts';
import { notFound, uuidv7 } from '@uk/core';
import type { Database, Tx } from '@uk/db';
import { AccountService, JournalRequestService, LedgerPolicyService, LedgerQueries, PeriodService, PostingService, periodView, type PostingActor, type RequestActor } from '@uk/accounting';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';

/**
 * API facade for the V1 ledger. It only translates the authenticated request into the domain services' inputs (the actor comes from the
 * session, never from the body) and wraps each call in the tenant transaction. All accounting rules live in @uk/accounting.
 */
@Injectable()
export class LedgerApiService {
  constructor(@Inject(DB) private readonly db: Database, private readonly accounts: AccountService, private readonly posting: PostingService,
    private readonly periods: PeriodService, private readonly queries: LedgerQueries, private readonly requests: JournalRequestService, private readonly policies: LedgerPolicyService) {}

  private t<T>(org: OrgAccess, fn: (tx: Tx) => Promise<T>) { return this.db.tenant({ organisationId: org.organisationId, userId: org.userId }, fn); }
  private actor(org: OrgAccess): PostingActor {
    return { kind: 'USER', userId: org.userId, can: (permission, companyId) => org.access.can(permission as Permission, { companyId }) };
  }

  // Accounts
  createAccount(org: OrgAccess, companyId: string, input: z.output<typeof createAccountSchema>) {
    return this.t(org, (tx) => this.accounts.create(tx, { organisationId: org.organisationId, companyId, userId: org.userId, input }));
  }
  initialiseChart(org: OrgAccess, companyId: string) { return this.t(org, (tx) => this.accounts.initialiseDefault(tx, { organisationId: org.organisationId, companyId, userId: org.userId })); }
  listAccounts(org: OrgAccess, companyId: string, q: z.output<typeof accountListQuerySchema>) { return this.t(org, (tx) => this.accounts.list(tx, companyId, q)); }
  getAccount(org: OrgAccess, companyId: string, id: string) { return this.t(org, (tx) => this.accounts.get(tx, companyId, id)); }
  updateAccount(org: OrgAccess, companyId: string, id: string, input: z.output<typeof updateAccountSchema>) {
    return this.t(org, (tx) => this.accounts.update(tx, { organisationId: org.organisationId, companyId, userId: org.userId, id, input }));
  }

  // Journals
  async postJournal(org: OrgAccess, companyId: string, b: z.output<typeof postJournalSchema>) {
    const j = await this.t(org, (tx) => this.posting.post(tx, {
      organisationId: org.organisationId, companyId, journalDate: b.journalDate, sourceType: b.source, sourceReference: b.reference ?? null, description: b.description, currency: b.currency,
      lines: b.lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description })),
      idempotencyKey: b.idempotencyKey ?? `api:${uuidv7()}`, actor: this.actor(org),
    }));
    return this.t(org, (tx) => this.queries.getJournal(tx, companyId, j.id)).then((view) => ({ ...view, replayed: j.replayed }));
  }
  async reverseJournal(org: OrgAccess, companyId: string, id: string, b: { journalDate?: string; reason: string }) {
    const j = await this.t(org, (tx) => this.posting.reverse(tx, { organisationId: org.organisationId, companyId, journalId: id, journalDate: b.journalDate, reason: b.reason, actor: this.actor(org) }));
    return this.t(org, (tx) => this.queries.getJournal(tx, companyId, j.id));
  }
  listJournals(org: OrgAccess, companyId: string, q: z.output<typeof journalListQuerySchema>) { return this.t(org, (tx) => this.queries.listJournals(tx, companyId, q)); }
  getJournal(org: OrgAccess, companyId: string, id: string) { return this.t(org, (tx) => this.queries.getJournal(tx, companyId, id)); }

  // Journal requests (opening balances, control-account adjustments) and the approval policy
  private reqActor(org: OrgAccess): RequestActor {
    return { ...this.actor(org), userId: org.userId, canReadDocument: (d) => org.access.canReadDocument({ ...d, createdByUserId: d.createdByUserId ?? '' }) };
  }
  createRequest(org: OrgAccess, companyId: string, kind: RequestKind, b: z.output<typeof createJournalRequestSchema>) {
    return this.t(org, (tx) => this.requests.create(tx, { organisationId: org.organisationId, companyId, kind, actor: this.reqActor(org), ...b }));
  }
  listRequests(org: OrgAccess, companyId: string, q: z.output<typeof requestListQuerySchema>) { return this.t(org, (tx) => this.requests.list(tx, companyId, q)); }
  getRequest(org: OrgAccess, companyId: string, id: string) { return this.t(org, (tx) => this.requests.get(tx, companyId, id)); }
  approveRequest(org: OrgAccess, companyId: string, id: string, comment?: string) { return this.t(org, (tx) => this.requests.approve(tx, { organisationId: org.organisationId, companyId, requestId: id, actor: this.reqActor(org), comment })); }
  rejectRequest(org: OrgAccess, companyId: string, id: string, reason: string) { return this.t(org, (tx) => this.requests.reject(tx, { organisationId: org.organisationId, companyId, requestId: id, actor: this.reqActor(org), reason })); }
  cancelRequest(org: OrgAccess, companyId: string, id: string, reason?: string) { return this.t(org, (tx) => this.requests.cancel(tx, { organisationId: org.organisationId, companyId, requestId: id, actor: this.reqActor(org), reason })); }
  getPolicy(org: OrgAccess, companyId: string) { return this.t(org, (tx) => this.policies.get(tx, companyId)); }
  setPolicy(org: OrgAccess, companyId: string, b: z.output<typeof setLedgerPolicySchema>) {
    return this.t(org, (tx) => this.policies.set(tx, { organisationId: org.organisationId, companyId, actor: this.reqActor(org), ...b }));
  }

  // Reads
  generalLedger(org: OrgAccess, companyId: string, q: z.output<typeof ledgerQuerySchema>) { return this.t(org, (tx) => this.queries.generalLedger(tx, companyId, q)); }
  trialBalance(org: OrgAccess, companyId: string, q: z.output<typeof trialBalanceQuerySchema>) { return this.t(org, (tx) => this.queries.trialBalance(tx, companyId, q)); }

  // Periods
  transitionPeriod(org: OrgAccess, companyId: string, periodId: string, action: PeriodAction, reason?: string) {
    return this.t(org, (tx) => this.periods.transition(tx, { organisationId: org.organisationId, companyId, periodId, action, reason, userId: org.userId, can: (p) => org.access.can(p as Permission, { companyId }) }));
  }
  async getPeriod(org: OrgAccess, companyId: string, periodId: string) {
    const p = await this.t(org, (tx) => tx.accountingPeriod.findFirst({ where: { id: periodId, companyId } }));
    if (!p) throw notFound('Accounting period not found');
    return periodView(p);
  }
}
