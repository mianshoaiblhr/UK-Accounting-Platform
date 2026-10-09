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
import { type AiGateway, type AiProposalService, type EventBus, type IntegrationService, type NotificationService } from '@uk/platform';

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
}

export function registerAi(rt: JobRuntime, deps: { db: Database; gateway: AiGateway; proposals: AiProposalService }): void {
  rt.register(JobTypes.aiSuggest, async ({ payload, organisationId, userId }) => {
    if (!organisationId) throw new UnrecoverableError('ai.suggest requires an organisation');
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
