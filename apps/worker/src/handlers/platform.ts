import { JobTypes, Events } from '@uk/contracts';
import { AppError } from '@uk/core';
import { UnrecoverableError, type JobRuntime } from '@uk/jobs';

/** Client errors (4xx) can never succeed on retry: fail the job permanently instead of burning attempts. */
const permanentOn4xx = async <T>(fn: () => Promise<T>): Promise<T> => {
  try { return await fn(); } catch (e) {
    if (e instanceof AppError && e.status >= 400 && e.status < 500) throw new UnrecoverableError(`${e.code}: ${e.message}`);
    throw e;
  }
};
import type { Database } from '@uk/db';
import { type AiGateway, type AiProposalService, type EventBus, type FeatureFlagService, type IntegrationService, type NotificationService } from '@uk/platform';

/** event.dispatch: the outbox relay's hand-off lands here; the EventBus runs each subscribed consumer once. */
export function registerEventDispatch(rt: JobRuntime, bus: EventBus): void {
  rt.register(JobTypes.eventDispatch, async ({ payload }) => bus.dispatch(payload.eventId));
}

/** Consumers (idempotent, run in the event's tenant context, atomically with their `event_consumption` marker). */
export function registerConsumers(bus: EventBus, notifications: NotificationService): void {
  bus.subscribe('notifications.task_assigned', [Events.taskAssigned.type], async ({ event, tx }) => {
    const p = Events.taskAssigned.schema.parse(event.payload);
    if (p.assigneeUserId === p.assignedByUserId) return; // don't notify people about their own actions
    await notifications.notify(tx, { organisationId: event.organisationId!, userId: p.assigneeUserId, type: 'task.assigned', title: 'A task was assigned to you', body: p.title, entityType: 'task', entityId: p.taskId });
  });
  bus.subscribe('notifications.task_review_requested', [Events.taskReviewRequested.type], async ({ event, tx }) => {
    const p = Events.taskReviewRequested.schema.parse(event.payload);
    await notifications.notify(tx, { organisationId: event.organisationId!, userId: p.reviewerUserId, type: 'task.review_requested', title: 'A task is waiting for your review', body: p.title, entityType: 'task', entityId: p.taskId });
  });
  bus.subscribe('notifications.task_reviewed', [Events.taskReviewed.type], async ({ event, tx }) => {
    const p = Events.taskReviewed.schema.parse(event.payload);
    if (!p.assigneeUserId || p.assigneeUserId === p.reviewerUserId) return;
    await notifications.notify(tx, { organisationId: event.organisationId!, userId: p.assigneeUserId, type: p.decision === 'APPROVE' ? 'task.approved' : 'task.returned',
      title: p.decision === 'APPROVE' ? 'Your task was approved' : 'Your task was returned for changes', body: p.title, entityType: 'task', entityId: p.taskId });
  });
  // M2: the requester learns the outcome of their opening-balance / control-adjustment request. No amounts or account names in the notification.
  bus.subscribe('notifications.ledger_request_decided', [Events.ledgerRequestDecided.type], async ({ event, tx }) => {
    const p = Events.ledgerRequestDecided.schema.parse(event.payload);
    if (p.requesterUserId === p.decidedByUserId) return; // withdrawing or self-posting your own request needs no notification
    const what = p.kind === 'OPENING_BALANCE' ? 'opening balance' : 'control-account adjustment';
    await notifications.notify(tx, { organisationId: event.organisationId!, userId: p.requesterUserId, type: `ledger.request_${p.decision.toLowerCase()}`,
      title: p.decision === 'APPROVED' ? `Your ${what} request was approved and posted` : `Your ${what} request was ${p.decision.toLowerCase()}`, body: 'Open the request for details.', entityType: 'journal_request', entityId: p.requestId });
  });
  bus.subscribe('notifications.task_commented', [Events.taskCommented.type], async ({ event, tx }) => {
    const p = Events.taskCommented.schema.parse(event.payload);
    for (const userId of p.recipientUserIds) {
      await notifications.notify(tx, { organisationId: event.organisationId!, userId, type: 'task.commented', title: 'New comment on a task', body: p.title, entityType: 'task', entityId: p.taskId });
    }
  });
}

export function registerAi(rt: JobRuntime, deps: { db: Database; gateway: AiGateway; proposals: AiProposalService; features: FeatureFlagService }): void {
  rt.register(JobTypes.aiSuggest, async ({ payload, organisationId, userId }) => {
    if (!organisationId) throw new UnrecoverableError('ai.suggest requires an organisation');
    // Re-checked at execution time: switching the flag off also stops requests that were queued earlier.
    if (!(await deps.features.isEnabled('ai.beta', organisationId))) throw new UnrecoverableError('feature ai.beta is disabled for this organisation');
    return permanentOn4xx(() => deps.db.tenant({ organisationId, userId: userId ?? undefined }, async (tx) => {
      const run = await deps.gateway.complete(tx, { organisationId, userId, purpose: payload.purpose }, { prompt: payload.input });
      const proposal = await deps.proposals.create(tx, { organisationId, companyId: payload.companyId, requestedByUserId: userId, kind: payload.purpose, aiRunId: run.runId, provider: run.provider, model: run.model, payload: { summary: run.text } });
      return { proposalId: proposal.id, aiRunId: run.runId };
    }));
  });
}

export function registerIntegrations(rt: JobRuntime, deps: { db: Database; service: IntegrationService }): void {
  rt.register(JobTypes.integrationExecute, async ({ payload, organisationId, userId }) => {
    if (!organisationId) throw new UnrecoverableError('integration.execute requires an organisation');
    return permanentOn4xx(() => deps.db.tenant({ organisationId, userId: userId ?? undefined }, (tx) => deps.service.execute(tx, payload.connectionId, organisationId, payload.operation, payload.params as Record<string, unknown>)));
  });
}
