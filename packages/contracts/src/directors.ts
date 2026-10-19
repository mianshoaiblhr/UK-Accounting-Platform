import { z } from 'zod';

/** V2-M4 (DEC-062): director and shareholder loan accounts, the firm's review thresholds, related parties. Registers over the ledger only. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
const uuid = z.string().uuid();
const reason = z.string().trim().min(3).max(500);
const amount = z.string().regex(/^\d{1,15}(\.\d{1,2})?$/, 'A decimal string such as "1000.00"').refine((s) => Number(s) > 0, 'Above zero');
const range = z.object({ from: isoDate, to: isoDate }).strict().refine((q) => q.to >= q.from, { message: 'to cannot precede from', path: ['to'] });

export const LOAN_ACCOUNT_KINDS = ['DIRECTOR', 'SHAREHOLDER', 'DIRECTOR_AND_SHAREHOLDER'] as const;
/** How a movement is categorised by the journal's other lines (VAT lines ignored); MIXED when they differ. */
export const LOAN_MOVEMENT_CATEGORIES = ['CASH_AND_BANK', 'EXPENSES', 'INCOME', 'DIVIDENDS', 'OTHER_LOAN_ACCOUNT', 'OTHER', 'MIXED'] as const;
/** Review prompts for the reviewer, not legal conclusions; the thresholds are the firm's own settings. */
export const LOAN_FLAGS = ['OVERDRAWN_AT_END', 'OVERDRAWN_IN_PERIOD', 'LARGE_MOVEMENT', 'OVERDRAWN_ABOVE_THRESHOLD'] as const;
export const RELATIONSHIPS = ['DIRECTOR', 'CLOSE_FAMILY_OF_DIRECTOR', 'SHAREHOLDER', 'ENTITY_CONTROLLED_BY_DIRECTOR', 'KEY_MANAGEMENT', 'PARENT', 'SUBSIDIARY', 'FELLOW_SUBSIDIARY', 'ASSOCIATE', 'JOINT_VENTURE', 'OTHER'] as const;

export const createLoanAccountSchema = z.object({ contactId: uuid, kind: z.enum(LOAN_ACCOUNT_KINDS), accountId: uuid, openedOn: isoDate, notes: z.string().trim().max(2000).optional() }).strict();
export const loanAccountListQuerySchema = z.object({ status: z.enum(['ACTIVE', 'CLOSED']).optional() }).strict();
export const closeLoanAccountSchema = z.object({ closedOn: isoDate, reason }).strict();
export const loanStatementQuerySchema = range;
export const loanReportQuerySchema = range;
export const setLoanThresholdsSchema = z.object({ largeMovement: amount.nullable(), overdrawn: amount.nullable(), reason }).strict();

export const createRelatedPartySchema = z.object({ contactId: uuid, relationship: z.enum(RELATIONSHIPS), description: z.string().trim().min(1).max(500), fromDate: isoDate }).strict();
export const relatedPartyListQuerySchema = z.object({ status: z.enum(['ACTIVE', 'ENDED']).optional() }).strict();
export const endRelatedPartySchema = z.object({ toDate: isoDate, reason }).strict();
export const relatedPartyReportQuerySchema = range;
