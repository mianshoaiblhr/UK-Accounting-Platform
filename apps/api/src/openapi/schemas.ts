import { z } from 'zod';

/** Response shapes (the request shapes come from @uk/contracts, so docs and validation can never drift). */
const uuid = z.string().uuid();
const ts = z.string().datetime();
const page = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const Company = z.object({ id: uuid, organisationId: uuid, practiceId: uuid.nullable().describe('Managing practice; null for direct (BUSINESS) organisations'), name: z.string(), companyNumber: z.string().nullable(), legalForm: z.string(), incorporationDate: day.nullable(), yearEnd: z.object({ month: z.number().int(), day: z.number().int() }).nullable().describe('Financial year-end; 29 February means the last day of February'), baseCurrency: z.string().length(3), countryCode: z.string().length(2), taxJurisdictionCode: z.string().nullable(), status: z.enum(['ACTIVE', 'ARCHIVED']), createdAt: ts });
export const Period = z.object({ id: uuid, companyId: uuid, startDate: z.string(), endDate: z.string(), status: z.enum(['OPEN', 'CLOSED', 'LOCKED']) });
export const DocumentVersion = z.object({ id: uuid, documentId: uuid, versionNo: z.number().int(), contentType: z.string(), sizeBytes: z.number().int(), sha256: z.string().nullable(), status: z.enum(['PENDING_UPLOAD', 'UPLOADED', 'SCANNING', 'AVAILABLE', 'QUARANTINED', 'FAILED']), scanResult: z.string().nullable(), storageKey: z.string() });
export const DocumentRecord = z.object({ id: uuid, name: z.string(), companyId: uuid.nullable(), documentClass: z.string(), status: z.enum(['ACTIVE', 'ARCHIVED']), legalHold: z.boolean(), retainUntil: z.string().nullable(),
  folderId: uuid.nullable(), periodId: uuid.nullable(), description: z.string().nullable(), documentDate: z.string().nullable(), reference: z.string().nullable(), labels: z.array(z.string()),
  metadata: z.record(z.union([z.string(), z.number(), z.boolean()])), visibility: z.enum(['STANDARD', 'RESTRICTED']).describe('RESTRICTED: visible to the creator, explicit grants and document:confidential holders; everyone else gets 404'),
  evidenceLockedAt: ts.nullable().describe('Set once the document is locked as immutable filing evidence (irreversible)'), evidenceVersionId: uuid.nullable(), evidenceSha256: z.string().nullable(),
  versions: z.array(DocumentVersion).optional() });
export const DocumentExtraction = z.object({ id: uuid, documentId: uuid, documentVersionId: uuid, provider: z.string(), engineVersion: z.string().nullable(), status: z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED']),
  charCount: z.number().int().nullable(), pageCount: z.number().int().nullable(), confidence: z.string().nullable().describe('0..1 as a decimal string'), language: z.string().nullable(), truncated: z.boolean(), error: z.string().nullable(),
  text: z.string().optional().describe('Only with ?text=true'), createdAt: ts, completedAt: ts.nullable() });
export const EvidenceLink = z.object({ id: uuid, companyId: uuid.nullable(), sourceType: z.string(), sourceId: uuid, targetType: z.string(), targetId: uuid, kind: z.enum(['SUPPORTS', 'DERIVED_FROM', 'ATTACHED_TO', 'REFERENCES', 'FILED_AS']), note: z.string().nullable(),
  createdByUserId: uuid.nullable(), createdAt: ts, revokedAt: ts.nullable(), revokedByUserId: uuid.nullable(), revokedReason: z.string().nullable(), direction: z.enum(['out', 'in']).optional().describe('Only in list responses: relative to the queried entity') });
export const DocumentFolder = z.object({ id: uuid, companyId: uuid.nullable(), parentId: uuid.nullable(), name: z.string(), createdByUserId: uuid, createdAt: ts, updatedAt: ts });
export const DocumentAccessGrant = z.object({ id: uuid, documentId: uuid, userId: uuid, grantedByUserId: uuid, createdAt: ts });
export const UploadInstructions = z.object({ method: z.literal('PUT'), url: z.string(), headers: z.record(z.string()), via: z.enum(['presigned', 'api']), expiresInSeconds: z.number() });
export const DocumentCreated = z.object({ document: DocumentRecord, version: DocumentVersion, upload: UploadInstructions });
export const Job = z.object({ id: uuid, type: z.string(), queue: z.string(), status: z.enum(['QUEUED', 'RUNNING', 'RETRYING', 'COMPLETED', 'FAILED', 'DEAD']), progress: z.number().int(), progressMessage: z.string().nullable(), companyId: uuid.nullable().describe('Company the job concerns; jobs of companies the caller cannot read are not listed'), traceId: z.string().nullable().describe('W3C trace id of the enqueuing request'), attempts: z.number().int(), maxAttempts: z.number().int(), error: z.string().nullable(), correlationId: z.string(), createdAt: ts, startedAt: ts.nullable(), finishedAt: ts.nullable(), result: z.unknown().nullable() });
export const Task = z.object({ id: uuid, companyId: uuid.nullable(), title: z.string(), description: z.string(), status: z.enum(['OPEN', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED']), priority: z.enum(['LOW', 'NORMAL', 'HIGH']), dueDate: z.string().nullable(), assigneeUserId: uuid.nullable(), reviewerUserId: uuid.nullable().describe('With a reviewer the task is completed only from IN_REVIEW and only by that user'), source: z.enum(['MANUAL', 'WORKFLOW', 'AI_PROPOSAL', 'DOCUMENT', 'EVENT', 'SYSTEM']), sourceId: z.string().nullable(), createdByUserId: uuid, completedAt: ts.nullable() });
export const TaskComment = z.object({ id: uuid, taskId: uuid, authorUserId: uuid, body: z.string(), kind: z.enum(['COMMENT', 'REVIEW_APPROVED', 'REVIEW_RETURNED']), createdAt: ts });
export const TaskAttachment = z.object({ id: uuid, taskId: uuid, documentId: uuid, addedByUserId: uuid, createdAt: ts, documentName: z.string().nullable().describe('null when the caller cannot read documents of the company'), documentStatus: z.string().nullable() });
export const TaskReminder = z.object({ id: uuid, taskId: uuid, recipientUserId: uuid, remindAt: ts, createdByUserId: uuid, createdAt: ts, sentAt: ts.nullable(), cancelledAt: ts.nullable() });
export const Notification = z.object({ id: uuid, type: z.string(), title: z.string(), body: z.string(), entityType: z.string().nullable(), entityId: z.string().nullable(), readAt: ts.nullable(), createdAt: ts });
export const WorkflowInstance = z.object({ id: uuid, type: z.string(), definitionVersion: z.number().int(), companyId: uuid.nullable(), assigneeUserId: uuid.nullable(), attempt: z.number().int(), state: z.string(), subjectType: z.string(), subjectId: z.string(), version: z.number().int(), startedByUserId: uuid, completedAt: ts.nullable(), dueAt: ts.nullable().describe('Deadline; null when none'), overdue: z.boolean().describe('Past its deadline and not finished'), overdueNotifiedAt: ts.nullable() });
export const WorkflowDetail = WorkflowInstance.extend({ availableActions: z.array(z.string()), transitions: z.array(z.object({ fromState: z.string().nullable(), toState: z.string(), action: z.string(), actorUserId: uuid.nullable(), comment: z.string().nullable(), attempt: z.number().int(), evidenceDocumentIds: z.array(uuid), occurredAt: ts })) });
export const WorkflowDefinitionView = z.object({ type: z.string(), version: z.number().int(), initialState: z.string(), terminalStates: z.array(z.string()), apiStartable: z.boolean(), slaHours: z.number().nullable().describe('Default deadline in hours after start; null when the definition has none'), transitions: z.array(z.object({ action: z.string(), from: z.array(z.string()), to: z.string(), permission: z.string() }).passthrough()) });
export const Connection = z.object({ id: uuid, provider: z.string(), displayName: z.string(), status: z.enum(['ACTIVE', 'REVOKED', 'ERROR']), companyId: uuid.nullable(), scopes: z.array(z.string()), createdAt: ts, lastCheckedAt: ts.nullable(), lastError: z.string().nullable() });
export const Provider = z.object({ provider: z.string(), displayName: z.string(), capabilities: z.array(z.string()) });
export const AiProposal = z.object({ id: uuid, kind: z.string(), payload: z.unknown(), status: z.enum(['SUGGESTED', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED']), provider: z.string().nullable(), model: z.string().nullable(), promptVersion: z.string().nullable(), confidence: z.union([z.number(), z.string()]).nullable().describe('0..1 where the provider supplies one'), sourceEvidence: z.array(z.object({ type: z.string(), id: z.string() })), reviewStartedByUserId: uuid.nullable(), appliedAt: ts.nullable(), appliedByUserId: uuid.nullable(), appliedReference: z.string().nullable(), workflowInstanceId: uuid.nullable(), requestedByUserId: uuid.nullable(), decidedByUserId: uuid.nullable(), decidedAt: ts.nullable(), decisionComment: z.string().nullable() });
export const JobAccepted = z.object({ jobId: uuid, status: z.string() });
export const Role = z.object({ id: uuid, key: z.string(), name: z.string(), description: z.string(), permissions: z.array(z.string()), isSystem: z.boolean() });
export const Member = z.object({ id: uuid, user: z.object({ id: uuid, email: z.string(), displayName: z.string() }), role: z.object({ id: uuid, key: z.string(), name: z.string() }), status: z.string(), companyScope: z.enum(['ALL', 'ASSIGNED']), companyIds: z.array(uuid), companyGrants: z.array(z.object({ companyId: uuid, role: z.object({ id: uuid, key: z.string() }) })), practiceGrants: z.array(z.object({ practiceId: uuid, role: z.object({ id: uuid, key: z.string() }) })) });
export const Invitation = z.object({ id: uuid, email: z.string(), expiresAt: ts });
export const AuditEvent = z.object({ id: uuid, occurredAt: ts, organisationId: uuid.nullable(), actorUserId: uuid.nullable(), action: z.string(), entityType: z.string().nullable(), entityId: z.string().nullable(), companyId: uuid.nullable(), outcome: z.enum(['SUCCESS', 'FAILURE', 'DENIED']), ip: z.string().nullable(), userAgent: z.string().nullable(), correlationId: z.string().nullable(), metadata: z.record(z.unknown()), before: z.record(z.unknown()).nullable().describe('Changed fields only (redacted)'), after: z.record(z.unknown()).nullable(), reason: z.string().nullable(), sourceWorkflowId: uuid.nullable().describe('Workflow instance this action was part of') });
export const Organisation = z.object({ id: uuid, type: z.enum(['PRACTICE', 'BUSINESS']), name: z.string(), status: z.string() });
/** M9 (DEC-049): what the caller may do in one company, and the resolved feature flags. Screens use it to hide actions; the API still enforces. */
export const CompanyAccess = z.object({ companyId: uuid, permissions: z.array(z.string()).describe('Effective permissions on this company (organisation, practice and company grants resolved as the guards do)'),
  features: z.record(z.string(), z.boolean()).describe('Every registered feature flag, resolved for the organisation') });
export const OrgMe = z.object({ organisationId: uuid, organisationType: z.enum(['PRACTICE', 'BUSINESS']), role: z.string(), permissions: z.array(z.string()).describe('Organisation-level role permissions; company/practice decisions use grants'), companyScope: z.enum(['ALL', 'ASSIGNED']).describe('Reach of the organisation role: ALL = organisation-wide default'), companyIds: z.array(uuid).describe('Companies with an explicit company-level grant'), practiceIds: z.array(uuid).describe('Practices with an explicit practice-level grant') });
export const FeatureFlag = z.object({ key: z.string(), description: z.string(), enabled: z.boolean(), source: z.enum(['organisation', 'environment', 'default']).describe('Where the effective value comes from'), overriddenAt: ts.optional(), reason: z.string().nullable().optional() });
export const Currency = z.object({ code: z.string().length(3), numericCode: z.string(), name: z.string(), minorUnits: z.number().int() });
export const Country = z.object({ alpha2: z.string().length(2), alpha3: z.string().length(3), numericCode: z.string(), name: z.string() });
export const RetentionCategoryView = z.object({ code: z.string(), name: z.string(), kind: z.enum(['PERIOD', 'WHILE_ACTIVE', 'NOT_APPLICABLE']), years: z.number().int().nullable(), days: z.number().int().nullable(), trigger: z.string().describe('The event the period runs from'), basis: z.string().describe('Statutory or policy anchor (not legal advice)'), status: z.enum(['PROVISIONAL', 'CONFIRMED']).describe('PROVISIONAL until the DPO/legal decision is recorded'), documentTypes: z.array(z.string()) });
export const TaxJurisdiction = z.object({ id: uuid, code: z.string(), countryCode: z.string().length(2), name: z.string(), authority: z.string(), validFrom: day, validTo: day.nullable() });
export const Contact = z.object({ id: uuid, companyId: uuid.nullable().describe('null = organisation-level contact'), kind: z.enum(['PERSON', 'ORGANISATION']), name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), reference: z.string().nullable(), labels: z.array(z.string()), notes: z.string().nullable(), vatNumber: z.string().nullable().describe('Format-checked only; not validated with HMRC'), status: z.enum(['ACTIVE', 'ARCHIVED']), createdAt: ts, updatedAt: ts });
export const Address = z.object({ id: uuid, companyId: uuid.nullable(), contactId: uuid.nullable(), kind: z.enum(['REGISTERED_OFFICE', 'TRADING', 'CORRESPONDENCE', 'RESIDENTIAL', 'OTHER']), line1: z.string(), line2: z.string().nullable(), line3: z.string().nullable(), city: z.string(), region: z.string().nullable(), postcode: z.string().nullable(), countryCode: z.string().length(2), primary: z.boolean() });
export const Officer = z.object({ id: uuid, companyId: uuid, role: z.enum(['DIRECTOR', 'SECRETARY', 'PERSON_WITH_SIGNIFICANT_CONTROL', 'MEMBER', 'PARTNER', 'TRUSTEE', 'OTHER']), appointedOn: day, resignedOn: day.nullable(), contact: z.object({ id: uuid, name: z.string(), kind: z.enum(['PERSON', 'ORGANISATION']) }) });
export const ProposedPeriod = z.object({ startDate: day, endDate: day });
export const Practice = z.object({ id: uuid, organisationId: uuid, name: z.string(), status: z.enum(['ACTIVE', 'ARCHIVED']), createdAt: ts });
const grantee = z.object({ membershipId: uuid, user: z.object({ id: uuid, email: z.string(), displayName: z.string() }), status: z.string(), role: z.object({ id: uuid, key: z.string(), name: z.string() }) });
export const GrantList = z.object({ items: z.array(grantee) });
export const GrantResult = z.object({ membershipId: uuid, roleId: uuid, practiceId: uuid.optional(), companyId: uuid.optional() });
export const Me = z.object({ user: z.object({ id: uuid, email: z.string(), displayName: z.string() }), mfa: z.object({ enabled: z.boolean(), type: z.string().nullable(), recoveryCodesRemaining: z.number().int() }), organisations: z.array(z.object({ id: uuid, name: z.string(), type: z.enum(['PRACTICE', 'BUSINESS']), role: z.string(), roleName: z.string(), membershipId: uuid })) });
export const Session = z.object({ id: uuid, createdAt: ts, lastSeenAt: ts, ip: z.string().nullable(), userAgent: z.string().nullable(), authMethod: z.string(), current: z.boolean() });
export const LoginResult = z.object({ mfaRequired: z.boolean(), challengeToken: z.string().optional(), expiresAt: ts.optional(), sessionToken: z.string().optional().describe('Only returned by the /bearer variants') });
export const Message = z.object({ message: z.string() });
export const Health = z.object({ status: z.enum(['ok', 'degraded']), checks: z.record(z.string()).optional(), degraded: z.array(z.enum(['outbox_lag', 'outbox_failed', 'dead_jobs'])).optional().describe('Background trouble; the API is still serving. Alarms handle it.'), figures: z.record(z.number()).optional().describe('Only with the metrics bearer token') });
export const LoginEvent = z.object({ id: uuid, occurredAt: ts, action: z.string(), outcome: z.string(), ip: z.string().nullable(), userAgent: z.string().nullable() });
export const MfaStatus = z.object({ enabled: z.boolean(), type: z.string().nullable(), recoveryCodesRemaining: z.number().int() });
export const MfaEnrol = z.object({ secret: z.string(), otpauthUrl: z.string() });
export const MfaConfirmed = z.object({ recoveryCodes: z.array(z.string()).describe('Shown exactly once') });
export const DownloadLink = z.object({ url: z.string(), expiresInSeconds: z.number(), sha256: z.string().nullable() });
export const CheckResult = z.object({ ok: z.boolean(), detail: z.string().optional(), provider: z.string() });

export const Pages = { Contact: page(Contact), Company: page(Company), DocumentRecord: page(DocumentRecord), Job: page(Job), Task: page(Task), Notification: page(Notification), WorkflowInstance: page(WorkflowInstance), AiProposal: page(AiProposal), AuditEvent: page(AuditEvent) };
export const items = <T extends z.ZodTypeAny>(i: T) => z.object({ items: z.array(i) });

// ───────── V1 ledger (ADR-44..48). Money is ALWAYS a decimal string. ─────────
const money = z.string().regex(/^\d+(\.\d+)?$/).describe('Decimal string, never a JSON number');
const signedMoney = z.string().regex(/^-?\d+(\.\d+)?$/).describe('Decimal string; negative = opposite of the natural side');
export const AccountView = z.object({
  id: uuid, companyId: uuid, code: z.string(), name: z.string(), type: z.enum(['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE']), subtype: z.string(), normalBalance: z.enum(['DEBIT', 'CREDIT']),
  isControl: z.boolean(), controlKind: z.string().nullable(), taxTreatment: z.string(), reportingMapping: z.string(), reportingMappingVersion: z.number().int(),
  activeFrom: day.nullable(), activeTo: day.nullable(), isSystem: z.boolean(), createdAt: ts,
});
export const JournalHeader = z.object({
  id: uuid, journalNumber: z.number().int(), journalDate: day, periodId: uuid, sourceType: z.string(), sourceId: z.string().nullable(), sourceReference: z.string().nullable(), description: z.string(),
  total: money, lineCount: z.number().int(), actorType: z.enum(['USER', 'SYSTEM']), postedByUserId: uuid.nullable(), postedAt: ts, reversesJournalId: uuid.nullable(),
  requestId: uuid.nullable().describe('The approved journal request this journal was posted from (opening balances and control adjustments only)'), requestedByUserId: uuid.nullable(), approvedByUserId: uuid.nullable(),
  negativeCashReason: z.string().nullable().describe('DEC-037: why the person took a cash-in-hand account below zero (the database refuses it without a reason)'),
  reversedByJournalId: uuid.nullable(), reversedByJournalNumber: z.number().int().nullable(),
});
export const JournalDetail = JournalHeader.extend({
  currency: z.string().length(3), reverses: z.object({ journalId: uuid, journalNumber: z.number().int() }).nullable(), replayed: z.boolean().optional().describe('true when an earlier posting with the same idempotency key was returned'),
  lines: z.array(z.object({ lineNo: z.number().int(), accountId: uuid, accountCode: z.string().nullable(), accountName: z.string().nullable(), debit: money, credit: money, description: z.string().nullable(),
    original: z.object({ currency: z.string().length(3), debit: money, credit: money, rate: z.string(), rateId: uuid.nullable() }).nullable().describe('Original-currency values of a foreign-currency line; debit and credit above are the functional amounts'),
    adjustsCurrency: z.string().length(3).nullable().describe('Set on a functional-only revaluation adjustment that belongs to this foreign-currency balance'),
    vat: z.object({ taxCodeId: uuid, taxRateId: uuid, role: z.enum(['NET', 'VAT', 'RC_OUTPUT', 'RC_INPUT']), taxPoint: day, netLineNo: z.number().int().nullable(), inclusive: z.boolean(), ratePoint: day.nullable().describe('Credit notes: the tax point of the supply being adjusted, whose rate version applies') }).nullable().describe('VAT facts: the net line, or a VAT line pointing at its net line') })),
});
export const JournalPage = z.object({ currency: z.string().length(3), items: z.array(JournalHeader), nextCursor: z.string().nullable() });
export const GeneralLedger = z.object({
  currency: z.string().length(3), account: z.object({ id: uuid, code: z.string(), name: z.string(), type: z.string() }), from: day.nullable(), to: day.nullable(),
  excludeClosing: z.boolean().describe('Year-end closing journals left out of the opening balance, the lines and the running balance (DEC-060)'), openingBalance: signedMoney,
  items: z.array(z.object({ journalId: uuid, journalNumber: z.number().int(), journalDate: day, lineNo: z.number().int(), description: z.string(), sourceType: z.string(), sourceId: z.string().nullable(), sourceReference: z.string().nullable(), debit: money, credit: money, balance: signedMoney.describe('Running balance on the account\'s natural side') })),
  nextCursor: z.string().nullable(),
});
export const TrialBalance = z.object({
  currency: z.string().length(3), asOf: day, period: z.object({ id: uuid, startDate: day, endDate: day, status: z.enum(['OPEN', 'CLOSED', 'LOCKED']) }).nullable(),
  rows: z.array(z.object({ accountId: uuid, code: z.string(), name: z.string(), type: z.string(), subtype: z.string(), reportingMapping: z.string(), debit: money, credit: money, movementDebit: money.optional(), movementCredit: money.optional(),
    drilldown: z.object({ accountId: uuid, from: day.nullable(), to: day }).describe('Parameters of the general-ledger query that explains this row') })),
  totalDebit: money, totalCredit: money, balanced: z.boolean(), warnings: z.array(z.object({ code: z.string(), accountId: uuid, accountCode: z.string(), message: z.string(), balance: signedMoney })),
});
export const PeriodState = z.object({ id: uuid, companyId: uuid, startDate: day, endDate: day, status: z.enum(['OPEN', 'CLOSED', 'LOCKED']), statusChangedAt: ts.nullable(), statusChangedByUserId: uuid.nullable(), statusReason: z.string().nullable() });

export const JournalRequest = z.object({
  id: uuid, companyId: uuid, kind: z.enum(['OPENING_BALANCE', 'CONTROL_ADJUSTMENT']), status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']),
  effectiveStatus: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED']).describe('PENDING requests past their expiry read EXPIRED: they can no longer be approved'),
  journalDate: day, description: z.string(), reason: z.string(), currency: z.string().length(3), total: money,
  lines: z.array(z.object({ accountId: uuid, debit: money, credit: money, description: z.string().optional().nullable() })), evidenceDocumentIds: z.array(uuid),
  requestedByUserId: uuid, requestedAt: ts, expiresAt: ts, approvalRequired: z.boolean(), selfApproved: z.boolean().describe('true when the company policy exempted this request from a second person (below the materiality threshold)'),
  policySnapshot: z.record(z.string(), z.unknown()).describe('The policy that applied when the request was made'),
  decidedByUserId: uuid.nullable(), decidedAt: ts.nullable(), decisionReason: z.string().nullable(), postedJournalId: uuid.nullable(),
});
export const JournalRequestPage = page(JournalRequest);
export const LedgerPolicy = z.object({
  openingBalanceApproval: z.enum(['ALWAYS', 'ABOVE_THRESHOLD']), controlAdjustmentApproval: z.enum(['ALWAYS', 'ABOVE_THRESHOLD']), materialityThreshold: money.nullable(), requestExpiryDays: z.number().int(),
  fxBlockUnverifiedRates: z.boolean().describe('true when postings that would use an UNVERIFIED exchange rate are refused'), isDefault: z.boolean().describe('true when nothing has been configured for the company (approval always required, 14 days)'), updatedAt: ts.nullable(), updatedByUserId: uuid.nullable(),
});

// ───────────── Foreign currency (M3) ─────────────
export const ExchangeRate = z.object({
  id: uuid, fromCurrency: z.string().length(3), toCurrency: z.string().length(3), kind: z.enum(['DAILY', 'PERIOD']), validFrom: day, validTo: day, rate: z.string().describe('Decimal string with 8 decimal places, as published; never rounded'),
  sourceKind: z.enum(['MANUAL', 'IMPORT']), publisher: z.string(), series: z.string().nullable(), sourceUrl: z.string().nullable(), sourceRef: z.string().nullable(), retrievedAt: ts.nullable(), enteredByUserId: uuid,
  importBatchId: uuid.nullable(), verificationStatus: z.enum(['UNVERIFIED', 'VERIFIED']), verifiedByUserId: uuid.nullable(), verifiedAt: ts.nullable(), supersededById: uuid.nullable(), createdAt: ts,
});
export const ExchangeRatePage = page(ExchangeRate);
export const RateImportResult = z.object({ batchId: uuid, imported: z.number().int(), skippedIdentical: z.number().int(), status: z.literal('UNVERIFIED') });
export const FxSettings = z.object({
  companyId: uuid, roundingAccountId: uuid.nullable(), realisedAccountId: uuid.nullable(), unrealisedAccountId: uuid.nullable(),
  defaultSeries: z.record(z.string(), z.object({ publisher: z.string(), series: z.string().nullable() })), isDefault: z.boolean(), updatedAt: ts.nullable(), updatedByUserId: uuid.nullable(),
});
export const RevaluationItem = z.object({ accountId: uuid, accountCode: z.string(), accountName: z.string(), currency: z.string().length(3), originalBalance: z.string(), carryingBalance: money, rate: z.string(), rateId: uuid, targetBalance: money, adjustment: z.string().describe('Signed: positive increases the debit balance') });
export const RevaluationPreview = z.object({
  companyId: uuid, periodId: uuid, asAt: day, functionalCurrency: z.string().length(3), minorUnits: z.number().int(), items: z.array(RevaluationItem), netAdjustment: z.string(), unrealisedAccountId: uuid.nullable(),
  missingRates: z.array(z.object({ currency: z.string(), message: z.string() })),
});
export const RevaluationRun = z.object({
  id: uuid, companyId: uuid, periodId: uuid, asAt: day, status: z.enum(['POSTED', 'REVERSED']), revaluationJournalId: uuid, reversalJournalId: uuid.nullable(), reversalDueDate: day, netAdjustment: z.string(),
  runByUserId: uuid, createdAt: ts, reversedAt: ts.nullable(),
});
export const RevaluationRunPage = page(RevaluationRun);
export const RevaluationResult = z.object({ status: z.enum(['POSTED', 'NOTHING_TO_DO']), preview: RevaluationPreview, run: RevaluationRun.nullable(), journalId: uuid.nullable(), reversalJournalId: uuid.nullable().describe('null while the reversal is still due (no open period covers its date)') });

// ───────────── Customers and suppliers (M4a) ─────────────
const BankDetailsSummary = z.object({ status: z.enum(['NONE', 'UNVERIFIED', 'VERIFIED']).describe('UNVERIFIED until a second person verifies a change; payments refuse UNVERIFIED details'), masked: z.string().nullable(),
  changedAt: ts.nullable(), changedByUserId: uuid.nullable(), verifiedAt: ts.nullable(), verifiedByUserId: uuid.nullable() });
export const ContactRole = z.object({
  id: uuid, companyId: uuid, contactId: uuid, role: z.enum(['CUSTOMER', 'SUPPLIER']), accountCode: z.string().nullable(), status: z.enum(['ACTIVE', 'ENDED']), endedAt: ts.nullable(), endedReason: z.string().nullable(), createdAt: ts,
  contact: z.object({ id: uuid, name: z.string(), kind: z.enum(['PERSON', 'ORGANISATION']), email: z.string().nullable(), vatNumber: z.string().nullable(), companyId: uuid.nullable(), status: z.enum(['ACTIVE', 'ARCHIVED']) }),
  customer: z.object({ paymentTermsDays: z.number().int(), creditLimit: z.string().nullable(), defaultCurrency: z.string().nullable(), defaultTaxCodeId: uuid.nullable() }).nullable(),
  supplier: z.object({ paymentTermsDays: z.number().int(), defaultCurrency: z.string().nullable(), defaultExpenseAccountId: uuid.nullable(), bankDetails: BankDetailsSummary }).nullable(),
});
export const ContactRolePage = page(ContactRole);
export const BankDetailsView = BankDetailsSummary.extend({ accountName: z.string(), sortCode: z.string().optional(), accountNumber: z.string().optional(), iban: z.string().optional(), bic: z.string().optional() });
export const ContactSnapshot = z.object({
  roleId: uuid, role: z.enum(['CUSTOMER', 'SUPPLIER']), contactId: uuid, accountCode: z.string().nullable(), name: z.string(), kind: z.enum(['PERSON', 'ORGANISATION']), vatNumber: z.string().nullable(), email: z.string().nullable(),
  address: z.object({ line1: z.string(), line2: z.string().nullable(), line3: z.string().nullable(), city: z.string(), region: z.string().nullable(), postcode: z.string().nullable(), countryCode: z.string() }).nullable(), capturedAt: ts,
});

// ───────────── VAT foundation (M4b) ─────────────
export const TaxRateVersion = z.object({
  id: uuid, taxCodeId: uuid, rate: z.string().describe('Percentage with 4 decimals, as entered from the source'), effectiveFrom: day, effectiveTo: day.nullable(), netBoxes: z.array(z.number().int()), vatBoxes: z.array(z.number().int()),
  source: z.object({ url: z.string(), provision: z.string(), retrievedOn: day }), enteredByUserId: uuid, createdAt: ts,
  verificationStatus: z.enum(['UNVERIFIED', 'VERIFIED']).describe('UNVERIFIED versions cannot be used on any posting'), verifiedByUserId: uuid.nullable(), verifiedAt: ts.nullable(), verificationNotes: z.string().nullable(), evidenceDocumentId: uuid.nullable(), supersededById: uuid.nullable(),
});
export const TaxCode = z.object({ id: uuid, code: z.string(), name: z.string(), treatment: z.enum(['STANDARD', 'REDUCED', 'ZERO', 'EXEMPT', 'OUTSIDE_SCOPE']), direction: z.enum(['SALES', 'PURCHASES', 'BOTH']), reverseCharge: z.boolean(), createdAt: ts, rates: z.array(TaxRateVersion) });
export const VatSettings = z.object({ companyId: uuid, registered: z.boolean(), vrn: z.string().nullable(), registeredFrom: day.nullable(), scheme: z.string(), periodMonths: z.number().int(), anchorPeriodEnd: day.nullable(),
  outputAccountId: uuid.nullable(), inputAccountId: uuid.nullable(), liabilityAccountId: uuid.nullable().describe('V5-M2: where a filed return\'s VAT is moved to'), isDefault: z.boolean(), updatedAt: ts.nullable(), updatedByUserId: uuid.nullable() });
export const VatPeriod = z.object({ from: day, to: day, periodMonths: z.number().int() });
const BoxLine = z.object({ journalId: uuid, journalNumber: z.number().int(), lineNo: z.number().int(), accountCode: z.string(), taxCode: z.string(), taxPoint: day, amount: z.string() });
export const VatWorkpaper = z.object({
  companyId: uuid, from: day, to: day, currency: z.string().length(3), vrn: z.string().nullable(), scheme: z.string(),
  boxes: z.array(z.object({ box: z.number().int(), amount: z.string(), lines: z.array(BoxLine), direction: z.enum(['PAYABLE', 'REPAYABLE']).optional() })),
  reconciliation: z.object({ vatAccountMovement: z.string(), vatLinesByTaxPoint: z.string(), difference: z.string(),
    explainedBy: z.array(z.object({ journalId: uuid, journalNumber: z.number().int(), lineNo: z.number().int(), journalDate: day, taxPoint: day.nullable(), amount: z.string(), reason: z.string() })) }),
  rules: z.array(z.object({ rateId: uuid, code: z.string(), rate: z.string(), provision: z.string(), url: z.string(), verifiedBy: uuid.nullable(), verifiedAt: ts.nullable() })),
  notice: z.string(),
});

// ───────────── Sales documents (M5a) ─────────────
export const SalesSettings = z.object({ companyId: uuid, receivablesAccountId: uuid.nullable(), invoicePrefix: z.string(), creditNotePrefix: z.string(), invoiceStart: z.number().int(), creditNoteStart: z.number().int(),
  requireSeparateApprover: z.boolean(), lastInvoiceNumber: z.number().int().nullable(), lastCreditNoteNumber: z.number().int().nullable(), numberingFrozen: z.object({ invoice: z.boolean(), creditNote: z.boolean() }),
  isDefault: z.boolean(), updatedAt: ts.nullable(), updatedByUserId: uuid.nullable() });
export const SalesAllocation = z.object({ id: uuid, invoiceId: uuid, creditId: uuid.nullable(), receiptId: uuid.nullable(), amount: z.string(), invoiceFunctional: z.string(), creditFunctional: z.string(),
  realisedFx: z.string().describe('Company currency; positive = gain, negative = loss'), fxJournalId: uuid.nullable(), allocatedOn: day, createdByUserId: uuid, createdAt: ts });
const SalesDocumentBase = z.object({
  id: uuid, companyId: uuid, kind: z.enum(['INVOICE', 'CREDIT_NOTE']), status: z.enum(['DRAFT', 'APPROVED', 'DISCARDED']),
  paymentStatus: z.enum(['UNPAID', 'PART_PAID', 'PAID', 'UNALLOCATED', 'PART_ALLOCATED', 'ALLOCATED']).nullable(), number: z.number().int().nullable(), documentNumber: z.string().nullable(),
  customerRoleId: uuid, contactId: uuid, issueDate: day, supplyDate: day.nullable(), taxPoint: day, taxPointExplicit: z.boolean(), taxPointReview: z.boolean().describe('A supply date differs from the tax point: review it (statutory derivation is not automated, DEC-028)'),
  dueDate: day, currency: z.string().length(3), amountsIncludeVat: z.boolean(), customerReference: z.string().nullable(), notes: z.string().nullable(), originalInvoiceId: uuid.nullable(), creditReason: z.string().nullable(), revision: z.number().int(),
  totals: z.object({ net: z.string(), vat: z.string(), gross: z.string() }), outstanding: z.string(), functional: z.object({ gross: z.string(), outstanding: z.string() }).nullable(),
  rate: z.string().nullable(), exchangeRateId: uuid.nullable(), journalId: uuid.nullable(), contactSnapshot: ContactSnapshot.nullable(),
  duplicateOverrideReason: z.string().nullable(), creditLimitOverrideReason: z.string().nullable(), origin: z.enum(['MANUAL', 'AI_PROPOSAL']), aiProposalId: uuid.nullable(),
  createdByUserId: uuid, approvedByUserId: uuid.nullable(), approvedAt: ts.nullable(), discardedByUserId: uuid.nullable(), discardedAt: ts.nullable(), discardedReason: z.string().nullable(), createdAt: ts, updatedAt: ts,
});
export const SalesDocument = SalesDocumentBase.extend({
  lines: z.array(z.object({ lineNo: z.number().int(), description: z.string(), quantity: z.string(), unitPrice: z.string(), accountId: uuid, taxCodeId: uuid.nullable(), net: z.string(), vat: z.string(), gross: z.string() })),
  allocations: z.array(SalesAllocation), creditNotes: z.array(z.object({ id: uuid, documentNumber: z.string().nullable(), status: z.string() })),
  warnings: z.array(z.string()).describe('Draft only: VAT rates not yet usable, a credit larger than the invoice outstanding, or a customer default VAT code not applied (foreign currency)'),
});
export const SalesDocumentPage = z.object({ items: z.array(SalesDocumentBase), nextCursor: z.string().nullable() });
export const ReceivablesReconciliation = z.object({
  companyId: uuid, receivablesAccountId: uuid, functionalCurrency: z.string().length(3), reconciled: z.boolean(),
  currencies: z.array(z.object({ currency: z.string().length(3), openItems: z.string(), openItemsFunctional: z.string(),
    control: z.object({ fromSalesDocuments: z.string(), fromSalesDocumentsFunctional: z.string(), total: z.string(), totalFunctional: z.string() }),
    difference: z.string(), differenceFunctional: z.string(), otherPostings: z.array(z.object({ sourceType: z.string(), original: z.string(), functional: z.string() })) })),
});

// ───────────── Receipts, statement, aged receivables (M5b) ─────────────
export const SalesReceiptBase = z.object({
  id: uuid, companyId: uuid, customerRoleId: uuid, contactId: uuid, receiptDate: day, currency: z.string().length(3), amount: z.string(), unallocated: z.string(),
  functional: z.object({ amount: z.string(), unallocated: z.string() }), rate: z.string().nullable(), exchangeRateId: uuid.nullable(), bankAccountId: uuid, reference: z.string().nullable(), notes: z.string().nullable(),
  journalId: uuid, duplicateOverrideReason: z.string().nullable(), status: z.enum(['POSTED', 'REVERSED']), reversalJournalId: uuid.nullable(), reversedByUserId: uuid.nullable(), reversedAt: ts.nullable(), reversedReason: z.string().nullable(),
  createdByUserId: uuid, createdAt: ts,
});
export const SalesReceipt = SalesReceiptBase.extend({ allocations: z.array(SalesAllocation) });
export const SalesReceiptPage = z.object({ items: z.array(SalesReceiptBase), nextCursor: z.string().nullable() });
export const CustomerStatement = z.object({ companyId: uuid, customerRoleId: uuid, customer: ContactSnapshot, from: day, to: day,
  currencies: z.array(z.object({ currency: z.string().length(3), opening: z.string(), closing: z.string(),
    lines: z.array(z.object({ date: day, type: z.enum(['INVOICE', 'CREDIT_NOTE', 'RECEIPT', 'RECEIPT_REVERSAL']), reference: z.string().nullable(), documentId: uuid, dueDate: day.nullable(), debit: z.string(), credit: z.string(), balance: z.string() })) })) });
const AgedRow = z.object({ notDue: z.string(), days1to30: z.string(), days31to60: z.string(), days61to90: z.string(), over90: z.string(), unallocatedCredits: z.string(), total: z.string(), currency: z.string().length(3) });
export const AgedReceivables = z.object({ companyId: uuid, asOf: day, customers: z.array(AgedRow.extend({ customerRoleId: uuid, accountCode: z.string().nullable(), name: z.string().nullable() })), totals: z.array(AgedRow) });

// ───────────── Purchase documents (M6a) ─────────────
export const PurchaseSettings = z.object({ companyId: uuid, payablesAccountId: uuid.nullable(), billPrefix: z.string(), debitNotePrefix: z.string(), billStart: z.number().int(), debitNoteStart: z.number().int(),
  requireSeparateApprover: z.boolean(), lastBillNumber: z.number().int().nullable(), lastDebitNoteNumber: z.number().int().nullable(), numberingFrozen: z.object({ bill: z.boolean(), debitNote: z.boolean() }),
  isDefault: z.boolean(), updatedAt: ts.nullable(), updatedByUserId: uuid.nullable() });
export const PurchaseAllocation = z.object({ id: uuid, billId: uuid, debitId: uuid.nullable(), paymentId: uuid.nullable(), amount: z.string(), billFunctional: z.string(), debitFunctional: z.string(),
  realisedFx: z.string().describe('Company currency; positive = gain, negative = loss'), fxJournalId: uuid.nullable(), allocatedOn: day, createdByUserId: uuid, createdAt: ts });
const PurchaseDocumentBase = z.object({
  id: uuid, companyId: uuid, kind: z.enum(['BILL', 'DEBIT_NOTE']), status: z.enum(['DRAFT', 'APPROVED', 'DISCARDED']),
  paymentStatus: z.enum(['UNPAID', 'PART_PAID', 'PAID', 'UNALLOCATED', 'PART_ALLOCATED', 'ALLOCATED']).nullable(), number: z.number().int().nullable(), documentNumber: z.string().nullable().describe('Internal audit number'),
  supplierRoleId: uuid, contactId: uuid, supplierReference: z.string().nullable().describe("The supplier's own invoice (or credit note) number"), issueDate: day, supplyDate: day.nullable(), taxPoint: day, taxPointExplicit: z.boolean(), taxPointReview: z.boolean(),
  dueDate: day, currency: z.string().length(3), amountsIncludeVat: z.boolean(), notes: z.string().nullable(), originalBillId: uuid.nullable(), debitReason: z.string().nullable(), revision: z.number().int(),
  totals: z.object({ net: z.string(), vat: z.string(), gross: z.string() }), outstanding: z.string(), functional: z.object({ gross: z.string(), outstanding: z.string() }).nullable(),
  rate: z.string().nullable(), exchangeRateId: uuid.nullable(), journalId: uuid.nullable(), contactSnapshot: ContactSnapshot.nullable(), duplicateOverrideReason: z.string().nullable(),
  createdByUserId: uuid, approvedByUserId: uuid.nullable(), approvedAt: ts.nullable(), discardedByUserId: uuid.nullable(), discardedAt: ts.nullable(), discardedReason: z.string().nullable(), createdAt: ts, updatedAt: ts,
});
export const PurchaseDocument = PurchaseDocumentBase.extend({
  lines: z.array(z.object({ lineNo: z.number().int(), description: z.string(), quantity: z.string(), unitPrice: z.string(), accountId: uuid, taxCodeId: uuid.nullable(), net: z.string(), vat: z.string(), gross: z.string() })),
  allocations: z.array(PurchaseAllocation), debitNotes: z.array(z.object({ id: uuid, documentNumber: z.string().nullable(), status: z.string() })), warnings: z.array(z.string()),
});
export const PurchaseDocumentPage = z.object({ items: z.array(PurchaseDocumentBase), nextCursor: z.string().nullable() });
export const PayablesReconciliation = z.object({
  companyId: uuid, payablesAccountId: uuid, functionalCurrency: z.string().length(3), reconciled: z.boolean(),
  currencies: z.array(z.object({ currency: z.string().length(3), openItems: z.string(), openItemsFunctional: z.string(),
    control: z.object({ fromPurchaseDocuments: z.string(), fromPurchaseDocumentsFunctional: z.string(), total: z.string(), totalFunctional: z.string() }),
    difference: z.string(), differenceFunctional: z.string(), otherPostings: z.array(z.object({ sourceType: z.string(), original: z.string(), functional: z.string() })) })),
});

// ───────────── Reports (M8) ─────────────
const ReportAccount = z.object({ accountId: uuid, code: z.string(), name: z.string(), amount: z.string(),
  drilldown: z.object({ accountId: uuid, from: day.nullable(), to: day, excludeClosing: z.boolean().optional().describe('P&L lines: leave closing journals out, as the figure does') }).describe('Opens the general ledger of the account for the range') });
const ReportLine = z.object({ key: z.string(), name: z.string(), amount: z.string(), comparative: z.string().optional(), total: z.boolean().optional(), accounts: z.array(ReportAccount).optional(), drilldown: z.record(z.unknown()).optional() });
export const ProfitAndLoss = z.object({
  companyId: uuid, companyName: z.string(), currency: z.string().length(3), from: day, to: day, comparative: z.object({ from: day, to: day }).nullable(), mappingVersion: z.number().int(),
  lines: z.array(ReportLine), profitForPeriod: z.string(),
  reconciliation: z.object({ incomeLessExpensesFromLedger: z.string(), difference: z.string(), reconciled: z.boolean(), comparative: z.object({ incomeLessExpensesFromLedger: z.string(), reconciled: z.boolean() }).optional() }).describe('The P&L against the net of every income and expense account: must reconcile to the cent'),
  notice: z.string(),
});
const BsProof = z.object({ netAssets: z.string(), capitalAndReserves: z.string(), difference: z.string(), balanced: z.boolean(),
  trialBalance: z.object({ debit: z.string(), credit: z.string(), balanced: z.boolean() }).describe('The whole ledger, year-end closing journals included'),
  closedToRetainedEarnings: z.string().describe('What year-end closing journals moved to retained earnings up to the date; the lines leave them out, so they read the same before and after a close (DEC-060)') });
export const BalanceSheet = z.object({
  companyId: uuid, companyName: z.string(), currency: z.string().length(3), asOf: day, compareAsOf: day.nullable(), financialYearStart: day.nullable(), mappingVersion: z.number().int(),
  lines: z.array(ReportLine), netAssets: z.string(), reconciliation: BsProof.extend({ comparative: BsProof.optional() }), notice: z.string(),
});
const FxSummary = z.object({ total: z.string(), byCurrency: z.array(z.object({ currency: z.string(), gain: z.string() })),
  journals: z.array(z.object({ journalId: uuid, journalNumber: z.number().int(), journalDate: day, sourceType: z.string(), currency: z.string().nullable(), gain: z.string() })) });
export const FxReport = z.object({ companyId: uuid, currency: z.string().length(3), from: day, to: day, realised: FxSummary, unrealised: FxSummary, revaluedAtClosingRate: z.boolean(), notice: z.string(),
  openBalances: z.array(z.object({ accountId: uuid, accountCode: z.string(), accountName: z.string(), currency: z.string(), originalBalance: z.string(), carryingAmount: z.string(), closingRate: z.string().nullable(),
    rateId: uuid.nullable(), atClosingRate: z.string().nullable(), unrevaluedDifference: z.string().nullable(), rateError: z.string().nullable() })) });
export const JournalSource = z.object({
  journal: z.object({ id: uuid, journalNumber: z.number().int(), journalDate: day, sourceType: z.string(), sourceId: z.string().nullable(), sourceReference: z.string().nullable(), description: z.string(), total: z.string(), postedByUserId: uuid.nullable(), reversesJournalId: uuid.nullable() }),
  lines: z.array(z.object({ lineNo: z.number().int(), accountId: uuid, accountCode: z.string().nullable(), accountName: z.string().nullable(), debit: z.string(), credit: z.string(), description: z.string().nullable(), drilldown: z.record(z.unknown()) })),
  source: z.record(z.unknown()).nullable().describe('The transaction that posted the journal (document, receipt, payment, cash transaction, transfer, request, revaluation, reversed journal) with its attachments; restricted when the reader may not see that module'),
  sourceResolver: z.string(), journalAttachments: z.array(z.record(z.unknown())), bankMatches: z.array(z.object({ id: uuid, statementLineId: uuid, journalLineId: uuid, amount: z.string() })),
});
export const AlertList = z.object({ companyId: uuid, asOf: day, thresholds: z.object({ draftDays: z.number().int(), unmatchedDays: z.number().int() }), count: z.number().int(), high: z.number().int(),
  alerts: z.array(z.object({ code: z.string(), severity: z.enum(['HIGH', 'MEDIUM', 'LOW']), title: z.string(), count: z.number().int(), total: z.string().optional(), oldestDate: day.nullable().optional(), items: z.array(z.record(z.unknown())) })) });

// ───────────── Bank (M7a) ─────────────
export const BankAccountView = z.object({
  id: uuid, companyId: uuid, accountId: uuid, accountCode: z.string(), accountName: z.string(), name: z.string(), bankName: z.string().nullable(), currency: z.string().length(3),
  detailsMasked: z.string().nullable().describe('Sort code, account number, IBAN and BIC are stored encrypted; only this masked form is listed'),
  statementOpeningDate: day, statementOpeningBalance: z.string(), chargesAccountId: uuid.nullable(), interestReceivedAccountId: uuid.nullable(), interestPaidAccountId: uuid.nullable(),
  ledgerBalance: z.string().describe('Balance of the ledger account in the account currency'),
  statement: z.object({ lines: z.number().int(), balance: z.string().describe('Statement opening balance plus every imported line'), lastDate: day.nullable(), unmatchedLines: z.number().int() }),
  status: z.enum(['ACTIVE', 'CLOSED']), closedAt: ts.nullable(), closedReason: z.string().nullable(), createdByUserId: uuid, createdAt: ts,
});
export const BankAccountList = z.object({ items: z.array(BankAccountView) });
export const BankAccountDetails = z.object({ id: uuid, details: z.object({ sortCode: z.string().optional(), accountNumber: z.string().optional(), iban: z.string().optional(), bic: z.string().optional() }).nullable() });
export const StatementImport = z.object({
  id: uuid, companyId: uuid, bankAccountId: uuid, documentId: uuid, documentVersionId: uuid, fileSha256: z.string(), mapping: z.record(z.unknown()),
  status: z.enum(['QUEUED', 'COMPLETED', 'FAILED', 'VOID']), jobId: uuid.nullable().describe('The job record (GET /jobs/{jobId}) with progress, attempts and failures'),
  rowsRead: z.number().int().nullable(), rowsImported: z.number().int().nullable(), rowsDuplicate: z.number().int().nullable().describe('Lines already present (overlapping statements), skipped'),
  errors: z.array(z.object({ row: z.number().int(), message: z.string() })).describe('Why a FAILED import stored nothing (at most 100)'),
  firstDate: day.nullable(), lastDate: day.nullable(), openingBalance: z.string().nullable(), closingBalance: z.string().nullable(), duplicateOverrideReason: z.string().nullable(),
  requestedByUserId: uuid, requestedAt: ts, completedAt: ts.nullable(), voidedByUserId: uuid.nullable(), voidedAt: ts.nullable(), voidReason: z.string().nullable(),
});
export const StatementImportPage = z.object({ items: z.array(StatementImport), nextCursor: z.string().nullable() });
export const StatementLinePage = z.object({ currency: z.string().length(3), nextCursor: z.string().nullable(), items: z.array(z.object({
  id: uuid, bankAccountId: uuid, importId: uuid, lineNo: z.number().int(), sourceRow: z.number().int(), date: day, description: z.string(), reference: z.string().nullable(),
  amount: z.string().describe('Signed: positive = money in'), balance: z.string().nullable(), matched: z.string(), unmatched: z.string(), status: z.enum(['UNMATCHED', 'PARTIAL', 'MATCHED', 'VOID']) })) });
export const BankTransferBase = z.object({
  id: uuid, companyId: uuid, fromAccountId: uuid, toAccountId: uuid, transferDate: day, currency: z.string().length(3), amount: z.string(), reference: z.string().nullable(), description: z.string(), journalId: uuid,
  duplicateOverrideReason: z.string().nullable(), status: z.enum(['POSTED', 'REVERSED']), reversalJournalId: uuid.nullable(), reversedByUserId: uuid.nullable(), reversedAt: ts.nullable(), reversedReason: z.string().nullable(),
  createdByUserId: uuid, createdAt: ts,
});
export const BankTransferPage = z.object({ items: z.array(BankTransferBase), nextCursor: z.string().nullable() });

export const StatementLineDetail = z.object({
  id: uuid, bankAccountId: uuid, importId: uuid, lineNo: z.number().int(), sourceRow: z.number().int(), date: day, description: z.string(), reference: z.string().nullable(),
  amount: z.string(), balance: z.string().nullable(), matched: z.string(), unmatched: z.string(), status: z.enum(['UNMATCHED', 'PARTIAL', 'MATCHED', 'VOID']),
  matches: z.array(z.object({ id: uuid, journalLineId: uuid, journalId: uuid, journalNumber: z.number().int().nullable(), journalDate: day.nullable(), sourceType: z.string().nullable(), amount: z.string(),
    kind: z.enum(['MANUAL', 'SUGGESTION', 'POSTED_FROM_STATEMENT']), overrideReason: z.string().nullable(), status: z.enum(['ACTIVE', 'UNMATCHED']), unmatchReason: z.string().nullable(),
    afterSignOff: z.boolean().describe('Undone although a signed-off reconciliation covered it'), createdByUserId: uuid, createdAt: ts, unmatchedAt: ts.nullable() })),
});
export const MatchSuggestions = z.object({ bankAccountId: uuid, currency: z.string().length(3), notice: z.string(), items: z.array(z.object({
  statementLineId: uuid, date: day, description: z.string(), reference: z.string().nullable(), unmatched: z.string(), ambiguous: z.boolean(),
  candidates: z.array(z.object({ journalLineId: uuid, journalId: uuid, journalNumber: z.number().int(), date: day, sourceType: z.string(), reference: z.string().nullable(), description: z.string().nullable(), amount: z.string(), score: z.number(), reasons: z.array(z.string()) })),
  proposal: z.object({ kind: z.enum(['CHARGE', 'INTEREST']), accountId: uuid.nullable() }).nullable() })) });
const AgedItems = z.object({ count: z.number().int(), total: z.string(), buckets: z.record(z.object({ count: z.number().int(), total: z.string() })), items: z.array(z.record(z.unknown())) });
export const UnmatchedItems = z.object({ bankAccountId: uuid, currency: z.string().length(3), asOf: day, statement: AgedItems, ledger: AgedItems });
export const ReconciliationReport = z.object({
  bankAccountId: uuid, currency: z.string().length(3), asOf: day, statementBalance: z.string(), unmatchedStatement: z.string(), adjustedStatement: z.string(), ledgerBalance: z.string(), unmatchedLedger: z.string(),
  adjustedLedger: z.string(), difference: z.string(), opening: z.object({ date: day, statement: z.string(), ledger: z.string() }), reconciled: z.boolean(), unmatchedStatementLines: z.number().int(), unmatchedLedgerLines: z.number().int(),
  lastSignOff: z.object({ id: uuid, asAt: day, signedByUserId: uuid, signedAt: ts }).nullable(), explanation: z.string(),
  signOff: z.object({ id: uuid, asAt: day, signedByUserId: uuid }).optional(),
});
export const SignOffList = z.object({ items: z.array(z.object({ id: uuid, asAt: day, bankClosingBalance: z.string(), statementBalance: z.string(), ledgerBalance: z.string(), unmatchedStatement: z.string(), unmatchedLedger: z.string(),
  unmatchedStatementLines: z.number().int(), unmatchedLedgerLines: z.number().int(), notes: z.string().nullable(), signedByUserId: uuid, signedAt: ts })) });
export const PostedFromStatement = z.object({ cashTransaction: z.record(z.unknown()), line: StatementLineDetail });

// ───────────── Cash transactions (M6c) ─────────────
export const BalanceWarning = z.object({ accountId: uuid, accountCode: z.string(), kind: z.enum(['BANK', 'CASH']), lowestBalance: z.string(), onDate: day,
  overridden: z.boolean().describe('Cash in hand: true when the person gave a negativeCashReason (otherwise the posting is refused)') })
  .describe('DEC-036/037: an account this posting lowers that is below zero on its date or a later date. A bank account is a warning (overdraft); cash in hand needs a reason');
export const CashTransactionBase = z.object({
  id: uuid, companyId: uuid, direction: z.enum(['PAYMENT', 'RECEIPT']), transactionDate: day, taxPoint: day.nullable(), bankAccountId: uuid, contactId: uuid.nullable(), counterparty: z.string().nullable(),
  reference: z.string().nullable(), description: z.string(), currency: z.string().length(3), amountsIncludeVat: z.boolean(), net: z.string(), vat: z.string(), gross: z.string(), journalId: uuid,
  duplicateOverrideReason: z.string().nullable(), status: z.enum(['POSTED', 'REVERSED']), reversalJournalId: uuid.nullable(), reversedByUserId: uuid.nullable(), reversedAt: ts.nullable(), reversedReason: z.string().nullable(),
  createdByUserId: uuid, createdAt: ts,
});
export const CashTransaction = CashTransactionBase.extend({
  lines: z.array(z.object({ lineNo: z.number().int(), description: z.string(), accountId: uuid, taxCodeId: uuid.nullable(), amount: z.string(), net: z.string(), vat: z.string(), gross: z.string() })),
  balanceWarnings: z.array(BalanceWarning).optional().describe('Returned when recording or reversing'),
});
export const CashTransactionPage = z.object({ items: z.array(CashTransactionBase), nextCursor: z.string().nullable() });
export const BankTransfer = BankTransferBase.extend({ balanceWarnings: z.array(BalanceWarning).optional().describe('Returned when recording or reversing') });

// ───────────── Supplier payments, statement, aged payables (M6b) ─────────────
export const PurchasePaymentBase = z.object({
  id: uuid, companyId: uuid, supplierRoleId: uuid, contactId: uuid, paymentDate: day, currency: z.string().length(3), amount: z.string(), unallocated: z.string(),
  functional: z.object({ amount: z.string(), unallocated: z.string() }), rate: z.string().nullable(), exchangeRateId: uuid.nullable(), bankAccountId: uuid, reference: z.string().nullable(), notes: z.string().nullable(),
  journalId: uuid, duplicateOverrideReason: z.string().nullable(), bankDetailsUnverified: z.boolean().describe("The supplier's stored bank details were UNVERIFIED when the payment was recorded (DEC-035): review it"),
  status: z.enum(['POSTED', 'REVERSED']), reversalJournalId: uuid.nullable(), reversedByUserId: uuid.nullable(), reversedAt: ts.nullable(), reversedReason: z.string().nullable(), createdByUserId: uuid, createdAt: ts,
});
export const PurchasePayment = PurchasePaymentBase.extend({ allocations: z.array(PurchaseAllocation) });
export const PurchasePaymentPage = z.object({ items: z.array(PurchasePaymentBase), nextCursor: z.string().nullable() });
export const SupplierStatement = z.object({ companyId: uuid, supplierRoleId: uuid, supplier: ContactSnapshot, from: day, to: day,
  currencies: z.array(z.object({ currency: z.string().length(3), opening: z.string(), closing: z.string().describe('Owed to the supplier (credit-normal)'),
    lines: z.array(z.object({ date: day, type: z.enum(['BILL', 'DEBIT_NOTE', 'PAYMENT', 'PAYMENT_REVERSAL']), reference: z.string().nullable(), documentNumber: z.string().nullable(), documentId: uuid, dueDate: day.nullable(), debit: z.string(), credit: z.string(), balance: z.string() })) })) });
const AgedPRow = z.object({ notDue: z.string(), days1to30: z.string(), days31to60: z.string(), days61to90: z.string(), over90: z.string(), unallocatedDebits: z.string(), total: z.string(), currency: z.string().length(3) });
export const AgedPayables = z.object({ companyId: uuid, asOf: day, suppliers: z.array(AgedPRow.extend({ supplierRoleId: uuid, accountCode: z.string().nullable(), name: z.string().nullable() })), totals: z.array(AgedPRow) });


// ───────────── V2-M1 reporting framework (DEC-052, DEC-053, DEC-055) ─────────────
const source = z.object({ url: z.string(), provision: z.string(), retrievedOn: day });
const versionStatus = z.enum(['UNVERIFIED', 'VERIFIED', 'SUPERSEDED']).describe('UNVERIFIED content gives previews only; VERIFIED is immutable; SUPERSEDED was replaced by a new version');
const sizes = z.array(z.enum(['MICRO', 'SMALL', 'MEDIUM', 'LARGE']));
export const StandardVersion = z.object({
  id: uuid, standardId: uuid, label: z.string(), effectiveFrom: day, effectiveTo: day.nullable(), source, notes: z.string().nullable(), status: versionStatus, copiedFromId: uuid.nullable(),
  createdByUserId: uuid, createdAt: ts, verifiedByUserId: uuid.nullable(), verifiedAt: ts.nullable(), verificationNotes: z.string().nullable(), supersededById: uuid.nullable(),
  turnoverLineKey: z.string().nullable().describe('V2-M5b: the P&L line the size test reads as turnover'),
  cashFlowAppliesTo: sizes.describe('V2-M5c: the entity sizes whose accounts include the cash flow statement (empty: none)'),
  cashFlowCaptions: z.record(z.string()).nullable().describe('V2-M5c: profit, operating, investing, financing, netChange, opening, closing'),
});
export const StatutoryLine = z.object({
  id: uuid, key: z.string(), statement: z.enum(['PL', 'BS']), parentKey: z.string().nullable(), sort: z.number().int(), name: z.string(), kind: z.enum(['ACCOUNTS', 'TOTAL', 'RETAINED_PROFIT']),
  naturalSide: z.enum(['DEBIT', 'CREDIT']).nullable(), formula: z.array(z.object({ line: z.string(), sign: z.number().int() })).nullable().describe('A TOTAL: the signed lines it adds up'),
});
export const StatutoryMapEntry = z.object({ id: uuid, sourceLine: z.string().describe('V1 reporting line'), accountSubtype: z.string().nullable(), targetKey: z.string() });
export const ValidationRuleView = z.object({ id: uuid, key: z.string(), description: z.string(), severity: z.enum(['ERROR', 'WARNING']), appliesTo: sizes, expression: z.record(z.unknown()).describe('Closed grammar (v2-plan 3.3)') });
export const DisclosureRuleView = z.object({ id: uuid, key: z.string(), title: z.string(), appliesTo: sizes, requires: z.object({ lines: z.array(z.string()).optional(), facts: z.array(z.string()).optional() }),
  section: z.enum(['POLICIES', 'NOTES', 'DIRECTORS_REPORT', 'BALANCE_SHEET_STATEMENTS']), sort: z.number().int(), body: z.string().nullable().describe('Wording in the template grammar (V2-M5a)'), omitWhenEmpty: z.boolean() });
export const ReportingStandard = z.object({ id: uuid, code: z.string(), name: z.string(), createdByUserId: uuid, createdAt: ts,
  versions: z.array(z.object({ id: uuid, label: z.string(), effectiveFrom: day, effectiveTo: day.nullable(), status: versionStatus })) });
export const CashFlowClassView = z.object({ id: uuid, key: z.string(), section: z.enum(['OPERATING', 'INVESTING', 'FINANCING']), sort: z.number().int(), name: z.string(),
  adjustmentName: z.string().nullable().describe('Investing and financing: the caption of the non-cash part, among the operating adjustments'), inflowName: z.string().nullable(), outflowName: z.string().nullable() });
export const CashFlowMapEntryView = z.object({ id: uuid, sourceLine: z.string().describe('V1 reporting line'), accountSubtype: z.string().nullable(), target: z.string().describe('A cash-flow class key, or CASH') });
export const StandardVersionDetail = StandardVersion.extend({
  standard: z.object({ id: uuid, code: z.string(), name: z.string() }), lines: z.array(StatutoryLine), mapEntries: z.array(StatutoryMapEntry), validationRules: z.array(ValidationRuleView), disclosureRules: z.array(DisclosureRuleView),
  cashFlowClasses: z.array(CashFlowClassView), cashFlowMapEntries: z.array(CashFlowMapEntryView),
  problems: z.array(z.string()).describe('What stops the version from being verified (empty when consistent)'),
});
export const ContentRemoved = z.object({ id: uuid, removed: z.literal(true) });
export const ReportingFramework = z.object({
  id: uuid, companyId: uuid, yearStart: day, yearEnd: day, versionId: uuid, entitySize: z.enum(['MICRO', 'SMALL', 'MEDIUM', 'LARGE']), reason: z.string(), chosenByUserId: uuid, chosenAt: ts, lockedAt: ts.nullable(),
  version: z.object({ label: z.string(), status: versionStatus, standardId: uuid }).optional(),
});
export const StatutoryOverride = z.object({ id: uuid, companyId: uuid, versionId: uuid, accountId: uuid, targetKey: z.string(), reason: z.string(), createdByUserId: uuid, createdAt: ts,
  endedAt: ts.nullable(), endedByUserId: uuid.nullable(), endedReason: z.string().nullable() });
const amount = z.string().nullable().describe('Exact decimal; null when a total cannot be computed (see problems)');
const statutoryLineOut = z.object({
  key: z.string(), name: z.string(), statement: z.enum(['PL', 'BS']), kind: z.enum(['ACCOUNTS', 'TOTAL', 'RETAINED_PROFIT']), parentKey: z.string().nullable(), depth: z.number().int(), amount, comparative: amount.optional(),
  accounts: z.array(z.object({ accountId: uuid, code: z.string(), name: z.string(), amount: z.string(), drilldown: z.object({ accountId: uuid, from: day.nullable(), to: day }) })).optional(),
});
const unplaced = z.object({ accountId: uuid, code: z.string(), name: z.string(), type: z.string(), reportingLine: z.string(), subtype: z.string(), reason: z.enum(['unmapped', 'statement_mismatch']), targetKey: z.string().nullable(),
  net: z.string().describe('Debits less credits'), drilldown: z.object({ accountId: uuid, from: day.nullable(), to: day }) });
const statutoryProof = z.object({
  profitAndLoss: z.object({ profitFromLedger: z.string(), profitFromLines: z.string(), difference: z.string(), reconciled: z.boolean() }),
  balanceSheet: z.object({ difference: z.string(), balanced: z.boolean() }),
  trialBalance: z.object({ debit: z.string(), credit: z.string(), balanced: z.boolean() }),
});
export const StatutoryPreview = z.object({
  companyId: uuid, companyName: z.string(), currency: z.string(),
  year: z.object({ start: day, end: day, entitySize: z.enum(['MICRO', 'SMALL', 'MEDIUM', 'LARGE']), frameworkId: uuid }),
  comparative: z.object({ start: day, end: day, fromFramework: z.boolean() }).nullable(),
  standard: z.object({ id: uuid, code: z.string(), name: z.string() }),
  version: z.object({ id: uuid, label: z.string(), status: versionStatus, effectiveFrom: day, effectiveTo: day.nullable(), source }),
  verified: z.boolean().describe('false: a preview from unverified rules (DEC-052)'),
  statements: z.object({ profitAndLoss: z.array(statutoryLineOut), balanceSheet: z.array(statutoryLineOut) }),
  unplacedAccounts: z.array(unplaced), comparativeUnplacedAccounts: z.array(unplaced).optional(), overridesApplied: z.number().int(),
  validations: z.array(z.object({ key: z.string(), description: z.string(), severity: z.enum(['ERROR', 'WARNING']), passed: z.boolean(), error: z.string().nullable() })),
  validationSummary: z.object({ errors: z.number().int(), warnings: z.number().int() }),
  reconciliation: statutoryProof.extend({ comparative: statutoryProof.optional() }),
  problems: z.array(z.string()), notices: z.array(z.string()),
});

// ───────────── V2-M2 fixed assets (DEC-058) ─────────────
const money2 = z.string().describe('Exact decimal');
const methodE = z.enum(['STRAIGHT_LINE', 'REDUCING_BALANCE']), conventionE = z.enum(['DAILY', 'MONTHLY']);
export const AssetClass = z.object({ id: uuid, companyId: uuid, code: z.string(), name: z.string(), costAccountId: uuid, depreciationAccountId: uuid, expenseAccountId: uuid, disposalAccountId: uuid,
  method: methodE, lifeMonths: z.number().int().nullable(), ratePercent: z.string().nullable(), residualPercent: z.string(), convention: conventionE, createdByUserId: uuid, createdAt: ts, updatedAt: ts });
const assetBase = {
  id: uuid, companyId: uuid, classId: uuid, number: z.number().int(), description: z.string(), acquiredOn: day, inUseFrom: day, cost: money2, additionKind: z.enum(['POSTED', 'LINKED', 'TAKE_ON']),
  additionJournalId: uuid.nullable(), offsetAccountId: uuid.nullable(), takeOnDate: day.nullable(), takeOnAccumulated: money2, status: z.enum(['ACTIVE', 'DISPOSED', 'VOID']), additionReversalJournalId: uuid.nullable(),
  disposedOn: day.nullable(), proceeds: money2.nullable(), proceedsAccountId: uuid.nullable(), disposalJournalId: uuid.nullable(), disposalCatchUp: money2.nullable(), gainOrLoss: money2.nullable().describe('Proceeds less carrying amount (negative: a loss)'),
  tax: z.object({ category: z.enum(['AIA', 'MAIN_POOL', 'SPECIAL_RATE_POOL', 'SINGLE_ASSET_POOL', 'NOT_QUALIFYING', 'UNDECIDED']), cost: money2.nullable() }).describe('Kept apart for capital allowances (V4); never read by depreciation'),
  createdByUserId: uuid, createdAt: ts,
};
export const FixedAssetSummary = z.object(assetBase);
export const FixedAssetDetail = z.object({ ...assetBase, classCode: z.string(), accumulatedDepreciation: money2, carryingAmount: money2, lastChargedOn: day.nullable(),
  bases: z.array(z.object({ id: uuid, effectiveFrom: day, carryingAmount: money2, accumulatedBefore: money2, method: methodE, lifeMonths: z.number().int().nullable(), ratePercent: z.string().nullable(), residual: money2,
    convention: conventionE, reason: z.string(), createdByUserId: uuid, createdAt: ts })).describe('Depreciation bases, append-only; a change of estimate adds one prospectively'),
  charges: z.array(z.object({ runId: uuid, asAt: day, amount: money2 })) });
const runBase = { id: uuid, companyId: uuid, asAt: day, status: z.enum(['POSTED', 'REVERSED']), journalId: uuid.nullable(), reversalJournalId: uuid.nullable(), total: money2, createdByUserId: uuid, createdAt: ts,
  reversedByUserId: uuid.nullable(), reversedAt: ts.nullable(), reversedReason: z.string().nullable() };
export const DepreciationRunSummary = z.object(runBase);
export const DepreciationRunDetail = z.object({ ...runBase, lines: z.array(z.object({ assetId: uuid, number: z.number().int(), description: z.string(), classId: uuid, amount: money2, accumulatedAfter: money2 })) });
export const DepreciationPreview = z.object({ companyId: uuid, asAt: day, total: money2,
  lines: z.array(z.object({ assetId: uuid, number: z.number().int(), description: z.string(), classCode: z.string(), amount: money2, accumulatedAfter: money2, carryingAfter: money2 })),
  classes: z.array(z.object({ classId: uuid, code: z.string(), expenseAccountId: uuid, depreciationAccountId: uuid, amount: money2 })) });
export const FixedAssetRegister = z.object({ companyId: uuid, currency: z.string(), asAt: day,
  classes: z.array(z.object({ classId: uuid, code: z.string(), name: z.string(), cost: money2, accumulatedDepreciation: money2, carryingAmount: money2,
    assets: z.array(z.object({ id: uuid, number: z.number().int(), description: z.string(), status: z.enum(['ACTIVE', 'DISPOSED']), acquiredOn: day, cost: money2, accumulatedDepreciation: money2, carryingAmount: money2,
      disposedOn: day.optional(), proceeds: money2.optional(), gainOrLoss: money2.optional() })) })),
  reconciliation: z.array(z.object({ accountId: uuid, code: z.string(), kind: z.enum(['COST', 'DEPRECIATION']), register: money2, ledger: money2, difference: money2.describe('Register less ledger'), reconciled: z.boolean(),
    items: z.array(z.object({ journalId: uuid, journalNumber: z.number().int(), journalDate: day, sourceType: z.string(), description: z.string(), amount: money2, registered: money2, unregistered: money2 })).describe('Postings on the account not made or linked by the register') })),
  reconciled: z.boolean() });

// ───────────── V2-M3a year-end adjustments (DEC-059) ─────────────
const amt = z.string().describe('Exact decimal');
export const YearEndItem = z.object({
  id: uuid, companyId: uuid, kind: z.enum(['ACCRUAL', 'ACCRUED_INCOME', 'PREPAYMENT', 'DEFERRED_INCOME']), description: z.string(), amount: amt, plAccountId: uuid, balanceAccountId: uuid, date: day,
  periodStart: day.nullable(), periodEnd: day.nullable(), convention: z.enum(['DAILY', 'MONTHLY']).nullable(), setupKind: z.enum(['POSTED', 'LINKED']).nullable(), setupJournalId: uuid.nullable(),
  accrualJournalId: uuid.nullable(), autoReversalJournalId: uuid.nullable(), status: z.enum(['ACTIVE', 'CANCELLED']), cancellationJournalIds: z.array(uuid), cancelledByUserId: uuid.nullable(), cancelledAt: ts.nullable(),
  cancelledReason: z.string().nullable(), basis: z.string().nullable(), evidenceDocumentIds: z.array(uuid), createdByUserId: uuid, createdAt: ts, released: amt.optional(), unreleased: amt.optional(),
});
const rrBase = { id: uuid, companyId: uuid, asAt: day, status: z.enum(['POSTED', 'REVERSED']), journalId: uuid, reversalJournalId: uuid.nullable(), total: amt, createdByUserId: uuid, createdAt: ts,
  reversedByUserId: uuid.nullable(), reversedAt: ts.nullable(), reversedReason: z.string().nullable() };
export const ReleaseRunSummary = z.object(rrBase);
export const ReleaseRunDetail = z.object({ ...rrBase, lines: z.array(z.object({ itemId: uuid, kind: z.string(), description: z.string(), amount: amt, releasedAfter: amt })) });
export const ReleasePreview = z.object({ companyId: uuid, asAt: day, total: amt, lines: z.array(z.object({ itemId: uuid, kind: z.string(), description: z.string(), amount: amt, releasedAfter: amt, unreleasedAfter: amt })) });
export const ProvisionView = z.object({ id: uuid, companyId: uuid, name: z.string(), accountId: uuid, expenseAccountId: uuid, basis: z.string(), evidenceDocumentIds: z.array(uuid), createdByUserId: uuid, createdAt: ts,
  balance: amt, movements: z.array(z.object({ id: uuid, provisionId: uuid, kind: z.enum(['MADE', 'USED', 'RELEASED']), date: day, amount: amt, offsetAccountId: uuid.nullable(), reason: z.string(), journalId: uuid,
    status: z.enum(['POSTED', 'REVERSED']), reversalJournalId: uuid.nullable(), reversedByUserId: uuid.nullable(), reversedAt: ts.nullable(), reversedReason: z.string().nullable(), createdByUserId: uuid, createdAt: ts })) });
export const ProvisionReport = z.object({ companyId: uuid, from: day, to: day,
  provisions: z.array(z.object({ provisionId: uuid, name: z.string(), basis: z.string(), opening: amt, made: amt, used: amt, released: amt, closing: amt })) });
export const YearEndRegister = z.object({ companyId: uuid, asAt: day,
  items: z.array(z.object({ id: uuid, kind: z.string(), description: z.string(), amount: amt, balanceAccountId: uuid, balance: amt })),
  provisions: z.array(z.object({ id: uuid, name: z.string(), accountId: uuid, balance: amt })),
  reconciliation: z.array(z.object({ accountId: uuid, code: z.string(), register: amt, ledger: amt.describe('Assets debit-positive, liabilities credit-positive'), difference: amt, reconciled: z.boolean(),
    items: z.array(z.object({ journalId: uuid, journalNumber: z.number().int(), journalDate: day, sourceType: z.string(), description: z.string(), amount: amt, registered: amt, unregistered: amt })) })),
  reconciled: z.boolean() });

// ───────────── V2-M3b year-end closing journal (DEC-060) ─────────────
const closeBase = { id: uuid, companyId: uuid, yearStart: day, yearEnd: day, status: z.enum(['POSTED', 'REVERSED']), profit: amt.describe('Credited to retained earnings; a loss is negative'), retainedEarningsAccountId: uuid,
  journalId: uuid, reversalJournalId: uuid.nullable(), createdByUserId: uuid, createdAt: ts, reversedByUserId: uuid.nullable(), reversedAt: ts.nullable(), reversedReason: z.string().nullable() };
export const YearEndCloseSummary = z.object(closeBase);
export const YearEndCloseDetail = z.object({ ...closeBase,
  yearIncomeLessExpensesIncludingClose: amt.describe('The year\'s income less expenses with every journal included: zero while the close is live'),
  lines: z.array(z.object({ lineNo: z.number().int(), accountId: uuid, code: z.string().nullable(), name: z.string().nullable(), debit: amt, credit: amt, description: z.string().nullable() })) });
export const YearEndClosePreview = z.object({ companyId: uuid, yearStart: day, yearEnd: day, journalDate: day, retainedEarningsAccountId: uuid.nullable(), profit: amt,
  lines: z.array(z.object({ accountId: uuid, code: z.string(), name: z.string(), debit: amt, credit: amt })),
  warnings: z.array(z.enum(['earlier_years_not_closed'])), canPost: z.boolean(), blockers: z.array(z.object({ code: z.string(), message: z.string() })), notice: z.string() });

// ───────────── V2-M4 director and shareholder loan accounts, related parties (DEC-062) ─────────────
const loanBase = { id: uuid, companyId: uuid, contactId: uuid, contactName: z.string().nullable(), kind: z.enum(['DIRECTOR', 'SHAREHOLDER', 'DIRECTOR_AND_SHAREHOLDER']), accountId: uuid,
  accountCode: z.string().nullable(), accountName: z.string().nullable(), openedOn: day, notes: z.string().nullable(), status: z.enum(['ACTIVE', 'CLOSED']), closedOn: day.nullable(),
  closedReason: z.string().nullable(), closedByUserId: uuid.nullable(), createdByUserId: uuid, createdAt: ts };
const loanCategory = z.enum(['CASH_AND_BANK', 'EXPENSES', 'INCOME', 'DIVIDENDS', 'OTHER_LOAN_ACCOUNT', 'OTHER', 'MIXED']);
const loanFlag = z.enum(['OVERDRAWN_AT_END', 'OVERDRAWN_IN_PERIOD', 'LARGE_MOVEMENT', 'OVERDRAWN_ABOVE_THRESHOLD']);
const loanSummary = { from: day, to: day, opening: amt.describe('Credit-positive: negative means overdrawn'), closing: amt, lowest: amt, lowestOn: day, daysOverdrawn: z.number().int(),
  byCategory: z.array(z.object({ category: loanCategory, amount: amt })), flags: z.array(loanFlag).describe('Review prompts on the firm\'s thresholds, not legal conclusions'),
  notEvaluated: z.array(loanFlag).describe('Flags whose threshold is not set: never treated as passed'), largeMovementJournalIds: z.array(uuid),
  thresholds: z.object({ largeMovement: amt.nullable(), overdrawn: amt.nullable(), setAt: ts }).nullable(), drilldown: z.object({ accountId: uuid, from: day, to: day }), notice: z.string() };
export const LoanAccount = z.object(loanBase);
export const LoanAccountStatement = z.object({ ...loanBase, statement: z.object({ ...loanSummary,
  movements: z.array(z.object({ journalId: uuid, journalNumber: z.number().int(), date: day, sourceType: z.string(), description: z.string(), amount: amt, category: loanCategory, balance: amt })) }) });
export const LoanAccountReport = z.object({ companyId: uuid, from: day, to: day, flagged: z.number().int(), items: z.array(z.object({ ...loanBase, ...loanSummary, movementCount: z.number().int() })) });
const thresholdRow = z.object({ id: uuid, largeMovement: amt.nullable(), overdrawn: amt.nullable(), reason: z.string(), setByUserId: uuid, setAt: ts });
export const LoanThresholds = z.object({ current: thresholdRow.nullable(), history: z.array(thresholdRow), notice: z.string() });
export const RelatedParty = z.object({ id: uuid, companyId: uuid, contactId: uuid, contactName: z.string().nullable(), relationship: z.string(), description: z.string(), fromDate: day, toDate: day.nullable(),
  status: z.enum(['ACTIVE', 'ENDED']), endedReason: z.string().nullable(), endedByUserId: uuid.nullable(), endedAt: ts.nullable(), createdByUserId: uuid, createdAt: ts });
const rpFigure = z.object({ amount: amt, journals: z.array(z.object({ journalId: uuid, journalNumber: z.number().int(), journalDate: day, sourceType: z.string(), amount: amt })) });
export const RelatedPartyReport = z.object({ companyId: uuid, from: day, to: day, notice: z.string(),
  items: z.array(RelatedParty.extend({ figures: z.object({ sales: rpFigure, purchases: rpFigure, cashPaid: rpFigure, cashReceived: rpFigure, owedBy: rpFigure, owedTo: rpFigure,
    loanAccounts: z.array(z.object({ id: uuid, accountId: uuid, closing: amt, lowest: amt, flags: z.array(loanFlag) })) }) })) });

// ───────────── V2-M5a the accounts document (DEC-063) ─────────────
const factRow = z.object({ id: uuid, key: z.string(), value: z.string(), reason: z.string(), setByUserId: uuid, setAt: ts });
export const AccountsFacts = z.object({ yearStart: day, frameworkId: uuid, current: z.array(factRow), history: z.array(factRow) });
const docBlock = z.union([z.object({ type: z.literal('text'), text: z.string() }), z.object({ type: z.literal('table'), key: z.string(), columns: z.array(z.string()), rows: z.array(z.array(z.string())) })]);
export const AccountsDocument = z.object({
  companyId: uuid, companyName: z.string(), companyNumber: z.string().nullable(), currency: z.string(),
  year: z.object({ start: day, end: day, priorEnd: day, entitySize: z.enum(['MICRO', 'SMALL', 'MEDIUM', 'LARGE']), frameworkId: uuid }),
  standard: StatutoryPreview.shape.standard, version: StatutoryPreview.shape.version, verified: z.boolean().describe('false: wording and statements from unverified rules (DEC-052)'),
  statements: StatutoryPreview.shape.statements.extend({ cashFlow: z.lazy(() => CashFlowStatement).nullable().describe('V2-M5c: when the version lists the year\'s size') }), reconciliation: StatutoryPreview.shape.reconciliation, validations: StatutoryPreview.shape.validations,
  sections: z.array(z.object({ section: z.enum(['POLICIES', 'NOTES', 'DIRECTORS_REPORT', 'BALANCE_SHEET_STATEMENTS']), items: z.array(z.object({ key: z.string(), title: z.string(), blocks: z.array(docBlock), missing: z.array(z.string()) })) })),
  omitted: z.array(z.object({ key: z.string(), title: z.string(), reason: z.enum(['NOT_APPLICABLE', 'EMPTY']) })),
  problems: z.array(z.string()), complete: z.boolean().describe('Verified rules, every fact present, statements placed, balanced and passing their error rules'), notices: z.array(z.string()),
});

// ───────────── V2-M5b the size test (DEC-066) ─────────────
const classLimits = z.object({ turnover: amt, balanceSheetTotal: amt, employees: z.number().int() });
export const ThresholdSet = z.object({
  id: uuid, label: z.string(), effectiveFrom: day.describe('First day a governed financial year may begin'), effectiveTo: day.nullable(), priorYearOnFirst: z.boolean(),
  limits: z.object({ MICRO: classLimits, SMALL: classLimits, MEDIUM: classLimits }), source, notes: z.string().nullable(), status: versionStatus, copiedFromId: uuid.nullable(),
  createdByUserId: uuid, createdAt: ts, verifiedByUserId: uuid.nullable(), verifiedAt: ts.nullable(), verificationNotes: z.string().nullable(), supersededById: uuid.nullable(),
});
export const ThresholdSetList = z.object({ items: z.array(ThresholdSet) });
const tri = z.boolean().nullable().describe('null: unknown (a figure, fact or set is missing)');
const setRef = z.object({ id: uuid, label: z.string(), status: versionStatus }).nullable();
export const SizeTest = z.object({
  companyId: uuid, companyName: z.string(), currency: z.string(), year: z.object({ start: day, end: day }),
  chosen: z.enum(['MICRO', 'SMALL', 'MEDIUM', 'LARGE']), qualifiesAs: z.enum(['MICRO', 'SMALL', 'MEDIUM', 'LARGE', 'UNKNOWN']),
  fits: z.boolean().nullable().describe('false: the chosen entity size is smaller than the class the company qualifies as'),
  verified: z.boolean().describe('false: a threshold set used is missing or unverified (DEC-052)'),
  years: z.array(z.object({
    start: day, end: day, days: z.number().int(), daysInTwelveMonths: z.number().int(), twelveMonths: z.boolean(), entitySize: z.enum(['MICRO', 'SMALL', 'MEDIUM', 'LARGE']),
    thresholdSet: setRef, priorTestedAgainst: setRef,
    prior: z.union([z.object({ source: z.literal('PLATFORM'), start: day, end: day }), z.object({ source: z.literal('FACTS'), met: z.string().nullable(), status: z.string().nullable() })]),
    figures: z.object({ turnover: amt.nullable(), balanceSheetTotal: amt.nullable(), employees: z.number().int().nullable() }),
    classes: z.array(z.object({ class: z.enum(['MICRO', 'SMALL', 'MEDIUM']), limits: classLimits.nullable().describe('The turnover limit is adjusted for a year that is not twelve months'),
      conditions: z.object({ turnover: tri, balanceSheetTotal: tri, employees: tri }), met: tri, priorMet: tri, status: tri, basis: z.enum(['BOTH_YEARS', 'CARRIED_FORWARD', 'FIRST_YEAR']).nullable() })),
  })).describe('The year asked for, then the preceding years its statuses needed'),
  problems: z.array(z.string()), notices: z.array(z.string()),
});

// ───────────── V2-M5c the cash flow statement (DEC-067) ─────────────
const cfAmount = z.string().describe('Exact decimal; inflows positive');
const cfLine = z.object({ key: z.string(), kind: z.enum(['PROFIT', 'ADJUSTMENT', 'MOVEMENT', 'CASH', 'INFLOW', 'OUTFLOW', 'UNCLASSIFIED']), classKey: z.string().nullable(), name: z.string(),
  amount: cfAmount, comparative: cfAmount.optional(), accounts: z.array(z.object({ accountId: uuid, code: z.string(), name: z.string(), amount: cfAmount })) });
const cfTotal = z.object({ name: z.string(), amount: cfAmount, comparative: cfAmount.optional() });
const cfProof = z.object({ cashMovement: cfAmount, statementNetChange: cfAmount, difference: cfAmount, reconciled: z.boolean(), opening: cfAmount, closing: cfAmount });
export const CashFlowStatement = z.object({
  companyId: uuid, companyName: z.string(), currency: z.string(),
  year: z.object({ start: day, end: day, entitySize: z.enum(['MICRO', 'SMALL', 'MEDIUM', 'LARGE']), frameworkId: uuid }),
  comparative: z.object({ start: day, end: day, fromFramework: z.boolean() }).nullable(),
  standard: z.object({ id: uuid, code: z.string(), name: z.string() }), version: z.object({ id: uuid, label: z.string(), status: versionStatus, cashFlowAppliesTo: sizes }),
  verified: z.boolean(), applies: z.boolean().describe('The version lists the year\'s entity size'),
  sections: z.array(z.object({ section: z.enum(['OPERATING', 'INVESTING', 'FINANCING']), lines: z.array(cfLine), total: cfTotal })),
  netChange: cfTotal, opening: cfTotal, closing: cfTotal, proof: cfProof.extend({ comparative: cfProof.optional() }),
  unplacedAccounts: z.array(z.object({ accountId: uuid, code: z.string(), name: z.string(), reportingLine: z.string(), subtype: z.string() })),
  problems: z.array(z.string()), notices: z.array(z.string()),
});

// ───────────── V2-M6a review flags and the review checklist (DEC-068) ─────────────
const reviewSettingsRow = z.object({ id: uuid, unexplainedAmount: amt.nullable(), materialAmount: amt.nullable(), materialPercent: amt.nullable(), oldItemDays: z.number().int().nullable(),
  evidenceAmount: amt.nullable(), reason: z.string(), setByUserId: uuid, setAt: ts });
export const ReviewSettings = z.object({ current: reviewSettingsRow.nullable(), history: z.array(reviewSettingsRow), notice: z.string() });
const reviewResponse = z.object({ action: z.enum(['EXPLAIN', 'SIGN_OFF', 'REOPEN']), note: z.string().nullable(), figures: z.record(z.unknown()), byUserId: uuid, at: ts });
const reviewControlCode = z.enum(['RC-01', 'RC-02', 'RC-03', 'RC-04', 'RC-05', 'RC-06', 'RC-07', 'RC-08', 'RC-09']);
export const ReviewChecklist = z.object({
  companyId: uuid, year: z.object({ start: day, end: day, frameworkId: uuid }), settings: reviewSettingsRow.nullable(),
  controls: z.array(z.object({ code: reviewControlCode, title: z.string(), status: z.enum(['CLEAR', 'OPEN', 'EXPLAINED', 'SIGNED_OFF', 'NOT_EVALUATED']), needs: z.array(z.string()),
    counts: z.object({ open: z.number().int(), explained: z.number().int(), signedOff: z.number().int() }),
    flags: z.array(z.object({ key: z.string(), control: reviewControlCode, subject: z.object({ type: z.string(), id: z.string(), label: z.string() }), figures: z.record(z.unknown()),
      drilldown: z.record(z.string().nullable()).optional(), state: z.enum(['OPEN', 'EXPLAINED', 'SIGNED_OFF']), changedSinceResponse: z.boolean().describe('An explanation or sign-off lapsed because the figures changed'),
      responses: z.array(reviewResponse) })) })),
  resolved: z.array(z.object({ key: z.string(), control: z.string(), lastAction: z.string(), responses: z.array(reviewResponse) })).describe('Flags no longer raised, with their history'),
  complete: z.boolean(), notices: z.array(z.string()),
});

// ───────────── V2-M6b the 14-step year-end workflow (DEC-069) ─────────────
const stepControl = z.object({ status: z.enum(['READY', 'ATTENTION', 'NOT_APPLICABLE']).nullable(), summary: z.string(), details: z.record(z.unknown()) });
const stepState = z.enum(['DONE', 'LAPSED', 'BLOCKED', 'TODO', 'ATTENTION']);
export const YearEndWorkflow = z.object({
  companyId: uuid, year: z.object({ start: day, end: day, frameworkId: uuid }), locked: z.boolean().describe('The client approved the accounts; the year is locked (DEC-070)'),
  fingerprint: z.string().nullable().describe('SHA-256 of the accounts document; null while it is not complete'), current: z.number().int().nullable().describe('The first step that is not DONE'),
  steps: z.array(z.object({ step: z.number().int(), title: z.string(), dependsOn: z.array(z.number().int()),
    control: stepControl,
    state: stepState,
    signOffs: z.array(z.object({ action: z.enum(['SIGN_OFF', 'REOPEN']), note: z.string().nullable(), control: z.record(z.unknown()), byUserId: uuid, at: ts })) })),
  notices: z.array(z.string()),
});

// ───────────── V2-M6c partner review, client approval, locking and the filing-ready package (DEC-070) ─────────────
const packageSummary = z.object({ id: uuid, fingerprint: z.string(), sha256: z.string(), byUserId: uuid, at: ts });
export const AccountsApproval = z.object({
  companyId: uuid, year: z.object({ start: day, end: day, frameworkId: uuid }), fingerprint: z.string().nullable(), locked: z.boolean(), lockedAt: ts.nullable(),
  steps: z.array(z.object({ step: z.number().int(), state: stepState, control: stepControl })),
  partnerReviews: z.array(z.object({ id: uuid, fingerprint: z.string(), live: z.boolean().describe('The latest review, of the accounts as they stand'), note: z.string().nullable(), byUserId: uuid, at: ts })),
  clientApproval: z.object({ id: uuid, fingerprint: z.string(), current: z.boolean(), directorContactId: uuid, approvedOn: day, evidenceDocumentId: uuid, note: z.string().nullable(), byUserId: uuid, at: ts }).nullable(),
  package: packageSummary.nullable(),
});
export const AccountsPackage = z.object({ id: uuid, companyId: uuid, yearStart: day, frameworkId: uuid, fingerprint: z.string(), sha256: z.string(), byUserId: uuid, at: ts,
  content: z.record(z.unknown()).describe('The package (format uk-accounts-package/1): the approved accounts document, the framework and its verification, the size test, the partner review and the client approval') });

// ───────────── V7-M1 compliance calendar (DEC-088) ─────────────
const ruleKind = z.enum(['ACCOUNTS_FILING', 'CT_PAYMENT', 'CT_RETURN', 'CONFIRMATION_STATEMENT', 'VAT_RETURN']);
const obligationKind = z.enum(['ACCOUNTS_FILING', 'CT_PAYMENT', 'CT_RETURN', 'CONFIRMATION_STATEMENT', 'VAT_RETURN', 'OTHER']);
const obligationStatus = z.enum(['NOT_STARTED', 'IN_PROGRESS', 'WAITING_ON_CLIENT', 'READY', 'DONE', 'NOT_REQUIRED']);
export const DeadlineRule = z.object({
  id: uuid, kind: ruleKind, legalForms: z.array(z.string()), daysBeforeMonths: z.number().int(), months: z.number().int(), daysAfterMonths: z.number().int(),
  monthEndRule: z.boolean().describe('A month-end anchor lands on the last day of the target month'), effectiveFrom: day.describe('First anchor date the version governs'), effectiveTo: day.nullable(),
  source: z.object({ url: z.string(), provision: z.string(), retrievedOn: day }), enteredByUserId: uuid, createdAt: ts,
  verificationStatus: z.enum(['UNVERIFIED', 'VERIFIED']).describe('UNVERIFIED versions generate nothing'), verifiedByUserId: uuid.nullable(), verifiedAt: ts.nullable(), verificationNotes: z.string().nullable(),
  evidenceDocumentId: uuid.nullable(), supersededById: uuid.nullable(),
});
export const Obligation = z.object({
  id: uuid, companyId: uuid, companyName: z.string().optional().describe('Practice-wide lists only'), kind: obligationKind, title: z.string().nullable(),
  periodStart: day.nullable(), periodEnd: day.nullable().describe('The anchor: period end, VAT period end or confirmation date'), dueDate: day,
  source: z.enum(['RULE', 'MANUAL']), deadlineRuleId: uuid.nullable(), status: obligationStatus, overdue: z.boolean().describe('Computed on the UK date of the request, never stored'),
  assigneeUserId: uuid.nullable(), doneOn: day.nullable(), doneReference: z.string().nullable(), evidenceDocumentId: uuid.nullable(), statusReason: z.string().nullable(),
  version: z.number().int(), createdByUserId: uuid, createdAt: ts, updatedAt: ts,
});
export const ObligationList = z.object({ today: day.describe('The UK date the list was computed for'), items: z.array(Obligation) });
export const ObligationPage = ObligationList.extend({ nextCursor: z.string().nullable() });
export const ComplianceSummary = z.object({ today: day, overdue: z.number().int(), dueNext14: z.number().int(), waitingOnClient: z.number().int(), ready: z.number().int() });
export const ComplianceProfile = z.object({ companyId: uuid, confirmationDate: day.nullable(), clientManagerUserId: uuid.nullable().describe('V7-M2: the member who manages the client'), updatedByUserId: uuid.nullable(), updatedAt: ts.nullable() });
export const GenerationResult = z.object({
  from: day, through: day, created: z.array(Obligation), existing: z.number().int().describe('Generated before; left as they are'),
  skipped: z.array(z.object({ kind: ruleKind, anchor: day, reason: z.enum(['rule_unverified', 'no_rule_for_date']) })),
  notApplicable: z.array(z.object({ kind: ruleKind, reason: z.string() })),
});

// ───────────── V7-M2 practice overview and client list (DEC-089) ─────────────
export const ComplianceWork = z.object({ byStatus: z.record(z.number().int()).describe('Open obligations by status'), byKind: z.record(z.number().int()).describe('Open obligations by kind'), total: z.number().int() });
export const ClientSummary = z.object({
  id: uuid, name: z.string(), companyNumber: z.string().nullable(), legalForm: z.string(), yearEnd: z.object({ month: z.number().int(), day: z.number().int() }).nullable(),
  vat: z.object({ registered: z.boolean(), periodMonths: z.number().int().nullable() }),
  nextDeadline: z.object({ id: uuid, kind: obligationKind, title: z.string().nullable(), dueDate: day, status: obligationStatus, overdue: z.boolean() }).nullable().describe('The earliest open obligation'),
  openCount: z.number().int(), overdueCount: z.number().int(),
  clientManager: z.object({ userId: uuid, displayName: z.string().nullable() }).nullable(),
});
export const ClientPage = z.object({ today: day, items: z.array(ClientSummary), nextCursor: z.string().nullable() });

// ───────────── V5-M1 the VAT return (DEC-090) ─────────────
const vatReturnStatus = z.enum(['DRAFT', 'PREPARED', 'REVIEWED', 'APPROVED']).describe('Derived from the events and the live fingerprint, never stored; APPROVED once locked');
export const VatReturnFlag = z.object({
  key: z.string().describe('reconciliation_difference, superseded_rate:{rateId}, repayment, zero_return or late_posting:{journalId}:{lineNo}'),
  kind: z.enum(['reconciliation_difference', 'superseded_rate', 'repayment', 'zero_return', 'late_posting']), message: z.string(),
  explanation: z.object({ note: z.string(), byUserId: uuid, at: ts }).nullable().describe('The explanation made on the live fingerprint; null until explained'),
});
export const VatReturnEvent = z.object({
  id: uuid, kind: z.enum(['PREPARED', 'FLAG_EXPLAINED', 'REVIEWED', 'CLIENT_APPROVED']), fingerprint: z.string(), live: z.boolean().describe('False once the ledger changed after it (lapsed)'),
  flagKey: z.string().nullable(), note: z.string().nullable(), byUserId: uuid, byName: z.string().nullable().describe('V5-M3: the person\'s display name'), at: ts, approverContactId: uuid.nullable(), approvedOn: day.nullable(), evidenceDocumentId: uuid.nullable(),
});
export const VatReturn = z.object({
  id: uuid, companyId: uuid, periodFrom: day, periodTo: day, obligationId: uuid.nullable().describe('The client\'s VAT obligation for the period (V7-M1), when there is one'),
  status: vatReturnStatus, fingerprint: z.string().describe('SHA-256 of the workpaper in canonical JSON without its notice: live, or as approved once locked'),
  locked: z.boolean(), lockedAt: ts.nullable(), lockedByUserId: uuid.nullable(), createdByUserId: uuid, createdAt: ts,
  workpaper: VatWorkpaper.omit({ notice: true }).describe('The M4b workpaper for the period: live, or as approved'),
  flags: z.array(VatReturnFlag), unexplainedFlags: z.number().int(), events: z.array(VatReturnEvent), notice: z.string(),
});
export const VatReturnList = z.object({ items: z.array(z.object({ id: uuid, periodFrom: day, periodTo: day, status: vatReturnStatus, locked: z.boolean(), unexplainedFlags: z.number().int(), obligationId: uuid.nullable() })) });

// ───────────── V5-M2 the VAT filing record (DEC-091) ─────────────
export const VatPresentationRule = z.object({
  id: uuid, method: z.enum(['TRUNCATE_PENCE', 'ROUND_TO_POUND']).describe('How boxes 6 to 9 are presented in whole pounds'), effectiveFrom: day, effectiveTo: day.nullable(),
  source: z.object({ url: z.string(), provision: z.string(), retrievedOn: day }), enteredByUserId: uuid, createdAt: ts,
  verificationStatus: z.enum(['UNVERIFIED', 'VERIFIED']), verifiedByUserId: uuid.nullable(), verifiedAt: ts.nullable(), verificationNotes: z.string().nullable(), evidenceDocumentId: uuid.nullable(), supersededById: uuid.nullable(),
});
const vatBoxes = z.object(Object.fromEntries(['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((b) => [b, z.string()])) as Record<string, z.ZodString>).describe('Boxes 1 to 5 in pounds and pence as approved; 6 to 9 in whole pounds');
const filingPackage = z.object({
  format: z.literal('uk-vat-filing-package/1'), companyId: uuid, vatReturnId: uuid, vrn: z.string().nullable(), currency: z.string(), periodFrom: day, periodTo: day, approvedFingerprint: z.string(),
  boxes: vatBoxes, box5Direction: z.enum(['PAYABLE', 'REPAYABLE']), presentation: z.object({ ruleId: uuid, method: z.enum(['TRUNCATE_PENCE', 'ROUND_TO_POUND']) }),
});
export const VatFilingPackage = z.object({ package: filingPackage, sha256: z.string(), notice: z.string() });
export const VatFiling = z.object({
  id: uuid, vatReturnId: uuid, mode: z.enum(['RECORDED', 'SIMULATED']).describe('RECORDED: filed outside the platform with HMRC\'s receipt; SIMULATED: fake adapter, nothing sent'),
  submittedOn: day, receiptReference: z.string(), receipt: z.record(z.unknown()).nullable(), adapter: z.string().nullable(), evidenceDocumentId: uuid.nullable(),
  journalId: uuid.nullable().describe('The liability journal of a recorded filing'), note: z.string().nullable(), package: filingPackage, packageSha256: z.string(), presentationRuleId: uuid, byUserId: uuid, at: ts, notice: z.string(),
});

// ───────────── V3-M1 the taxonomy and its mapping (DEC-093) ─────────────
const qname = z.string().describe('prefix:LocalName; the prefix is one the version declares');
export const ConceptEntry = z.object({
  id: uuid, sourceKind: z.enum(['LINE', 'FACT', 'COMPANY']), sourceKey: z.string().describe('A statutory line key, a preparer\'s fact key or a company detail'),
  concept: qname, dataType: z.enum(['MONETARY', 'TEXT', 'DATE']), periodType: z.enum(['INSTANT', 'DURATION']), negate: z.boolean(), decimals: z.number().int().nullable(),
  dimensions: z.array(z.object({ axis: qname, member: qname })), mandatory: z.boolean(),
});
const taxonomyVersionFields = {
  id: uuid, label: z.string(), standardCode: z.string(), entryPoint: z.string().describe('The schema reference of the taxonomy entry point'), entityScheme: z.string().nullable().describe('V3-M2: the scheme of the entity identifier'), namespaces: z.record(z.string()).describe('Prefix to namespace URI'),
  effectiveFrom: day, effectiveTo: day.nullable(), source: z.object({ url: z.string(), provision: z.string(), retrievedOn: day }), notes: z.string().nullable(),
  status: z.enum(['UNVERIFIED', 'VERIFIED', 'SUPERSEDED']), copiedFromId: uuid.nullable(), createdByUserId: uuid, createdAt: ts,
  verifiedByUserId: uuid.nullable(), verifiedAt: ts.nullable(), verificationNotes: z.string().nullable(), supersededById: uuid.nullable(),
};
export const TaxonomyVersionSummary = z.object(taxonomyVersionFields);
export const TaxonomyVersion = z.object({ ...taxonomyVersionFields, entries: z.array(ConceptEntry), problems: z.array(z.string()).describe('What stops verification; empty when it may be verified') });

// ───────────── V3-M2 the iXBRL document (DEC-094) ─────────────
export const IxbrlDocument = z.object({
  id: uuid, companyId: uuid, packageId: uuid, taxonomyVersionId: uuid, status: z.enum(['VALID', 'INVALID']).describe('INVALID when a check found an error'),
  sha256: z.string(), factCount: z.number().int(), contextCount: z.number().int(), errors: z.array(z.string()), warnings: z.array(z.string()), byUserId: uuid, at: ts, notice: z.string(),
});

// ───────────── V3-M3 the Companies House filing (DEC-095) ─────────────
export const ChFiling = z.object({
  id: uuid, companyId: uuid, documentId: uuid, status: z.enum(['DRAFT', 'VALIDATED', 'AUTHORISED', 'SUBMITTED', 'ACCEPTED', 'REJECTED']), mode: z.enum(['PORT', 'RECORDED']),
  payloadSha256: z.string(), createdByUserId: uuid, createdAt: ts, validatedByUserId: uuid.nullable(),
  authority: z.object({ byUserId: uuid, directorContactId: uuid.nullable(), authorisedOn: day, evidenceDocumentId: uuid.nullable() }).nullable(),
  submissionId: z.string().nullable(), chReference: z.string().nullable(), acceptedOn: day.nullable(), acceptanceEvidenceId: uuid.nullable(), rejectionReasons: z.array(z.string()), updatedAt: ts,
  events: z.array(z.object({ id: uuid, fromStatus: z.string().nullable(), toStatus: z.string(), payloadSha256: z.string(), submissionId: z.string().nullable(), request: z.unknown(), response: z.unknown(),
    note: z.string().nullable(), byUserId: uuid, at: ts })).describe('Every move, append-only; empty in lists'),
  notice: z.string(),
});

// ───────────── V4-M1 Corporation Tax rules, the tax profile and CT periods (DEC-097) ─────────────
export const CtRule = z.object({
  id: uuid, jurisdiction: z.literal('UK'), kind: z.enum(['CT_RATES', 'PERIOD_MAX_MONTHS']), effectiveFrom: day, effectiveTo: day.nullable(),
  parameters: z.record(z.unknown()).describe('Checked by kind: CT_RATES (mainRate, smallProfitsRate, lowerLimit, upperLimit, marginalReliefFraction) or PERIOD_MAX_MONTHS (months)'),
  source: z.object({ url: z.string(), provision: z.string(), retrievedOn: day }), enteredByUserId: uuid, createdAt: ts,
  verificationStatus: z.enum(['UNVERIFIED', 'VERIFIED']), verifiedByUserId: uuid.nullable(), verifiedAt: ts.nullable(), verificationNotes: z.string().nullable(), evidenceDocumentId: uuid.nullable(), supersededById: uuid.nullable(),
});
export const TaxProfile = z.object({ companyId: uuid, utr: z.string().nullable().describe('The Unique Taxpayer Reference, 10 digits (form checked only)'), updatedByUserId: uuid.nullable(), updatedAt: ts.nullable() });
export const CtPeriod = z.object({
  id: uuid, companyId: uuid, frameworkId: uuid.describe('The accounts year it was derived from'), startDate: day, endDate: day, periodRuleId: uuid.describe('The PERIOD_MAX_MONTHS version used'),
  associatedCompanies: z.number().int(), associatedReason: z.string().nullable(), version: z.number().int(), createdByUserId: uuid, createdAt: ts, updatedAt: ts,
});
export const CtPeriodDerivation = z.object({ created: z.boolean().describe('false when the year\'s periods already existed'), items: z.array(CtPeriod) });

// ───────────── V4-M2 tax adjustments and the adjusted profit (DEC-099) ─────────────
const ctCategory = z.enum(['DISALLOWABLE', 'DEPRECIATION', 'ENTERTAINING', 'PROVISION', 'LEGAL_PROFESSIONAL', 'NON_TAXABLE_INCOME', 'OTHER']);
export const CtAdjustmentRule = z.object({
  id: uuid, companyId: uuid, accountId: uuid, category: ctCategory, percentage: z.string().describe('The share of the account\'s net debit added back (a credit balance is deducted)'), effectiveFrom: day, effectiveTo: day.nullable(),
  provision: z.string().nullable(), reason: z.string(), enteredByUserId: uuid, createdAt: ts,
  verificationStatus: z.enum(['UNVERIFIED', 'VERIFIED']), verifiedByUserId: uuid.nullable(), verifiedAt: ts.nullable(), verificationNotes: z.string().nullable(), supersededById: uuid.nullable(),
});
export const CtAdjustment = z.object({
  id: uuid, companyId: uuid, periodId: uuid, category: ctCategory, direction: z.enum(['ADD', 'DEDUCT']), amount: z.string(), description: z.string(), evidenceDocumentId: uuid, enteredByUserId: uuid, createdAt: ts,
  withdrawn: z.object({ byUserId: uuid, at: ts, reason: z.string() }).nullable(),
});
export const CtAdjustedProfit = z.object({
  periodId: uuid, companyId: uuid, startDate: day, endDate: day, currency: z.string(), accountingProfit: z.string().describe('Profit before tax from the ledger, closing journals and the tax charge left out'),
  adjustments: z.array(z.object({
    source: z.enum(['RULE', 'MANUAL']), ruleId: uuid.optional(), adjustmentId: uuid.optional(), category: ctCategory, direction: z.enum(['ADD', 'DEDUCT']), amount: z.string(), description: z.string(),
    account: z.object({ id: uuid, code: z.string(), name: z.string() }).optional(), debits: z.string().optional(), credits: z.string().optional(), percentage: z.string().optional(), verificationStatus: z.string().optional(),
    drilldown: z.object({ accountId: uuid, from: day, to: day, excludeClosing: z.boolean() }).optional().describe('The account\'s lines behind a rule-made adjustment'), evidenceDocumentId: uuid.optional(),
  })),
  totalAdded: z.string(), totalDeducted: z.string(), adjustedProfit: z.string().describe('Before capital allowances and losses'), problems: z.array(z.string()).describe('What the computation will refuse until resolved'),
  fingerprint: z.string().describe('SHA-256 of the statement in canonical JSON, without the notice'), notice: z.string(),
});

// ───────────── V4-M3 capital allowances (DEC-100) ─────────────
const caPool = z.enum(['MAIN', 'SPECIAL_RATE', 'SINGLE_ASSET']);
export const PoolOpening = z.object({
  id: uuid, companyId: uuid, pool: caPool, assetId: uuid.nullable(), asOf: day, amount: z.string().describe('The written-down value at the date'), evidenceDocumentId: uuid, reason: z.string(),
  enteredByUserId: uuid, createdAt: ts, verificationStatus: z.enum(['UNVERIFIED', 'VERIFIED']), verifiedByUserId: uuid.nullable(), verifiedAt: ts.nullable(), verificationNotes: z.string().nullable(), supersededById: uuid.nullable(),
});
const caResult = z.object({
  fraction: z.string().describe('1 for a 12-month period, else days/365'),
  aia: z.object({ limit: z.string(), available: z.string(), claimed: z.string(), claims: z.array(z.object({ assetId: z.string(), number: z.number().int(), description: z.string(), acquiredOn: day, cost: z.string(), aia: z.string(), toMainPool: z.string() })) }),
  smallPoolLimit: z.string(),
  pools: z.array(z.object({ pool: caPool, assetId: z.string().nullable(), opening: z.string(), additions: z.string(), disposals: z.string(), available: z.string(), rate: z.string(), writingDownAllowance: z.string(),
    smallPool: z.boolean(), balancingAllowance: z.string(), balancingCharge: z.string(), closing: z.string() })),
  disposals: z.array(z.object({ assetId: z.string(), number: z.number().int(), description: z.string(), disposedOn: day, pool: caPool.nullable(), proceeds: z.string(), cost: z.string(), disposalValue: z.string().describe('The lower of the proceeds and the tax cost') })),
  totals: z.object({ aia: z.string(), writingDownAllowances: z.string(), balancingAllowances: z.string(), allowances: z.string(), balancingCharges: z.string() }),
});
export const CapitalAllowances = z.object({
  periodId: uuid, companyId: uuid, startDate: day, endDate: day, rules: z.object({ aiaLimitRuleId: uuid, wdaRatesRuleId: uuid, smallPoolLimitRuleId: uuid }),
  openingsFrom: z.record(z.unknown()).describe('PRIOR_COMPUTATION with its id, or OPENING_BALANCES with their ids'),
  notQualifying: z.array(z.object({ assetId: uuid, number: z.number().int(), description: z.string(), cost: z.string() })), computation: caResult,
  problems: z.array(z.string()).describe('What stops the computation from being stored'), priorComputationId: uuid.nullable(), fingerprint: z.string(), notice: z.string(),
});
export const CaComputation = z.object({ id: uuid, periodId: uuid, priorComputationId: uuid.nullable(), fingerprint: z.string(), preparedByUserId: uuid, preparedAt: ts, supersededById: uuid.nullable(),
  stale: z.boolean().describe('The prior period\'s current computation is no longer the one this opened from'), snapshot: z.record(z.unknown()) });

// ───────────── V4-M4 losses, the computation and the canonical CT600 (DEC-101) ─────────────
export const LossOpening = z.object({
  id: uuid, companyId: uuid, asOf: day, amount: z.string().describe('Trading losses brought forward at the date'), evidenceDocumentId: uuid, reason: z.string(), enteredByUserId: uuid, createdAt: ts,
  verificationStatus: z.enum(['UNVERIFIED', 'VERIFIED']), verifiedByUserId: uuid.nullable(), verifiedAt: ts.nullable(), verificationNotes: z.string().nullable(), supersededById: uuid.nullable(),
});
const fyPart = z.object({ financialYear: z.number().int(), from: day, to: day, days: z.number().int(), ruleId: uuid, profit: z.string(), lowerLimit: z.string(), upperLimit: z.string(),
  basis: z.enum(['SMALL_PROFITS_RATE', 'MAIN_RATE', 'MARGINAL_RELIEF']), rate: z.string(), taxAtRate: z.string(), marginalRelief: z.string(), tax: z.string() });
const ctResult = z.object({
  adjustedProfit: z.string(), allowances: z.string(), balancingCharges: z.string(), tradingProfit: z.string(), tradingLoss: z.string(), lossesBroughtForward: z.string(), lossesBroughtForwardUsed: z.string(),
  profitsBeforeCarryBack: z.string(), lossCarriedBackFromFollowing: z.string(), taxableTotalProfits: z.string(), carryBack: z.string(), lossesCarriedForward: z.string(), associatedCompanies: z.number().int(),
  financialYears: z.array(fyPart), corporationTax: z.string(),
});
const neighbours = z.object({ previous: z.object({ periodId: uuid, computationId: uuid, lossesCarriedForward: z.string(), profitsBeforeCarryBack: z.string() }).nullable(),
  following: z.object({ periodId: uuid, computationId: uuid, carryBack: z.string() }).nullable(), lossOpeningId: uuid.nullable() });
export const CtComputationPreview = z.object({
  periodId: uuid, companyId: uuid, startDate: day, endDate: day, turnover: z.string(), inputs: z.object({ adjustedProfitFingerprint: z.string(), capitalAllowancesComputationId: uuid.nullable() }),
  neighbours, result: ctResult, problems: z.array(z.string()).describe('What stops the computation from being prepared'), fingerprint: z.string(), notice: z.string(),
});
export const CtComputation = z.object({
  id: uuid, periodId: uuid, status: z.enum(['PREPARED', 'APPROVED']), fingerprint: z.string(), carryBack: z.string(), neighbours, preparedByUserId: uuid, preparedAt: ts,
  approval: z.object({ byUserId: uuid, at: ts, notes: z.string() }).nullable(), supersededById: uuid.nullable(), stale: z.boolean().describe('A neighbouring period\'s approved figures have changed since this was prepared'), snapshot: z.record(z.unknown()),
});
export const Ct600 = z.object({
  format: z.literal('uk-ct600-canonical/1'), computationId: uuid, fingerprint: z.string(), company: z.object({ name: z.string(), registrationNumber: z.string().nullable(), utr: z.string() }), period: z.object({ from: day, to: day }),
  turnover: z.string(), tradingProfits: z.string(), tradingLossesBroughtForwardUsed: z.string(), netTradingProfits: z.string(), nonTradingLoanRelationships: z.string(), propertyIncome: z.string(), chargeableGains: z.string(),
  lossCarriedBackFromLaterPeriod: z.string(), taxableTotalProfits: z.string(), associatedCompanies: z.number().int(),
  financialYears: z.array(z.object({ financialYear: z.number().int(), profit: z.string(), rate: z.string(), taxAtRate: z.string(), marginalRelief: z.string(), basis: z.string() })),
  corporationTaxChargeable: z.string(), taxPayable: z.string(), losses: z.object({ tradingLossOfPeriod: z.string(), carriedBack: z.string(), carriedForward: z.string() }), approval: z.object({ byUserId: uuid.nullable(), at: ts.nullable() }),
});
