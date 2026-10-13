import { z } from 'zod';
import { moneyString } from './ledger';
import { quantityString } from './sales';

/**
 * V1-M6a purchase documents (DEC-033, DEC-034; mirrors M5a): supplier bills and debit notes. A bill carries the supplier's own invoice number (the
 * duplicate key); approval takes an internal gapless number, stores the supplier snapshot, recomputes VAT with verified rates and posts it. Approved
 * documents are immutable: corrections are debit notes. Amounts are decimal STRINGS in the document currency.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
const uuid = z.string().uuid();
const reason = z.string().trim().min(10).max(1000);
const prefix = z.string().regex(/^[A-Za-z0-9/_-]{0,10}$/, 'Up to 10 letters, digits, /, _ or -');

export const PURCHASE_DOCUMENT_KINDS = ['BILL', 'DEBIT_NOTE'] as const;
export type PurchaseDocumentKind = (typeof PURCHASE_DOCUMENT_KINDS)[number];
export const PURCHASE_PAYMENT_STATUSES = ['UNPAID', 'PART_PAID', 'PAID', 'UNALLOCATED', 'PART_ALLOCATED', 'ALLOCATED'] as const;

export const purchaseSettingsSchema = z.object({
  /** A TRADE_PAYABLES control account of the company. */
  payablesAccountId: uuid.nullable(),
  billPrefix: prefix.default('BILL-'), debitNotePrefix: prefix.default('DN-'),
  billStart: z.number().int().min(1).max(999_999_999).default(1), debitNoteStart: z.number().int().min(1).max(999_999_999).default(1),
  requireSeparateApprover: z.boolean().default(false),
  reason,
}).strict();

export const purchaseLineSchema = z.object({
  description: z.string().trim().min(1).max(500),
  quantity: quantityString.default('1'),
  unitPrice: moneyString,
  /** Otherwise the supplier's default expense account. */
  accountId: uuid.optional(),
  /** A PURCHASES (or BOTH) VAT code; reverse charge allowed (entered net). */
  taxCodeId: uuid.optional(),
}).strict();

const docFields = {
  issueDate: isoDate,
  supplyDate: isoDate.optional(),
  taxPoint: isoDate.optional(),
  notes: z.string().trim().max(2000).optional(),
};
export const createBillSchema = z.object({
  supplierRoleId: uuid,
  /** The supplier's own invoice number (DEC-034). */
  supplierReference: z.string().trim().min(1).max(100),
  ...docFields,
  dueDate: isoDate.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, upper case').optional(),
  amountsIncludeVat: z.boolean().default(false),
  lines: z.array(purchaseLineSchema).min(1).max(200),
}).strict().refine((d) => !d.dueDate || d.dueDate >= d.issueDate, { message: 'dueDate cannot precede issueDate', path: ['dueDate'] });
export const createDebitNoteSchema = z.object({
  originalBillId: uuid,
  /** The supplier's credit note number, if any. */
  supplierReference: z.string().trim().min(1).max(100).optional(),
  ...docFields,
  reason: z.string().trim().min(3).max(1000),
  lines: z.array(purchaseLineSchema).min(1).max(200).optional(),
}).strict();
export const updatePurchaseDraftSchema = z.object({
  revision: z.number().int().min(1),
  supplierReference: z.string().trim().min(1).max(100).optional(),
  issueDate: isoDate.optional(), supplyDate: isoDate.nullable().optional(), taxPoint: isoDate.nullable().optional(), dueDate: isoDate.optional(),
  notes: z.string().trim().max(2000).nullable().optional(), amountsIncludeVat: z.boolean().optional(), reason: z.string().trim().min(3).max(1000).optional(),
  lines: z.array(purchaseLineSchema).min(1).max(200).optional(),
}).strict();
export const approvePurchaseDocumentSchema = z.object({ duplicateOverrideReason: reason.optional() }).strict();
export const discardPurchaseDocumentSchema = z.object({ reason: z.string().trim().min(3).max(1000) }).strict();
export const attachPurchaseDocumentSchema = z.object({ documentId: uuid, note: z.string().trim().max(500).optional() }).strict();
export const purchaseDocumentListQuerySchema = z.object({
  kind: z.enum(PURCHASE_DOCUMENT_KINDS).optional(), status: z.enum(['DRAFT', 'APPROVED', 'DISCARDED']).optional(), paymentStatus: z.enum(PURCHASE_PAYMENT_STATUSES).optional(),
  supplierRoleId: uuid.optional(), from: isoDate.optional(), to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50), cursor: uuid.optional(),
}).strict();
/** The duplicate key of a supplier reference: upper case without spaces (DEC-034). */
export const normaliseSupplierReference = (r: string) => r.replace(/\s/g, '').toUpperCase();
