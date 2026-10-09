import type { ZodTypeAny } from 'zod';
import * as C from '@uk/contracts';
import { z } from 'zod';
import * as R from './schemas';

/**
 * The API contract: one entry per operation. Request schemas are the SAME zod objects used for runtime validation
 * (imported from @uk/contracts); response schemas live in ./schemas. A test fails if any route lacks an entry,
 * if an entry has no route, or if docs/api/openapi.json is out of date — so the contract cannot silently drift.
 */
export interface RouteDoc {
  tag: string;
  summary: string;
  description?: string;
  body?: [name: string, schema: ZodTypeAny];
  query?: ZodTypeAny;
  /** [status, response schema name | null, description] */
  ok: [number, string | null, string];
  binaryBody?: boolean;
  binaryResponse?: boolean;
  extraErrors?: number[];
}

const page = z.object({ limit: z.number().int().min(1).max(100).default(25).describe('Page size'), cursor: z.string().optional().describe('`nextCursor` from the previous page') });
export const NAMED_RESPONSES: Record<string, ZodTypeAny> = {
  Company: R.Company, Period: R.Period, DocumentRecord: R.DocumentRecord, DocumentVersion: R.DocumentVersion, DocumentCreated: R.DocumentCreated,
  Job: R.Job, JobAccepted: R.JobAccepted, Task: R.Task, Notification: R.Notification, WorkflowInstance: R.WorkflowInstance, WorkflowDetail: R.WorkflowDetail,
  Connection: R.Connection, AiProposal: R.AiProposal, Practice: R.Practice, FeatureFlag: R.FeatureFlag, Contact: R.Contact, Address: R.Address, Officer: R.Officer, ProposedPeriod: R.ProposedPeriod, GrantList: R.GrantList, GrantResult: R.GrantResult, Role: R.Role, Invitation: R.Invitation, Organisation: R.Organisation, OrgMe: R.OrgMe, Me: R.Me,
  LoginResult: R.LoginResult, Message: R.Message, Health: R.Health, MfaStatus: R.MfaStatus, MfaEnrol: R.MfaEnrol, MfaConfirmed: R.MfaConfirmed,
  DownloadLink: R.DownloadLink, CheckResult: R.CheckResult,
  CompanyPage: R.Pages.Company, DocumentPage: R.Pages.DocumentRecord, JobPage: R.Pages.Job, TaskPage: R.Pages.Task, NotificationPage: R.Pages.Notification,
  WorkflowPage: R.Pages.WorkflowInstance, AiProposalPage: R.Pages.AiProposal, AuditEventPage: R.Pages.AuditEvent,
  PeriodList: R.items(R.Period), RoleList: z.object({ items: z.array(R.Role), permissionCatalogue: z.array(z.string()) }), MemberList: R.items(R.Member), ContactPage: R.Pages.Contact, AddressList: R.items(R.Address), OfficerList: R.items(R.Officer), CurrencyList: R.items(R.Currency), CountryList: R.items(R.Country), TaxJurisdictionList: R.items(R.TaxJurisdiction), FeatureFlagList: R.items(R.FeatureFlag), PracticeList: R.items(R.Practice),
  InvitationList: R.items(R.Invitation), ConnectionList: R.items(R.Connection), ProviderList: R.items(R.Provider), SessionList: R.items(R.Session),
  LoginHistory: R.items(R.LoginEvent), WorkflowDefinitionList: R.items(R.WorkflowDefinitionView),
  UnreadCount: z.object({ count: z.number().int() }), UpdatedCount: z.object({ updated: z.number().int() }),
};

const v = '/organisations/{organisationId}';
export const ROUTES: Record<string, RouteDoc> = {
  // ── Operations ──
  'GET /healthz': { tag: 'Operations', summary: 'Liveness probe', ok: [200, 'Health', 'Process is up'] },
  'GET /readyz': { tag: 'Operations', summary: 'Readiness probe (database + Redis)', ok: [200, 'Health', 'Dependencies reachable'], extraErrors: [503] },
  // ── Authentication ──
  'POST /auth/register': { tag: 'Authentication', summary: 'Register a user and create their organisation', description: 'Identical response whether or not the email is already registered (no account enumeration). A verification email is sent asynchronously.', body: ['RegisterRequest', C.registerSchema], ok: [202, 'Message', 'Accepted'] },
  'POST /auth/verify-email': { tag: 'Authentication', summary: 'Verify an email address with the emailed single-use token', body: ['VerifyEmailRequest', C.verifyEmailSchema], ok: [200, null, 'Email verified'] },
  'POST /auth/resend-verification': { tag: 'Authentication', summary: 'Resend the verification email', body: ['ResendVerificationRequest', C.resendVerificationSchema], ok: [202, 'Message', 'Accepted (always, to avoid enumeration)'] },
  'POST /auth/login': { tag: 'Authentication', summary: 'Sign in (browser): sets an httpOnly SameSite=Strict session cookie', description: 'Layered throttling applies (per IP+account progressive delay, per IP, distributed-attack detection). Failures are generic. May return `mfaRequired` with a challenge token.', body: ['LoginRequest', C.loginSchema], ok: [200, 'LoginResult', 'Signed in, or MFA required'], extraErrors: [429] },
  'POST /auth/login/bearer': { tag: 'Authentication', summary: 'Sign in (API clients): additionally returns the opaque session token', body: ['LoginRequest', C.loginSchema], ok: [200, 'LoginResult', 'Signed in, or MFA required'], extraErrors: [429] },
  'POST /auth/login/mfa': { tag: 'Authentication', summary: 'Complete sign-in with a TOTP or recovery code (cookie session)', body: ['MfaLoginRequest', C.mfaLoginSchema], ok: [200, 'LoginResult', 'Signed in'] },
  'POST /auth/login/mfa/bearer': { tag: 'Authentication', summary: 'Complete sign-in with a TOTP or recovery code (bearer token)', body: ['MfaLoginRequest', C.mfaLoginSchema], ok: [200, 'LoginResult', 'Signed in'] },
  'POST /auth/logout': { tag: 'Authentication', summary: 'Revoke the current session', ok: [204, null, 'Signed out'] },
  'POST /auth/forgot-password': { tag: 'Authentication', summary: 'Request a password reset email', body: ['ForgotPasswordRequest', C.forgotPasswordSchema], ok: [202, 'Message', 'Accepted (always)'] },
  'POST /auth/reset-password': { tag: 'Authentication', summary: 'Set a new password with a single-use reset token (revokes all sessions)', body: ['ResetPasswordRequest', C.resetPasswordSchema], ok: [200, null, 'Password reset'] },
  'POST /auth/change-password': { tag: 'Authentication', summary: 'Change password (revokes other sessions)', body: ['ChangePasswordRequest', C.changePasswordSchema], ok: [200, null, 'Password changed'] },
  'GET /auth/me': { tag: 'Authentication', summary: 'Current user, MFA status and organisation memberships', ok: [200, 'Me', 'Profile'] },
  'GET /auth/sessions': { tag: 'Authentication', summary: 'List the caller\'s active sessions', ok: [200, 'SessionList', 'Sessions'] },
  'DELETE /auth/sessions/{sessionId}': { tag: 'Authentication', summary: 'Revoke one of the caller\'s sessions', ok: [204, null, 'Revoked'] },
  'GET /auth/login-history': { tag: 'Authentication', summary: 'The caller\'s recent sign-in / security events', ok: [200, 'LoginHistory', 'Events'] },
  'GET /auth/mfa': { tag: 'MFA', summary: 'MFA status', ok: [200, 'MfaStatus', 'Status'] },
  'POST /auth/mfa/enroll': { tag: 'MFA', summary: 'Begin TOTP enrolment (returns secret + otpauth URL)', ok: [200, 'MfaEnrol', 'Pending factor created'] },
  'POST /auth/mfa/confirm': { tag: 'MFA', summary: 'Confirm enrolment with a code; returns recovery codes once', body: ['MfaConfirmRequest', C.mfaConfirmSchema], ok: [200, 'MfaConfirmed', 'MFA enabled'] },
  'POST /auth/mfa/disable': { tag: 'MFA', summary: 'Disable MFA (requires password and a valid code)', body: ['MfaDisableRequest', C.mfaDisableSchema], ok: [204, null, 'MFA disabled'] },
  // ── Organisations ──
  [`GET ${v}`]: { tag: 'Organisations', summary: 'Get the organisation', ok: [200, 'Organisation', 'Organisation'] },
  [`GET ${v}/me`]: { tag: 'Organisations', summary: 'The caller\'s organisation role, reach, and explicit practice/company grants', ok: [200, 'OrgMe', 'Access'] },
  [`GET ${v}/roles`]: { tag: 'Access control', summary: 'List system and custom roles + the permission catalogue', ok: [200, 'RoleList', 'Roles'] },
  [`POST ${v}/roles`]: { tag: 'Access control', summary: 'Create a custom role (cannot exceed the creator\'s own permissions)', body: ['CreateRoleRequest', C.createRoleSchema], ok: [201, 'Role', 'Created'] },
  [`GET ${v}/members`]: { tag: 'Access control', summary: 'List members', ok: [200, 'MemberList', 'Members'] },
  [`PATCH ${v}/members/{membershipId}`]: { tag: 'Access control', summary: 'Change a member\'s role, company scope or status', body: ['UpdateMemberRequest', C.updateMemberSchema], ok: [200, null, 'Updated'] },
  [`DELETE ${v}/members/{membershipId}`]: { tag: 'Access control', summary: 'Remove a member (the last owner cannot be removed)', query: C.reasonQuerySchema, ok: [204, null, 'Removed'] },
  [`POST ${v}/invitations`]: { tag: 'Access control', summary: 'Invite a person by email', body: ['InviteMemberRequest', C.inviteMemberSchema], ok: [201, 'Invitation', 'Invitation sent asynchronously'] },
  [`GET ${v}/invitations`]: { tag: 'Access control', summary: 'List pending invitations', ok: [200, 'InvitationList', 'Invitations'] },
  [`DELETE ${v}/invitations/{invitationId}`]: { tag: 'Access control', summary: 'Revoke an invitation', ok: [204, null, 'Revoked'] },
  'POST /invitations/accept': { tag: 'Access control', summary: 'Accept an invitation (caller must be the invited, verified address)', body: ['AcceptInvitationRequest', C.acceptInvitationSchema], ok: [200, null, 'Joined'] },
  // ── Companies ──
  [`POST ${v}/companies`]: { tag: 'Companies', summary: 'Create a company', body: ['CreateCompanyRequest', C.createCompanySchema], ok: [201, 'Company', 'Created'], extraErrors: [409] },
  [`GET ${v}/companies`]: { tag: 'Companies', summary: 'List companies the caller can access', query: page, ok: [200, 'CompanyPage', 'Page of companies'] },
  [`GET ${v}/companies/{companyId}`]: { tag: 'Companies', summary: 'Get a company', ok: [200, 'Company', 'Company'] },
  [`PATCH ${v}/companies/{companyId}`]: { tag: 'Companies', summary: 'Rename a company', body: ['UpdateCompanyRequest', C.updateCompanySchema], ok: [200, 'Company', 'Updated'], extraErrors: [422] },
  [`GET ${v}/companies/{companyId}/periods/next`]: { tag: 'Companies', summary: 'The accounting period that follows the latest one, derived from the company\'s financial year-end (and incorporation date for the first period)', ok: [200, 'ProposedPeriod', 'Proposed period'], extraErrors: [422] },
  [`GET ${v}/companies/{companyId}/periods`]: { tag: 'Companies', summary: 'List accounting periods', ok: [200, 'PeriodList', 'Periods'] },
  [`POST ${v}/companies/{companyId}/periods`]: { tag: 'Companies', summary: 'Create an accounting period (no overlaps)', body: ['CreatePeriodRequest', C.createPeriodSchema], ok: [201, 'Period', 'Created'], extraErrors: [409] },
  // ── Documents ──
  [`POST ${v}/documents`]: { tag: 'Documents', summary: 'Create a document and its first version; returns upload instructions', body: ['CreateDocumentRequest', C.createDocumentSchema], ok: [201, 'DocumentCreated', 'Created'] },
  [`GET ${v}/documents`]: { tag: 'Documents', summary: 'List documents', query: page.extend({ companyId: z.string().uuid().optional() }), ok: [200, 'DocumentPage', 'Page of documents'] },
  [`GET ${v}/documents/{documentId}`]: { tag: 'Documents', summary: 'Get a document with all versions', ok: [200, 'DocumentRecord', 'Document'] },
  [`POST ${v}/documents/{documentId}/archive`]: { tag: 'Documents', summary: 'Archive a document (never deleted; blocked by legal hold)', body: ['ArchiveDocumentRequest', C.archiveDocumentSchema], ok: [200, 'DocumentRecord', 'Archived'] },
  [`POST ${v}/documents/{documentId}/versions`]: { tag: 'Documents', summary: 'Add a new immutable version', body: ['NewVersionRequest', C.newVersionSchema], ok: [201, null, 'Version + upload instructions'] },
  [`PUT ${v}/documents/{documentId}/versions/{versionId}/content`]: { tag: 'Documents', summary: 'Upload content through the API (when no presigned URL is available)', binaryBody: true, ok: [200, 'DocumentVersion', 'Stored; processing is queued'], extraErrors: [413] },
  [`POST ${v}/documents/{documentId}/versions/{versionId}/complete`]: { tag: 'Documents', summary: 'Signal that a presigned upload finished; queues scanning', ok: [200, 'DocumentVersion', 'Queued'] },
  [`GET ${v}/documents/{documentId}/versions/{versionId}/download`]: { tag: 'Documents', summary: 'Get a short-lived download link (AVAILABLE versions only)', ok: [200, 'DownloadLink', 'Link'] },
  [`GET ${v}/documents/{documentId}/versions/{versionId}/content`]: { tag: 'Documents', summary: 'Stream content through the API (AVAILABLE versions only)', binaryResponse: true, ok: [200, null, 'File bytes'] },
  // ── Jobs ──
  [`GET ${v}/jobs`]: { tag: 'Jobs', summary: 'List background jobs', query: page, ok: [200, 'JobPage', 'Page of jobs'] },
  [`GET ${v}/jobs/{jobId}`]: { tag: 'Jobs', summary: 'Job status, progress and result (payloads are never returned)', ok: [200, 'Job', 'Job'] },
  [`POST ${v}/jobs/{jobId}/retry`]: { tag: 'Jobs', summary: 'Retry a FAILED/DEAD job', ok: [202, 'Job', 'Re-queued'] },
  [`POST ${v}/jobs/echo`]: { tag: 'Jobs', summary: 'Enqueue a harmless test job (exercises retries/backoff/DLQ)', body: ['EnqueueEchoRequest', C.enqueueEchoSchema], ok: [202, 'Job', 'Queued'] },
  // ── Tasks ──
  [`POST ${v}/tasks`]: { tag: 'Tasks', summary: 'Create a task (optionally assigned; assignment publishes task.assigned)', body: ['CreateTaskRequest', C.createTaskSchema], ok: [201, 'Task', 'Created'] },
  [`GET ${v}/tasks`]: { tag: 'Tasks', summary: 'List tasks', query: C.taskListQuerySchema, ok: [200, 'TaskPage', 'Page of tasks'] },
  [`GET ${v}/tasks/{taskId}`]: { tag: 'Tasks', summary: 'Get a task', ok: [200, 'Task', 'Task'] },
  [`PATCH ${v}/tasks/{taskId}`]: { tag: 'Tasks', summary: 'Update / complete / reassign a task', body: ['UpdateTaskRequest', C.updateTaskSchema], ok: [200, 'Task', 'Updated'] },
  // ── Workflows ──
  [`GET ${v}/reference/currencies`]: { tag: 'Reference data', summary: 'ISO 4217 currencies (read-only)', ok: [200, 'CurrencyList', 'Currencies'] },
  [`GET ${v}/reference/countries`]: { tag: 'Reference data', summary: 'ISO 3166-1 countries (read-only)', ok: [200, 'CountryList', 'Countries'] },
  [`GET ${v}/reference/tax-jurisdictions`]: { tag: 'Reference data', summary: 'Tax jurisdiction definitions in force on a date (effective-dated; default today)', query: C.asOfQuerySchema, ok: [200, 'TaxJurisdictionList', 'Jurisdictions'] },
  [`POST ${v}/contacts`]: { tag: 'Contacts', summary: 'Create a contact (organisation-level, or attached to one company)', body: ['CreateContactRequest', C.createContactSchema], ok: [201, 'Contact', 'Created'] },
  [`GET ${v}/contacts`]: { tag: 'Contacts', summary: 'List contacts the caller can see', query: C.contactListQuerySchema, ok: [200, 'ContactPage', 'Page of contacts'] },
  [`GET ${v}/contacts/{contactId}`]: { tag: 'Contacts', summary: 'Get a contact', ok: [200, 'Contact', 'Contact'] },
  [`PATCH ${v}/contacts/{contactId}`]: { tag: 'Contacts', summary: 'Update a contact', body: ['UpdateContactRequest', C.updateContactSchema], ok: [200, 'Contact', 'Updated'] },
  [`POST ${v}/contacts/{contactId}/archive`]: { tag: 'Contacts', summary: 'Archive a contact (never deleted)', query: C.reasonQuerySchema, ok: [200, 'Contact', 'Archived'] },
  [`POST ${v}/contacts/{contactId}/restore`]: { tag: 'Contacts', summary: 'Restore an archived contact', ok: [200, 'Contact', 'Restored'] },
  [`GET ${v}/contacts/{contactId}/addresses`]: { tag: 'Contacts', summary: 'A contact\'s addresses', ok: [200, 'AddressList', 'Addresses'] },
  [`POST ${v}/contacts/{contactId}/addresses`]: { tag: 'Contacts', summary: 'Add an address to a contact (one primary per kind)', body: ['CreateAddressRequest', C.createAddressSchema], ok: [201, 'Address', 'Created'] },
  [`PATCH ${v}/contacts/{contactId}/addresses/{addressId}`]: { tag: 'Contacts', summary: 'Update a contact address', body: ['UpdateAddressRequest', C.updateAddressSchema], ok: [200, 'Address', 'Updated'] },
  [`DELETE ${v}/contacts/{contactId}/addresses/{addressId}`]: { tag: 'Contacts', summary: 'Delete a contact address (audited)', query: C.reasonQuerySchema, ok: [204, null, 'Deleted'] },
  [`GET ${v}/companies/{companyId}/addresses`]: { tag: 'Companies', summary: 'A company\'s addresses (registered office, trading, correspondence)', ok: [200, 'AddressList', 'Addresses'] },
  [`POST ${v}/companies/{companyId}/addresses`]: { tag: 'Companies', summary: 'Add a company address (one primary per kind)', body: ['CreateAddressRequest', C.createAddressSchema], ok: [201, 'Address', 'Created'] },
  [`PATCH ${v}/companies/{companyId}/addresses/{addressId}`]: { tag: 'Companies', summary: 'Update a company address', body: ['UpdateAddressRequest', C.updateAddressSchema], ok: [200, 'Address', 'Updated'] },
  [`DELETE ${v}/companies/{companyId}/addresses/{addressId}`]: { tag: 'Companies', summary: 'Delete a company address (audited)', query: C.reasonQuerySchema, ok: [204, null, 'Deleted'] },
  [`GET ${v}/companies/{companyId}/officers`]: { tag: 'Companies', summary: 'Directors and officers (history included unless active=true)', query: z.object({ active: z.enum(['true', 'false']).optional() }), ok: [200, 'OfficerList', 'Officers'] },
  [`POST ${v}/companies/{companyId}/officers`]: { tag: 'Companies', summary: 'Appoint a director / officer from a contact', body: ['CreateOfficerRequest', C.createOfficerSchema], ok: [201, 'Officer', 'Appointed'], extraErrors: [409] },
  [`PATCH ${v}/companies/{companyId}/officers/{officerId}`]: { tag: 'Companies', summary: 'Record (or clear) a resignation; the appointment history is kept', body: ['UpdateOfficerRequest', C.updateOfficerSchema], ok: [200, 'Officer', 'Updated'] },
  [`GET ${v}/feature-flags`]: { tag: 'Feature flags', summary: 'Every feature flag with its effective value and where it comes from (organisation override, environment, registry default)', ok: [200, 'FeatureFlagList', 'Flags'] },
  [`PUT ${v}/feature-flags/{key}`]: { tag: 'Feature flags', summary: 'Turn a feature on or off for this organisation (org:manage; audited with before/after and reason)', body: ['SetFeatureFlagRequest', C.setFeatureFlagSchema], ok: [200, 'FeatureFlag', 'Updated'] },
  [`DELETE ${v}/feature-flags/{key}`]: { tag: 'Feature flags', summary: 'Remove the organisation override; the flag returns to the environment/registry default', query: C.reasonQuerySchema, ok: [204, null, 'Cleared'] },
  [`POST ${v}/practices`]: { tag: 'Practices', summary: 'Create a practice (practice organisations only)', body: ['CreatePracticeRequest', C.createPracticeSchema], ok: [201, 'Practice', 'Created'], extraErrors: [409] },
  [`GET ${v}/practices`]: { tag: 'Practices', summary: 'List practices the caller can see', ok: [200, 'PracticeList', 'Practices'] },
  [`GET ${v}/practices/{practiceId}`]: { tag: 'Practices', summary: 'Get a practice', ok: [200, 'Practice', 'Practice'] },
  [`PATCH ${v}/practices/{practiceId}`]: { tag: 'Practices', summary: 'Rename or archive a practice', body: ['UpdatePracticeRequest', C.updatePracticeSchema], ok: [200, 'Practice', 'Updated'] },
  [`GET ${v}/practices/{practiceId}/members`]: { tag: 'Practices', summary: 'Members holding a practice-level role', ok: [200, 'GrantList', 'Members'] },
  [`PUT ${v}/practices/{practiceId}/members/{membershipId}`]: { tag: 'Practices', summary: 'Grant or change a practice-level role (bounded by the granter\'s own rights)', body: ['SetGrantRequest', C.setGrantSchema], ok: [200, 'GrantResult', 'Granted'] },
  [`DELETE ${v}/practices/{practiceId}/members/{membershipId}`]: { tag: 'Practices', summary: 'Remove a practice-level role', query: C.reasonQuerySchema, ok: [204, null, 'Removed'] },
  [`GET ${v}/companies/{companyId}/access`]: { tag: 'Companies', summary: 'Members holding an explicit company-level role', ok: [200, 'GrantList', 'Grants'] },
  [`PUT ${v}/companies/{companyId}/access/{membershipId}`]: { tag: 'Companies', summary: 'Grant or change a company-level role (the most specific grant; bounded by the granter\'s own rights on that company)', body: ['SetGrantRequest', C.setGrantSchema], ok: [200, 'GrantResult', 'Granted'] },
  [`DELETE ${v}/companies/{companyId}/access/{membershipId}`]: { tag: 'Companies', summary: 'Remove a company-level role', query: C.reasonQuerySchema, ok: [204, null, 'Removed'] },
  [`POST ${v}/workflows/{workflowId}/reassign`]: { tag: 'Workflows', summary: 'Reassign (or unassign) a workflow; recorded in the history', body: ['ReassignWorkflowRequest', C.reassignWorkflowSchema], ok: [200, 'WorkflowInstance', 'Reassigned'] },
  [`GET ${v}/workflows/definitions`]: { tag: 'Workflows', summary: 'Registered workflow definitions', ok: [200, 'WorkflowDefinitionList', 'Definitions'] },
  [`POST ${v}/workflows`]: { tag: 'Workflows', summary: 'Start an API-startable workflow', body: ['StartWorkflowRequest', C.startWorkflowSchema], ok: [201, 'WorkflowInstance', 'Started'] },
  [`GET ${v}/workflows`]: { tag: 'Workflows', summary: 'List workflow instances', query: page.extend({ type: z.string().optional(), state: z.string().optional() }), ok: [200, 'WorkflowPage', 'Page'] },
  [`GET ${v}/workflows/{workflowId}`]: { tag: 'Workflows', summary: 'Workflow with history and the actions the caller may take', ok: [200, 'WorkflowDetail', 'Workflow'] },
  [`POST ${v}/workflows/{workflowId}/transitions`]: { tag: 'Workflows', summary: 'Perform a transition (permission, segregation of duties and optimistic concurrency enforced)', body: ['TransitionWorkflowRequest', C.transitionWorkflowSchema], ok: [200, 'WorkflowInstance', 'Transitioned'], extraErrors: [409] },
  // ── Notifications ──
  [`GET ${v}/notifications`]: { tag: 'Notifications', summary: 'The caller\'s notifications (private to the recipient)', query: page, ok: [200, 'NotificationPage', 'Page'] },
  [`GET ${v}/notifications/unread-count`]: { tag: 'Notifications', summary: 'Unread count', ok: [200, 'UnreadCount', 'Count'] },
  [`POST ${v}/notifications/read-all`]: { tag: 'Notifications', summary: 'Mark all as read', ok: [200, 'UpdatedCount', 'Updated'] },
  [`POST ${v}/notifications/{notificationId}/read`]: { tag: 'Notifications', summary: 'Mark one as read', ok: [200, null, 'Read'] },
  // ── Integrations ──
  [`GET ${v}/integrations/providers`]: { tag: 'Integrations', summary: 'Registered integration providers', ok: [200, 'ProviderList', 'Providers'] },
  [`GET ${v}/integrations/connections`]: { tag: 'Integrations', summary: 'Connections (credentials are never returned)', ok: [200, 'ConnectionList', 'Connections'] },
  [`POST ${v}/integrations/connections`]: { tag: 'Integrations', summary: 'Connect a provider (credentials are validated then stored encrypted)', body: ['CreateConnectionRequest', C.createConnectionSchema], ok: [201, 'Connection', 'Connected'] },
  [`DELETE ${v}/integrations/connections/{connectionId}`]: { tag: 'Integrations', summary: 'Revoke a connection and wipe its credentials', query: C.reasonQuerySchema, ok: [204, null, 'Revoked'] },
  [`POST ${v}/integrations/connections/{connectionId}/check`]: { tag: 'Integrations', summary: 'Health-check a connection', ok: [200, 'CheckResult', 'Result'] },
  [`POST ${v}/integrations/connections/{connectionId}/execute`]: { tag: 'Integrations', summary: 'Queue a provider operation (never executed inside the request)', body: ['ExecuteIntegrationRequest', z.object({ operation: z.string().max(100), params: z.record(z.unknown()).default({}) })], ok: [202, 'JobAccepted', 'Queued'] },
  // ── AI ──
  [`POST ${v}/ai/suggestions`]: { tag: 'AI', summary: 'Request an AI suggestion (async). The result is a PROPOSAL awaiting human review.', body: ['RequestAiSuggestionRequest', C.requestAiSuggestionSchema], ok: [202, 'JobAccepted', 'Queued'], extraErrors: [503] },
  [`GET ${v}/ai/proposals`]: { tag: 'AI', summary: 'List AI proposals', query: page.extend({ status: z.enum(['SUGGESTED', 'UNDER_REVIEW', 'ACCEPTED', 'REJECTED']).optional() }), ok: [200, 'AiProposalPage', 'Page'] },
  [`GET ${v}/ai/proposals/{proposalId}`]: { tag: 'AI', summary: 'Get a proposal', ok: [200, 'AiProposal', 'Proposal'] },
  [`POST ${v}/ai/proposals/{proposalId}/review`]: { tag: 'AI', summary: 'Take a SUGGESTED proposal into human review (SUGGESTED -> UNDER_REVIEW; requires ai:approve)', ok: [200, 'AiProposal', 'Under review'] },
  [`POST ${v}/ai/proposals/{proposalId}/decision`]: { tag: 'AI', summary: 'Accept or reject a proposal that is UNDER_REVIEW (requires ai:approve; recorded in workflow history). Accepting applies nothing: the owning module acts through its own authorised service.', body: ['DecideProposalRequest', C.decideProposalSchema], ok: [200, 'AiProposal', 'Decided'], extraErrors: [409] },
  // ── Audit ──
  [`GET ${v}/audit-events`]: { tag: 'Audit', summary: 'Append-only audit trail, filtered by the caller\'s per-company audit:read access. Events carry before/after (changed fields only), reason and source workflow.', query: C.auditQuerySchema, ok: [200, 'AuditEventPage', 'Page'] },
};
