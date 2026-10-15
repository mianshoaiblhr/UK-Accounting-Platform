import { z } from 'zod';
import { moneyString, negativeCashReason } from './ledger';
import { isValidIban } from './schemas';

/**
 * V1-M7a bank (DEC-038..041): bank accounts over CURRENT_ASSET_BANK ledger accounts, CSV statement imports run by the worker (ADR-61), immutable
 * statement lines, and transfers between bank and cash accounts. Amounts are decimal STRINGS.
 */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');
const uuid = z.string().uuid();
const reason = z.string().trim().min(10).max(1000);
const signedMoney = z.string().regex(/^-?\d{1,15}(\.\d{1,4})?$/, 'A signed decimal string such as "-1234.50"');

/** UK sort code (6 digits, dashes optional), UK account number (8 digits), IBAN (checked by mod 97), BIC (8 or 11). */
export const bankAccountDetailsSchema = z.object({
  sortCode: z.string().trim().regex(/^\d{2}-?\d{2}-?\d{2}$/, 'Six digits, for example 12-34-56').transform((s) => s.replace(/-/g, '')).optional(),
  accountNumber: z.string().trim().regex(/^\d{8}$/, 'Eight digits').optional(),
  iban: z.string().trim().transform((s) => s.replace(/\s/g, '').toUpperCase()).refine(isValidIban, 'Not a valid IBAN').optional(),
  bic: z.string().trim().toUpperCase().regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, 'A BIC of 8 or 11 characters').optional(),
}).strict().refine((d) => (d.sortCode === undefined) === (d.accountNumber === undefined), { message: 'Give the sort code and the account number together', path: ['accountNumber'] })
  .refine((d) => d.sortCode || d.iban, { message: 'Give a UK sort code and account number, or an IBAN' });
export type BankAccountDetails = z.output<typeof bankAccountDetailsSchema>;

export const createBankAccountSchema = z.object({
  /** A CURRENT_ASSET_BANK ledger account of the company that has no bank account yet. */
  accountId: uuid,
  name: z.string().trim().min(1).max(100),
  bankName: z.string().trim().min(1).max(100).optional(),
  /** The account's currency; defaults to the company's. Fixed once a statement line exists. */
  currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, upper case').optional(),
  details: bankAccountDetailsSchema.optional(),
  /** The balance on the bank's own statement at the start of record keeping on the platform (the reconciliation proof starts here). */
  statementOpeningDate: isoDate,
  statementOpeningBalance: signedMoney.default('0'),
  chargesAccountId: uuid.optional(), interestReceivedAccountId: uuid.optional(), interestPaidAccountId: uuid.optional(),
}).strict();
export const updateBankAccountSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  bankName: z.string().trim().min(1).max(100).nullable().optional(),
  details: bankAccountDetailsSchema.nullable().optional(),
  statementOpeningDate: isoDate.optional(), statementOpeningBalance: signedMoney.optional(),
  chargesAccountId: uuid.nullable().optional(), interestReceivedAccountId: uuid.nullable().optional(), interestPaidAccountId: uuid.nullable().optional(),
  reason: z.string().trim().min(3).max(500),
}).strict();
export const closeBankAccountSchema = z.object({ reason }).strict();

// ───────────── Statement import (DEC-040) ─────────────
export const STATEMENT_DATE_FORMATS = ['DD/MM/YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY', 'MM/DD/YYYY', 'DD MMM YYYY', 'DD/MM/YY'] as const;
/** A column by its header name (when the file has a header row) or by its 1-based position. */
const column = z.union([z.string().trim().min(1).max(100), z.number().int().min(1).max(200)]);
export const statementMappingSchema = z.object({
  hasHeader: z.boolean().default(true),
  delimiter: z.enum([',', ';', '\t', '|']).default(','),
  dateColumn: column,
  dateFormat: z.enum(STATEMENT_DATE_FORMATS),
  descriptionColumn: column,
  referenceColumn: column.optional(),
  /** One signed column (positive = money in) ... */
  amountColumn: column.optional(),
  /** ... or separate money-in and money-out columns (both unsigned). */
  moneyInColumn: column.optional(),
  moneyOutColumn: column.optional(),
  /** Flip the sign of the amount column (some banks export money out as positive). */
  invertSign: z.boolean().default(false),
  /** The running balance after each line; when given, every row is checked against it. */
  balanceColumn: column.optional(),
}).strict()
  .refine((m) => (m.amountColumn !== undefined) !== (m.moneyInColumn !== undefined || m.moneyOutColumn !== undefined), { message: 'Map either amountColumn, or moneyInColumn and moneyOutColumn', path: ['amountColumn'] })
  .refine((m) => (m.moneyInColumn === undefined) === (m.moneyOutColumn === undefined), { message: 'Map both moneyInColumn and moneyOutColumn', path: ['moneyOutColumn'] })
  .refine((m) => !(m.invertSign && m.amountColumn === undefined), { message: 'invertSign applies to a single amount column', path: ['invertSign'] });
export type StatementMapping = z.output<typeof statementMappingSchema>;
export const requestStatementImportSchema = z.object({
  documentId: uuid, versionId: uuid,
  mapping: statementMappingSchema,
  /** The same file already imported into this account needs a reason (DEC-040). */
  duplicateOverrideReason: reason.optional(),
}).strict();
export const voidStatementImportSchema = z.object({ reason }).strict();
export const statementImportListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: uuid.optional() }).strict();
export const STATEMENT_LINE_STATUSES = ['UNMATCHED', 'PARTIAL', 'MATCHED', 'VOID'] as const;
export const statementLineListQuerySchema = z.object({
  status: z.enum(STATEMENT_LINE_STATUSES).optional(), importId: uuid.optional(), from: isoDate.optional(), to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100), cursor: uuid.optional(),
}).strict();
export const STATEMENT_IMPORT_MAX_ROWS = 20_000;

// ───────────── Transfers (DEC-041) ─────────────
const positive = moneyString.refine((a) => Number(a) > 0, 'Must be greater than zero');
export const createBankTransferSchema = z.object({
  /** Ledger accounts (bank or cash) of the company. */
  fromAccountId: uuid, toAccountId: uuid,
  transferDate: isoDate, amount: positive,
  /** The currency of both accounts; defaults to the company's. */
  currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, upper case').optional(),
  rateId: uuid.optional(),
  reference: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().min(1).max(500),
  duplicateOverrideReason: reason.optional(),
  negativeCashReason: negativeCashReason.optional(),
}).strict().refine((t) => t.fromAccountId !== t.toAccountId, { message: 'Choose two different accounts', path: ['toAccountId'] });
export const reverseBankTransferSchema = z.object({ reason: z.string().trim().min(3).max(1000), date: isoDate.optional(), negativeCashReason: negativeCashReason.optional() }).strict();
export const bankTransferListQuerySchema = z.object({
  accountId: uuid.optional(), status: z.enum(['POSTED', 'REVERSED']).optional(), from: isoDate.optional(), to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50), cursor: uuid.optional(),
}).strict();

// ───────────── Reconciliation (M7b, DEC-042) ─────────────
export const createBankMatchSchema = z.object({
  statementLineId: uuid, journalLineId: uuid,
  /** Unsigned; defaults to what is left on the smaller side. Partial matches leave the rest visible. */
  amount: positive.optional(),
  /** Needed when the bank date and the ledger date are more than 14 days apart. */
  overrideReason: reason.optional(),
  /** The match was accepted from a suggestion (recorded as such). */
  fromSuggestion: z.boolean().default(false),
}).strict();
export const unmatchSchema = z.object({ reason }).strict();
export const postFromStatementSchema = z.object({
  kind: z.enum(['CHARGE', 'INTEREST', 'OTHER']),
  /** Defaults to the bank account's charges or interest account; required for OTHER. */
  accountId: uuid.optional(),
  taxCodeId: uuid.optional(),
  description: z.string().trim().min(1).max(300).optional(),
  duplicateOverrideReason: reason.optional(),
  negativeCashReason: negativeCashReason.optional(),
}).strict();
export const suggestionQuerySchema = z.object({ from: isoDate.optional(), to: isoDate.optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).strict();
export const bankAsOfQuerySchema = z.object({ asOf: isoDate.optional() }).strict();
export const signOffSchema = z.object({
  asOf: isoDate,
  /** The closing balance printed on the bank's statement for that date: it must equal the imported statement (completeness). */
  bankClosingBalance: signedMoney,
  notes: z.string().trim().max(2000).optional(),
}).strict();
