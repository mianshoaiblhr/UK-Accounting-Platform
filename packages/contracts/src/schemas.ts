import { z } from 'zod';
import { isValidYearEnd } from './financial-year';
import { passwordSchema } from '@uk/core';
import { PERMISSIONS } from './permissions';
import { DOCUMENT_VISIBILITY, documentMetadataSchema } from './documents';

const email = z.string().trim().toLowerCase().email().max(254);

export const registerSchema = z.object({
  email,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(120),
  organisationName: z.string().trim().min(1).max(160),
  organisationType: z.enum(['PRACTICE', 'BUSINESS']),
}).strict();
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({ email, password: z.string().min(1).max(128) }).strict();
export const mfaLoginSchema = z.object({ challengeToken: z.string().min(10).max(200), code: z.string().min(6).max(20) }).strict();
export const verifyEmailSchema = z.object({ token: z.string().min(10).max(200) }).strict();
export const forgotPasswordSchema = z.object({ email }).strict();
export const resetPasswordSchema = z.object({ token: z.string().min(10).max(200), newPassword: passwordSchema }).strict();
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).strict();
export const resendVerificationSchema = z.object({ email }).strict();
export const mfaConfirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
export const mfaDisableSchema = z.object({ currentPassword: z.string().min(1).max(128), code: z.string().min(6).max(20) }).strict();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
const countryCode = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 code, upper case');
const currencyCode = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, upper case');
export const yearEndSchema = z.object({ month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) }).strict()
  .refine((y) => isValidYearEnd(y), { message: 'Not a valid month/day (29 February means the last day of February)' });

/** Company profile fields shared by create and update. */
const companyProfile = {
  legalForm: z.enum(['LTD', 'LLP', 'SOLE_TRADER', 'PARTNERSHIP', 'CHARITY', 'OTHER']),
  incorporationDate: isoDate,
  yearEnd: yearEndSchema,
  baseCurrency: currencyCode,
  countryCode,
  taxJurisdictionCode: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,30}$/),
};
export const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(200),
  companyNumber: z.string().trim().regex(/^[A-Z0-9]{8}$/i, 'Company number must be 8 characters').optional(),
  legalForm: companyProfile.legalForm.default('LTD'),
  incorporationDate: companyProfile.incorporationDate.optional(),
  yearEnd: companyProfile.yearEnd.optional(),
  baseCurrency: companyProfile.baseCurrency.optional(),
  countryCode: companyProfile.countryCode.optional(),
  taxJurisdictionCode: companyProfile.taxJurisdictionCode.optional(),
  /** Managing practice. Required for practice organisations (defaulted when there is only one), forbidden for direct businesses. */
  practiceId: z.string().uuid().optional(),
}).strict();
export const updateCompanySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  legalForm: companyProfile.legalForm.optional(),
  incorporationDate: companyProfile.incorporationDate.nullable().optional(),
  yearEnd: companyProfile.yearEnd.nullable().optional(),
  baseCurrency: companyProfile.baseCurrency.optional(),
  countryCode: companyProfile.countryCode.optional(),
  taxJurisdictionCode: companyProfile.taxJurisdictionCode.nullable().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to change' });

export const createPeriodSchema = z.object({ startDate: isoDate, endDate: isoDate })
  .strict().refine((p) => p.startDate < p.endDate, { message: 'startDate must be before endDate', path: ['endDate'] });

/** Why a sensitive change is being made; recorded on the audit trail. */
export const reasonSchema = z.string().trim().min(1).max(500);
export const reasonQuerySchema = z.object({ reason: reasonSchema.optional() });
export const setFeatureFlagSchema = z.object({ enabled: z.boolean(), reason: reasonSchema.optional() }).strict();
export const archiveDocumentSchema = z.object({ reason: reasonSchema.optional() }).strict();

export const inviteMemberSchema = z.object({
  email,
  roleId: z.string().uuid(),
  companyScope: z.enum(['ALL', 'ASSIGNED']).default('ALL'),
  companyIds: z.array(z.string().uuid()).max(500).default([]),
}).strict();
export const acceptInvitationSchema = z.object({ token: z.string().min(10).max(200) }).strict();
export const updateMemberSchema = z.object({
  roleId: z.string().uuid().optional(),
  companyScope: z.enum(['ALL', 'ASSIGNED']).optional(),
  companyIds: z.array(z.string().uuid()).max(500).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
  reason: reasonSchema.optional(),
}).strict();

export const createRoleSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(300).default(''),
  permissions: z.array(z.enum(PERMISSIONS)).min(1),
}).strict();

export const createDocumentSchema = z.object({
  name: z.string().trim().min(1).max(255),
  companyId: z.string().uuid().optional(),
  contentType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/).max(120),
  sizeBytes: z.number().int().positive(),
  documentClass: z.string().max(60).default('GENERAL'),
  folderId: z.string().uuid().optional(), periodId: z.string().uuid().optional(),
  description: z.string().trim().max(2000).optional(), documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date').optional(),
  reference: z.string().trim().min(1).max(120).optional(),
  labels: z.array(z.string().trim().min(1).max(40)).max(10).transform((a) => [...new Set(a)]).optional(),
  metadata: documentMetadataSchema.optional(), visibility: z.enum(DOCUMENT_VISIBILITY).default('STANDARD'),
}).strict();
export const newVersionSchema = createDocumentSchema.pick({ contentType: true, sizeBytes: true }).strict();

export const enqueueEchoSchema = z.object({ message: z.string().max(500), failTimes: z.number().int().min(0).max(10).default(0) }).strict();

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});

export const ALLOWED_UPLOAD_TYPES = [
  'application/pdf', 'image/png', 'image/jpeg', 'text/csv', 'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/xml', 'text/xml', 'application/zip',
] as const;

export const startWorkflowSchema = z.object({
  type: z.string().max(60), subjectType: z.string().max(60), subjectId: z.string().max(100),
  companyId: z.string().uuid().optional(), context: z.record(z.unknown()).default({}),
  /** Deadline (ISO 8601 with offset); must be in the future. Overrides the definition's SLA. */
  dueAt: z.string().datetime({ offset: true }).refine((v) => Date.parse(v) > Date.now(), 'dueAt must be in the future').optional(),
}).strict();
export const transitionWorkflowSchema = z.object({
  action: z.string().max(60), comment: z.string().max(2000).optional(), expectedVersion: z.number().int().positive().optional(),
  /** Documents offered as evidence for this transition (same organisation/company, readable by the actor). */
  evidenceDocumentIds: z.array(z.string().uuid()).max(50).optional(),
}).strict();
/** `dueAt: null` clears the deadline. */
export const setWorkflowDueDateSchema = z.object({
  dueAt: z.string().datetime({ offset: true }).nullable(), comment: z.string().max(2000).optional(), expectedVersion: z.number().int().positive().optional(),
}).strict();
export const reassignWorkflowSchema = z.object({ assigneeUserId: z.string().uuid().nullable(), comment: z.string().max(2000).optional() }).strict();

export const createPracticeSchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();
export const updatePracticeSchema = z.object({ name: z.string().trim().min(1).max(200).optional(), status: z.enum(['ACTIVE', 'ARCHIVED']).optional() }).strict();
/** Grants `roleId` to a member at practice level (PUT) or company level (PUT). The path names the target. */
export const setGrantSchema = z.object({ roleId: z.string().uuid() }).strict();

export const TASK_STATUSES = ['OPEN', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED'] as const;
/** Sources a client may declare. SYSTEM and EVENT are reserved for platform-created tasks. */
export const TASK_CLIENT_SOURCES = ['MANUAL', 'WORKFLOW', 'AI_PROPOSAL', 'DOCUMENT'] as const;
const taskDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().max(5000).default(''),
  companyId: z.string().uuid().optional(), assigneeUserId: z.string().uuid().optional(), reviewerUserId: z.string().uuid().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH']).default('NORMAL'),
  dueDate: taskDate.optional(),
  source: z.enum(TASK_CLIENT_SOURCES).default('MANUAL'), sourceId: z.string().trim().min(1).max(200).optional(),
}).strict().refine((t) => t.source === 'MANUAL' || !!t.sourceId, { message: 'sourceId is required when source is not MANUAL', path: ['sourceId'] })
  .refine((t) => !t.reviewerUserId || t.reviewerUserId !== t.assigneeUserId, { message: 'The reviewer cannot be the assignee', path: ['reviewerUserId'] });
export const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(), description: z.string().max(5000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH']).optional(), dueDate: taskDate.nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(), reviewerUserId: z.string().uuid().nullable().optional(),
}).strict();
export const taskListQuerySchema = paginationSchema.extend({
  status: z.enum(TASK_STATUSES).optional(), assignee: z.enum(['me', 'any']).default('any'), reviewer: z.enum(['me', 'any']).default('any'),
  companyId: z.string().uuid().optional(), priority: z.enum(['LOW', 'NORMAL', 'HIGH']).optional(),
  source: z.enum(['MANUAL', 'WORKFLOW', 'AI_PROPOSAL', 'DOCUMENT', 'EVENT', 'SYSTEM']).optional(),
  dueBefore: taskDate.optional(), overdue: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
});
export const reviewTaskSchema = z.object({ decision: z.enum(['APPROVE', 'RETURN']), comment: z.string().trim().min(1).max(5000).optional() }).strict()
  .refine((r) => r.decision === 'APPROVE' || !!r.comment, { message: 'A comment is required when returning a task', path: ['comment'] });
export const createTaskCommentSchema = z.object({ body: z.string().trim().min(1).max(5000) }).strict();
export const attachTaskDocumentSchema = z.object({ documentId: z.string().uuid() }).strict();
export const createTaskReminderSchema = z.object({
  remindAt: z.string().datetime({ offset: true }), recipientUserId: z.string().uuid().optional(),
}).strict();

export const createConnectionSchema = z.object({
  provider: z.string().max(60), displayName: z.string().trim().min(1).max(120),
  companyId: z.string().uuid().optional(), credentials: z.record(z.unknown()),
}).strict();

export const requestAiSuggestionSchema = z.object({
  purpose: z.string().regex(/^[a-z][a-z0-9_]{2,60}$/), input: z.string().min(1).max(20_000), companyId: z.string().uuid().optional(),
}).strict();
export const decideProposalSchema = z.object({ decision: z.enum(['ACCEPT', 'REJECT']), comment: z.string().max(2000).optional() }).strict();

export const auditQuerySchema = paginationSchema.extend({
  action: z.string().max(100).optional(), entityType: z.string().max(60).optional(), entityId: z.string().max(100).optional(),
  companyId: z.string().uuid().optional(), actorUserId: z.string().uuid().optional(), outcome: z.enum(['SUCCESS', 'FAILURE', 'DENIED']).optional(),
  sourceWorkflowId: z.string().uuid().optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(),
});

// ───────────── Master data ─────────────
export const createContactSchema = z.object({
  /** Omit for an organisation-level contact; set to attach the contact to one company (it then follows that company's access rules). */
  companyId: z.string().uuid().optional(),
  kind: z.enum(['PERSON', 'ORGANISATION']),
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(254).optional(),
  phone: z.string().trim().max(40).optional(),
  reference: z.string().trim().max(100).optional(),
  labels: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  notes: z.string().max(2000).optional(),
}).strict();
export const updateContactSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  email: z.string().trim().toLowerCase().email().max(254).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  reference: z.string().trim().max(100).nullable().optional(),
  labels: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  notes: z.string().max(2000).nullable().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to change' });
export const contactListQuerySchema = paginationSchema.extend({
  companyId: z.string().uuid().optional(), kind: z.enum(['PERSON', 'ORGANISATION']).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).default('ACTIVE'), q: z.string().trim().min(1).max(100).optional(),
});

const GB_POSTCODE = /^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$/i;
const addressFields = {
  kind: z.enum(['REGISTERED_OFFICE', 'TRADING', 'CORRESPONDENCE', 'RESIDENTIAL', 'OTHER']),
  line1: z.string().trim().min(1).max(200), line2: z.string().trim().max(200).optional(), line3: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100), region: z.string().trim().max(100).optional(), postcode: z.string().trim().max(20).optional(),
  countryCode, primary: z.boolean().default(false),
};
export const createAddressSchema = z.object(addressFields).strict()
  .refine((a) => a.countryCode !== 'GB' || !a.postcode || GB_POSTCODE.test(a.postcode), { message: 'Not a valid UK postcode', path: ['postcode'] });
export const updateAddressSchema = z.object({
  kind: addressFields.kind.optional(), line1: addressFields.line1.optional(), line2: z.string().trim().max(200).nullable().optional(), line3: z.string().trim().max(200).nullable().optional(),
  city: addressFields.city.optional(), region: z.string().trim().max(100).nullable().optional(), postcode: z.string().trim().max(20).nullable().optional(),
  countryCode: countryCode.optional(), primary: z.boolean().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to change' })
  .refine((a) => a.countryCode !== 'GB' || !a.postcode || GB_POSTCODE.test(a.postcode), { message: 'Not a valid UK postcode', path: ['postcode'] });

export const createOfficerSchema = z.object({
  contactId: z.string().uuid(),
  role: z.enum(['DIRECTOR', 'SECRETARY', 'PERSON_WITH_SIGNIFICANT_CONTROL', 'MEMBER', 'PARTNER', 'TRUSTEE', 'OTHER']),
  appointedOn: isoDate, resignedOn: isoDate.optional(),
}).strict().refine((o) => !o.resignedOn || o.resignedOn >= o.appointedOn, { message: 'resignedOn cannot precede appointedOn', path: ['resignedOn'] });
export const updateOfficerSchema = z.object({ resignedOn: isoDate.nullable() }).strict();
export const asOfQuerySchema = z.object({ asOf: isoDate.optional(), countryCode: countryCode.optional() });
