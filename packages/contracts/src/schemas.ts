import { z } from 'zod';
import { passwordSchema } from '@uk/core';
import { PERMISSIONS } from './permissions';

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

export const createCompanySchema = z.object({
  name: z.string().trim().min(1).max(200),
  companyNumber: z.string().trim().regex(/^[A-Z0-9]{8}$/i, 'Company number must be 8 characters').optional(),
  legalForm: z.enum(['LTD', 'LLP', 'SOLE_TRADER', 'PARTNERSHIP', 'CHARITY', 'OTHER']).default('LTD'),
}).strict();
export const updateCompanySchema = z.object({ name: z.string().trim().min(1).max(200) }).strict();

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)), 'Invalid date');
export const createPeriodSchema = z.object({ startDate: isoDate, endDate: isoDate })
  .strict().refine((p) => p.startDate < p.endDate, { message: 'startDate must be before endDate', path: ['endDate'] });

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
}).strict();
export const transitionWorkflowSchema = z.object({
  action: z.string().max(60), comment: z.string().max(2000).optional(), expectedVersion: z.number().int().positive().optional(),
}).strict();

export const createTaskSchema = z.object({
  title: z.string().trim().min(1).max(200), description: z.string().max(5000).default(''),
  companyId: z.string().uuid().optional(), assigneeUserId: z.string().uuid().optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH']).default('NORMAL'),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();
export const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(), description: z.string().max(5000).optional(),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH']).optional(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
}).strict();
export const taskListQuerySchema = paginationSchema.extend({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(), assignee: z.enum(['me', 'any']).default('any'),
});

export const createConnectionSchema = z.object({
  provider: z.string().max(60), displayName: z.string().trim().min(1).max(120),
  companyId: z.string().uuid().optional(), credentials: z.record(z.unknown()),
}).strict();

export const requestAiSuggestionSchema = z.object({
  purpose: z.string().regex(/^[a-z][a-z0-9_]{2,60}$/), input: z.string().min(1).max(20_000), companyId: z.string().uuid().optional(),
}).strict();
export const decideProposalSchema = z.object({ decision: z.enum(['APPROVE', 'REJECT']), comment: z.string().max(2000).optional() }).strict();
