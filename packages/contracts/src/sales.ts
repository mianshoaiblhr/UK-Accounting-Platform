import { z } from 'zod';
import { moneyString } from './ledger';

/**
 * V1-M5a sales documents (DEC-026..031, ADR-59): invoices and credit notes. A DRAFT has no number and no ledger effect; approval numbers it without gaps,
 * stores the customer snapshot, recomputes every amount with the verified VAT rates and posts it through the PostingService. Approved documents are
 * immutable: corrections are credit notes. Amounts are decimal STRINGS in the document currency.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
const uuid = z.string().uuid();
const reason = z.string().trim().min(10).max(1000);

export const SALES_DOCUMENT_KINDS = ['INVOICE', 'CREDIT_NOTE'] as const;
export type SalesDocumentKind = (typeof SALES_DOCUMENT_KINDS)[number];
export const SALES_DOCUMENT_STATUSES = ['DRAFT', 'APPROVED', 'DISCARDED'] as const;
/** Derived from the outstanding amount of an approved document. */
export const SALES_PAYMENT_STATUSES = ['UNPAID', 'PART_PAID', 'PAID', 'UNALLOCATED', 'PART_ALLOCATED', 'ALLOCATED'] as const;
export const MAX_SALES_LINES = 200;

/** A positive quantity with at most 4 decimals, as a string. */
export const quantityString = z.string().regex(/^\d{1,12}(\.\d{1,4})?$/, 'A quantity such as "1" or "2.5", as a string').refine((q) => Number(q) > 0, 'Quantity must be greater than zero');
const prefix = z.string().regex(/^[A-Za-z0-9/_-]{0,10}$/, 'Up to 10 letters, digits, /, _ or -');

export const salesSettingsSchema = z.object({
  /** A TRADE_RECEIVABLES control account of the company. */
  receivablesAccountId: uuid.nullable(),
  invoicePrefix: prefix.default('INV-'), creditNotePrefix: prefix.default('CN-'),
  /** Start numbers (continuing a previous system's numbering); frozen once a document of the kind is approved. */
  invoiceStart: z.number().int().min(1).max(999_999_999).default(1), creditNoteStart: z.number().int().min(1).max(999_999_999).default(1),
  /** Separation of duties: the approver must be a different person from the preparer. */
  requireSeparateApprover: z.boolean().default(false),
  reason,
}).strict();

export const salesLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: quantityString.default('1'),
  /** Price per unit in the document currency; net, or gross when the document's amounts include VAT. */
  unitPrice: moneyString,
  accountId: uuid,
  /** A SALES (or BOTH) VAT code; the VAT is computed per line (DEC-025). */
  taxCodeId: uuid.optional(),
}).strict();

const docFields = {
  issueDate: isoDate,
  /** When the goods or services were supplied, if different; kept for review (DEC-028). */
  supplyDate: isoDate.optional(),
  /** Explicit tax point; otherwise the issue date (DEC-028). */
  taxPoint: isoDate.optional(),
  customerReference: z.string().trim().min(1).max(100).optional(),
  notes: z.string().trim().max(2000).optional(),
};

export const createInvoiceSchema = z.object({
  customerRoleId: uuid,
  ...docFields,
  /** Otherwise the issue date plus the customer's payment terms. */
  dueDate: isoDate.optional(),
  /** Otherwise the customer's default currency, else the company's. */
  currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, upper case').optional(),
  amountsIncludeVat: z.boolean().default(false),
  lines: z.array(salesLineSchema).min(1).max(MAX_SALES_LINES),
  /** A draft prepared from an ACCEPTED AI proposal (the person creating it is recorded; AI never approves). */
  aiProposalId: uuid.optional(),
}).strict().refine((d) => !d.dueDate || d.dueDate >= d.issueDate, { message: 'dueDate cannot precede issueDate', path: ['dueDate'] });

export const createCreditNoteSchema = z.object({
  originalInvoiceId: uuid,
  ...docFields,
  reason: z.string().trim().min(3).max(1000),
  /** Omitted: a full credit of the invoice's lines (only while nothing has been allocated against it). */
  lines: z.array(salesLineSchema).min(1).max(MAX_SALES_LINES).optional(),
}).strict();

export const updateSalesDraftSchema = z.object({
  /** The revision being edited (optimistic concurrency). */
  revision: z.number().int().min(1),
  issueDate: isoDate.optional(), supplyDate: isoDate.nullable().optional(), taxPoint: isoDate.nullable().optional(), dueDate: isoDate.optional(),
  customerReference: z.string().trim().min(1).max(100).nullable().optional(), notes: z.string().trim().max(2000).nullable().optional(),
  amountsIncludeVat: z.boolean().optional(), reason: z.string().trim().min(3).max(1000).optional(),
  lines: z.array(salesLineSchema).min(1).max(MAX_SALES_LINES).optional(),
}).strict();

export const approveSalesDocumentSchema = z.object({
  /** Required when the duplicate check finds a possible duplicate. */
  duplicateOverrideReason: reason.optional(),
  /** Required when the invoice takes the customer over the credit limit. */
  creditLimitOverrideReason: reason.optional(),
}).strict();
export const discardSalesDocumentSchema = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
export const attachSalesDocumentSchema = z.object({ documentId: uuid, note: z.string().trim().max(500).optional() }).strict();

export const salesDocumentListQuerySchema = z.object({
  kind: z.enum(SALES_DOCUMENT_KINDS).optional(), status: z.enum(SALES_DOCUMENT_STATUSES).optional(), paymentStatus: z.enum(SALES_PAYMENT_STATUSES).optional(),
  customerRoleId: uuid.optional(), from: isoDate.optional(), to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50), cursor: uuid.optional(),
}).strict();

// ───────────── Receipts (M5b, DEC-032) ─────────────
export const receiptAllocationSchema = z.object({ invoiceId: uuid, amount: moneyString.refine((a) => Number(a) > 0, 'Must be greater than zero') }).strict();
export const createReceiptSchema = z.object({
  customerRoleId: uuid,
  receiptDate: isoDate,
  /** Otherwise the company's currency. */
  currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, upper case').optional(),
  amount: moneyString.refine((a) => Number(a) > 0, 'Must be greater than zero'),
  /** A bank or cash account of the company. */
  bankAccountId: uuid,
  reference: z.string().trim().min(1).max(100).optional(),
  notes: z.string().trim().max(2000).optional(),
  /** Foreign currency only: a stored rate to use; otherwise the lookup rule applies (M3). */
  rateId: uuid.optional(),
  /** Allocate at entry (same customer and currency); the rest stays unallocated credit. */
  allocations: z.array(receiptAllocationSchema).max(100).default([]),
  /** Required when the duplicate check finds a possible duplicate receipt. */
  duplicateOverrideReason: reason.optional(),
}).strict();
export const allocateReceiptSchema = z.object({
  allocations: z.array(receiptAllocationSchema).min(1).max(100),
  /** Otherwise today, or the receipt date if later. Not before either document. */
  date: isoDate.optional(),
}).strict();
export const reverseReceiptSchema = z.object({ reason: z.string().trim().min(3).max(1000), date: isoDate.optional() }).strict();
export const receiptListQuerySchema = z.object({
  customerRoleId: uuid.optional(), status: z.enum(['POSTED', 'REVERSED']).optional(), unallocated: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
  from: isoDate.optional(), to: isoDate.optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: uuid.optional(),
}).strict();
export const statementQuerySchema = z.object({ from: isoDate, to: isoDate }).strict().refine((q) => q.to >= q.from, { message: 'to cannot precede from', path: ['to'] });
export const agedReceivablesQuerySchema = z.object({ asOf: isoDate.optional(), customerRoleId: uuid.optional() }).strict();
