import { z } from 'zod';
import { moneyString, negativeCashReason } from './ledger';

/**
 * V1-M6c cash transactions (DEC-036, DEC-037): money in or out of a bank or cash account without a source document, with VAT per line, posted when
 * recorded. Amounts are decimal STRINGS in the company's currency. Corrections are a mirror reversal with a reason; the record never changes.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
const uuid = z.string().uuid();
const positive = moneyString.refine((a) => Number(a) > 0, 'Must be greater than zero');

export const CASH_DIRECTIONS = ['PAYMENT', 'RECEIPT'] as const;
export type CashDirection = (typeof CASH_DIRECTIONS)[number];

export const cashLineSchema = z.object({
  description: z.string().trim().min(1).max(300),
  /** An expense, income, asset or liability account that is not a control account and not a bank or cash account. */
  accountId: uuid,
  /** The amount of the line: net, or gross when amountsIncludeVat. */
  amount: positive,
  taxCodeId: uuid.optional(),
}).strict();

export const createCashTransactionSchema = z.object({
  direction: z.enum(CASH_DIRECTIONS),
  transactionDate: isoDate,
  /** Only when the time of supply differs from the transaction date; it selects the VAT rate and the return period. */
  taxPoint: isoDate.optional(),
  /** The bank or cash account the money left (PAYMENT) or reached (RECEIPT). */
  bankAccountId: uuid,
  /** Optional link to a contact of the organisation or of this company. */
  contactId: uuid.optional(),
  /** Free text payee or payer when there is no contact (for example "Post Office"). */
  counterparty: z.string().trim().min(1).max(200).optional(),
  reference: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().min(1).max(500),
  /** The company's currency (foreign-currency cash transactions come with M7 and M5c). */
  currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, upper case').optional(),
  amountsIncludeVat: z.boolean().default(false),
  lines: z.array(cashLineSchema).min(1).max(150),
  /** The same account, direction, date and total as a transaction already recorded needs a reason. */
  duplicateOverrideReason: z.string().trim().min(10).max(1000).optional(),
  /** DEC-037: money out of cash in hand that would take it below zero needs the reason. */
  negativeCashReason: negativeCashReason.optional(),
}).strict();

export const reverseCashTransactionSchema = z.object({
  reason: z.string().trim().min(3).max(1000),
  date: isoDate.optional(),
  negativeCashReason: negativeCashReason.optional(),
}).strict();

export const cashTransactionListQuerySchema = z.object({
  direction: z.enum(CASH_DIRECTIONS).optional(), status: z.enum(['POSTED', 'REVERSED']).optional(), bankAccountId: uuid.optional(), contactId: uuid.optional(),
  from: isoDate.optional(), to: isoDate.optional(), limit: z.coerce.number().int().min(1).max(200).default(50), cursor: uuid.optional(),
}).strict();

export const attachCashTransactionSchema = z.object({ documentId: uuid, note: z.string().trim().max(500).optional() }).strict();
