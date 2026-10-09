import { z, type ZodTypeAny } from 'zod';

/**
 * Domain event catalogue. An event type is declared ONCE here (name, version, payload schema) and is then
 * published through the transactional outbox. Later versions append their own events (e.g. JournalPosted,
 * FilingSubmitted) by adding a `defineEvent` here — no infrastructure change is needed.
 */
export interface EventDefinition<S extends ZodTypeAny = ZodTypeAny> {
  type: string;
  version: number;
  aggregateType: string;
  schema: S;
}
export const defineEvent = <S extends ZodTypeAny>(d: EventDefinition<S>): EventDefinition<S> => d;

const uuid = z.string().uuid();

export const Events = {
  companyCreated: defineEvent({ type: 'company.created', version: 1, aggregateType: 'company',
    schema: z.object({ companyId: uuid, name: z.string() }) }),
  userAddedToOrganisation: defineEvent({ type: 'organisation.member_added', version: 1, aggregateType: 'membership',
    schema: z.object({ membershipId: uuid, userId: uuid, roleKey: z.string() }) }),
  documentUploaded: defineEvent({ type: 'document.uploaded', version: 1, aggregateType: 'document_version',
    schema: z.object({ documentId: uuid, versionId: uuid, companyId: uuid.nullable(), contentType: z.string(), sizeBytes: z.number() }) }),
  documentEvidenceLocked: defineEvent({ type: 'document.evidence_locked', version: 1, aggregateType: 'document',
    schema: z.object({ documentId: uuid, versionId: uuid, sha256: z.string(), companyId: uuid.nullable(), retainUntil: z.string() }) }),
  documentExtracted: defineEvent({ type: 'document.extracted', version: 1, aggregateType: 'document_version',
    schema: z.object({ documentId: uuid, versionId: uuid, extractionId: uuid, provider: z.string(), pageCount: z.number().int().nullable(), charCount: z.number().int() }) }),
  accountingPeriodCreated: defineEvent({ type: 'accounting_period.created', version: 1, aggregateType: 'accounting_period',
    schema: z.object({ periodId: uuid, companyId: uuid, startDate: z.string(), endDate: z.string() }) }),
  transactionPosted: defineEvent({ type: 'transaction.posted', version: 1, aggregateType: 'journal',
    schema: z.object({ journalId: uuid, companyId: uuid, periodId: uuid, journalNumber: z.number().int(), journalDate: z.string(), sourceType: z.string(), sourceId: z.string().nullable(), total: z.string(), reversesJournalId: uuid.nullable() }) }),
  ledgerRequestCreated: defineEvent({ type: 'ledger.request_created', version: 1, aggregateType: 'journal_request',
    schema: z.object({ requestId: uuid, companyId: uuid, kind: z.enum(['OPENING_BALANCE', 'CONTROL_ADJUSTMENT']), requestedByUserId: uuid, approvalRequired: z.boolean() }) }),
  ledgerRequestDecided: defineEvent({ type: 'ledger.request_decided', version: 1, aggregateType: 'journal_request',
    schema: z.object({ requestId: uuid, companyId: uuid, kind: z.enum(['OPENING_BALANCE', 'CONTROL_ADJUSTMENT']), decision: z.enum(['APPROVED', 'REJECTED', 'CANCELLED']), requesterUserId: uuid, decidedByUserId: uuid, journalId: uuid.nullable() }) }),
  accountingPeriodStateChanged: defineEvent({ type: 'accounting_period.state_changed', version: 1, aggregateType: 'accounting_period',
    schema: z.object({ periodId: uuid, companyId: uuid, from: z.enum(['OPEN', 'CLOSED', 'LOCKED']), to: z.enum(['OPEN', 'CLOSED', 'LOCKED']), action: z.string() }) }),
  taskAssigned: defineEvent({ type: 'task.assigned', version: 1, aggregateType: 'task',
    schema: z.object({ taskId: uuid, assigneeUserId: uuid, title: z.string(), assignedByUserId: uuid }) }),
  taskReviewRequested: defineEvent({ type: 'task.review_requested', version: 1, aggregateType: 'task',
    schema: z.object({ taskId: uuid, reviewerUserId: uuid, title: z.string(), requestedByUserId: uuid }) }),
  taskReviewed: defineEvent({ type: 'task.reviewed', version: 1, aggregateType: 'task',
    schema: z.object({ taskId: uuid, decision: z.enum(['APPROVE', 'RETURN']), reviewerUserId: uuid, assigneeUserId: uuid.nullable(), title: z.string() }) }),
  taskCommented: defineEvent({ type: 'task.commented', version: 1, aggregateType: 'task',
    schema: z.object({ taskId: uuid, commentId: uuid, authorUserId: uuid, title: z.string(), recipientUserIds: z.array(uuid) }) }),
  workflowTransitioned: defineEvent({ type: 'workflow.transitioned', version: 1, aggregateType: 'workflow_instance',
    schema: z.object({ instanceId: uuid, workflowType: z.string(), from: z.string().nullable(), to: z.string(), action: z.string(), subjectType: z.string(), subjectId: z.string() }) }),
  aiProposalCreated: defineEvent({ type: 'ai.proposal_created', version: 1, aggregateType: 'ai_proposal',
    schema: z.object({ proposalId: uuid, kind: z.string() }) }),
  aiProposalDecided: defineEvent({ type: 'ai.proposal_decided', version: 1, aggregateType: 'ai_proposal',
    schema: z.object({ proposalId: uuid, kind: z.string(), decision: z.enum(['ACCEPTED', 'REJECTED', 'APPROVED'])  /* APPROVED: legacy events emitted before the state-model change */, decidedByUserId: uuid }) }),
} as const;

export const ALL_EVENT_DEFINITIONS: EventDefinition[] = Object.values(Events);
export const eventDefinitionFor = (type: string) => ALL_EVENT_DEFINITIONS.find((e) => e.type === type);

/** The envelope delivered to consumers. */
export interface DomainEvent<P = unknown> {
  id: string;
  type: string;
  version: number;
  aggregateType: string;
  aggregateId: string;
  organisationId: string | null;
  actorUserId: string | null;
  occurredAt: Date;
  correlationId: string;
  causationId: string | null;
  payload: P;
}
