import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { Permission, PeriodAction, RequestKind, createExchangeRateSchema, fxSettingsSchema, importExchangeRatesSchema, rateListQuerySchema, revaluationRunListQuerySchema, revaluationSchema, supersedeExchangeRateSchema, verifyExchangeRateSchema, accountListQuerySchema, createJournalRequestSchema, requestListQuerySchema, setLedgerPolicySchema, createAccountSchema, journalListQuerySchema, ledgerQuerySchema, postJournalSchema, trialBalanceQuerySchema, updateAccountSchema } from '@uk/contracts';
import { forbidden, notFound, uuidv7 } from '@uk/core';
import type { Database, Tx } from '@uk/db';
import { AccountService, FxSettingsService, JournalRequestService, LedgerPolicyService, LedgerQueries, PeriodService, PostingService, RateService, RevaluationService, periodView, type PostingActor, type RequestActor } from '@uk/accounting';
import { DB } from '../common/tokens';
import type { OrgAccess } from '../common/types';

/**
 * API facade for the V1 ledger. It only translates the authenticated request into the domain services' inputs (the actor comes from the
 * session, never from the body) and wraps each call in the tenant transaction. All accounting rules live in @uk/accounting.
 */
@Injectable()
export class LedgerApiService {
  constructor(@Inject(DB) private readonly db: Database, private readonly accounts: AccountService, private readonly posting: PostingService,
    private readonly periods: PeriodService, private readonly queries: LedgerQueries, private readonly requests: JournalRequestService, private readonly policies: LedgerPolicyService,
    private readonly rates: RateService, private readonly fxSettings: FxSettingsService, private readonly reval: RevaluationService) {}

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
      organisationId: org.organisationId, companyId, journalDate: b.journalDate, sourceType: b.source, sourceReference: b.reference ?? null, description: b.description, currency: b.currency, rateId: b.rateId, manualRate: b.manualRate, amountsIncludeVat: b.amountsIncludeVat, taxPoint: b.taxPoint,
      lines: b.lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description, taxCodeId: l.taxCodeId })),
      idempotencyKey: b.idempotencyKey ?? `api:${uuidv7()}`, actor: this.actor(org),
    }));
    return this.t(org, (tx) => this.queries.getJournal(tx, companyId, j.id)).then((view) => ({ ...view, replayed: j.replayed }));
  }
  async reverseJournal(org: OrgAccess, companyId: string, id: string, b: { journalDate?: string; reason: string; negativeCashReason?: string }) {
    const j = await this.t(org, (tx) => this.posting.reverse(tx, { organisationId: org.organisationId, companyId, journalId: id, journalDate: b.journalDate, reason: b.reason, negativeCashReason: b.negativeCashReason, actor: this.actor(org) }));
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

  // Foreign currency (M3): exchange rates, FX settings, revaluation
  private rateActor(org: OrgAccess) { return { userId: org.userId, can: (permission: string, companyId: string) => org.access.can(permission as Permission, { companyId }) }; }
  listRates(org: OrgAccess, q: z.output<typeof rateListQuerySchema>) { return this.t(org, (tx) => this.rates.list(tx, q)); }
  getRate(org: OrgAccess, id: string) { return this.t(org, (tx) => this.rates.get(tx, id)); }
  createRate(org: OrgAccess, companyId: string, b: z.output<typeof createExchangeRateSchema>) {
    return this.t(org, (tx) => this.rates.create(tx, { organisationId: org.organisationId, companyId, actor: this.rateActor(org), ...b }));
  }
  supersedeRate(org: OrgAccess, companyId: string, id: string, b: z.output<typeof supersedeExchangeRateSchema>) {
    return this.t(org, (tx) => this.rates.supersede(tx, { organisationId: org.organisationId, companyId, actor: this.rateActor(org), id, ...b }));
  }
  verifyRate(org: OrgAccess, companyId: string, id: string, b: z.output<typeof verifyExchangeRateSchema>) {
    return this.t(org, (tx) => this.rates.verify(tx, { organisationId: org.organisationId, companyId, actor: this.rateActor(org), id, note: b.note }));
  }
  importRates(org: OrgAccess, companyId: string, b: z.output<typeof importExchangeRatesSchema>) {
    return this.t(org, (tx) => this.rates.importCsv(tx, { organisationId: org.organisationId, companyId, actor: this.rateActor(org), ...b, retrievedAt: new Date(b.retrievedAt) }));
  }
  getFxSettings(org: OrgAccess, companyId: string) { return this.t(org, (tx) => this.fxSettings.get(tx, companyId)); }
  setFxSettings(org: OrgAccess, companyId: string, b: z.output<typeof fxSettingsSchema>) {
    return this.t(org, (tx) => this.fxSettings.set(tx, { organisationId: org.organisationId, companyId, actor: { ...this.rateActor(org), kind: 'USER' }, ...b }));
  }
  previewRevaluation(org: OrgAccess, companyId: string, periodId: string, b: z.output<typeof revaluationSchema>) {
    return this.t(org, async (tx) => {
      if (!(await org.access.can('period:manage', { companyId }))) throw forbidden('Requires permission period:manage', 'permission_denied');
      return this.reval.preview(tx, { organisationId: org.organisationId, companyId, periodId, actor: this.rateActor(org), rates: b.rates });
    });
  }
  postRevaluation(org: OrgAccess, companyId: string, periodId: string, b: z.output<typeof revaluationSchema>) {
    return this.t(org, (tx) => this.reval.post(tx, { organisationId: org.organisationId, companyId, periodId, actor: { ...this.actor(org), ...this.rateActor(org) }, rates: b.rates }));
  }
  listRevaluationRuns(org: OrgAccess, companyId: string, q: z.output<typeof revaluationRunListQuerySchema>) { return this.t(org, (tx) => this.reval.listRuns(tx, companyId, q)); }
  reverseRevaluation(org: OrgAccess, companyId: string, runId: string) { return this.t(org, (tx) => this.reval.reverseDue(tx, { organisationId: org.organisationId, companyId, runId, actor: this.actor(org) })); }

  // Reads
  generalLedger(org: OrgAccess, companyId: string, q: z.output<typeof ledgerQuerySchema>) { return this.t(org, (tx) => this.queries.generalLedger(tx, companyId, q)); }
  trialBalance(org: OrgAccess, companyId: string, q: z.output<typeof trialBalanceQuerySchema>) { return this.t(org, (tx) => this.queries.trialBalance(tx, companyId, q)); }

  // Periods
  transitionPeriod(org: OrgAccess, companyId: string, periodId: string, action: PeriodAction, reason?: string, acknowledgeUnrevaluedFx = false, acknowledgeDraftDocuments = false, acknowledgeUnreconciledBank = false, acknowledgeSuspenseBalance = false) {
    return this.t(org, (tx) => this.periods.transition(tx, { organisationId: org.organisationId, companyId, periodId, action, reason, userId: org.userId, acknowledgeUnrevaluedFx, acknowledgeDraftDocuments, acknowledgeUnreconciledBank, acknowledgeSuspenseBalance, can: (p) => org.access.can(p as Permission, { companyId }) }));
  }
  async getPeriod(org: OrgAccess, companyId: string, periodId: string) {
    const p = await this.t(org, (tx) => tx.accountingPeriod.findFirst({ where: { id: periodId, companyId } }));
    if (!p) throw notFound('Accounting period not found');
    return periodView(p);
  }
}
