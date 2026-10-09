import { z } from 'zod';

/**
 * V1 ledger contracts (ADR-44..48): account registries, the versioned reporting-line registry, journal sources, the default UK chart,
 * decimal-string money and the request schemas. Money is NEVER a JSON number: amounts are decimal strings ("1234.50").
 */

// ───────────── Accounts ─────────────
export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
/** Debit-normal types: balances are debits less credits; credit-normal types the reverse. */
export const DEBIT_NORMAL: readonly AccountType[] = ['ASSET', 'EXPENSE'];

export const ACCOUNT_SUBTYPES: Record<AccountType, readonly string[]> = {
  ASSET: ['FIXED_ASSET_TANGIBLE', 'FIXED_ASSET_INTANGIBLE', 'FIXED_ASSET_DEPRECIATION', 'CURRENT_ASSET_STOCK', 'CURRENT_ASSET_RECEIVABLE', 'CURRENT_ASSET_PREPAYMENT', 'CURRENT_ASSET_VAT', 'CURRENT_ASSET_BANK', 'CURRENT_ASSET_CASH', 'CURRENT_ASSET_OTHER'],
  LIABILITY: ['CURRENT_LIABILITY_PAYABLE', 'CURRENT_LIABILITY_ACCRUAL', 'CURRENT_LIABILITY_VAT', 'CURRENT_LIABILITY_PAYE', 'CURRENT_LIABILITY_TAX', 'CURRENT_LIABILITY_OTHER', 'LONG_TERM_LIABILITY'],
  EQUITY: ['SHARE_CAPITAL', 'RETAINED_EARNINGS', 'RESERVES', 'DIVIDENDS'],
  INCOME: ['SALES', 'OTHER_INCOME', 'INTEREST_INCOME'],
  EXPENSE: ['COST_OF_SALES', 'OVERHEADS', 'DEPRECIATION', 'INTEREST_EXPENSE', 'TAX_EXPENSE', 'OTHER_EXPENSE'],
};
export const ALL_SUBTYPES = Object.values(ACCOUNT_SUBTYPES).flat();

export const CONTROL_KINDS = ['TRADE_RECEIVABLES', 'TRADE_PAYABLES', 'VAT_CONTROL', 'BANK', 'CASH', 'SUSPENSE', 'RETAINED_EARNINGS'] as const;
export type ControlKind = (typeof CONTROL_KINDS)[number];
export const TAX_TREATMENTS = ['NOT_APPLICABLE', 'VATABLE', 'EXEMPT', 'OUT_OF_SCOPE', 'VAT_CONTROL'] as const;
export type TaxTreatment = (typeof TAX_TREATMENTS)[number];

/**
 * Reporting-line registry (VERSIONED: effective-dated mappings are manifest control 9; FRS 102/105 refine these in V2).
 * Changing a mapping for existing accounts is a new version, never an edit of history.
 */
export const REPORT_MAPPING_VERSION = 1;
export const REPORT_LINES: Record<string, { name: string; statement: 'PL' | 'BS'; types: readonly AccountType[] }> = {
  'PL.TURNOVER': { name: 'Turnover', statement: 'PL', types: ['INCOME'] },
  'PL.OTHER_INCOME': { name: 'Other operating income', statement: 'PL', types: ['INCOME'] },
  'PL.COST_OF_SALES': { name: 'Cost of sales', statement: 'PL', types: ['EXPENSE'] },
  'PL.ADMIN_EXPENSES': { name: 'Administrative expenses', statement: 'PL', types: ['EXPENSE'] },
  'PL.DEPRECIATION': { name: 'Depreciation', statement: 'PL', types: ['EXPENSE'] },
  'PL.INTEREST_RECEIVABLE': { name: 'Interest receivable', statement: 'PL', types: ['INCOME'] },
  'PL.INTEREST_PAYABLE': { name: 'Interest payable', statement: 'PL', types: ['EXPENSE'] },
  'PL.TAXATION': { name: 'Tax on profit', statement: 'PL', types: ['EXPENSE'] },
  'PL.OTHER_EXPENSES': { name: 'Other expenses', statement: 'PL', types: ['EXPENSE'] },
  'BS.FIXED_ASSETS.TANGIBLE': { name: 'Tangible fixed assets', statement: 'BS', types: ['ASSET'] },
  'BS.FIXED_ASSETS.INTANGIBLE': { name: 'Intangible assets', statement: 'BS', types: ['ASSET'] },
  'BS.CURRENT_ASSETS.STOCK': { name: 'Stocks', statement: 'BS', types: ['ASSET'] },
  'BS.CURRENT_ASSETS.DEBTORS': { name: 'Debtors', statement: 'BS', types: ['ASSET'] },
  'BS.CURRENT_ASSETS.CASH': { name: 'Cash at bank and in hand', statement: 'BS', types: ['ASSET'] },
  'BS.CREDITORS_WITHIN_ONE_YEAR': { name: 'Creditors: amounts falling due within one year', statement: 'BS', types: ['LIABILITY'] },
  'BS.CREDITORS_AFTER_ONE_YEAR': { name: 'Creditors: amounts falling due after more than one year', statement: 'BS', types: ['LIABILITY'] },
  'BS.CAPITAL.SHARE_CAPITAL': { name: 'Called up share capital', statement: 'BS', types: ['EQUITY'] },
  'BS.CAPITAL.RESERVES': { name: 'Profit and loss account and other reserves', statement: 'BS', types: ['EQUITY'] },
};

// ───────────── Journal sources ─────────────
export type ActorKind = 'USER' | 'SYSTEM' | 'AI';
export interface JournalSourceDef {
  /** Who may post with this source. AI is never listed (manifest control 10). */
  actors: readonly Exclude<ActorKind, 'AI'>[];
  /** Permission the posting actor must hold for the company. */
  permission: string;
  /** May touch control accounts (manual journals may not: sub-ledger integrity, ADR-46). */
  controlAccounts: boolean;
  description: string;
}
/** Later milestones append their sources here (SALES_INVOICE, RECEIPT, ...); the PostingService reads only this registry. */
export const JOURNAL_SOURCES: Record<string, JournalSourceDef> = {
  MANUAL: { actors: ['USER'], permission: 'journal:post', controlAccounts: false, description: 'Manual journal entered by a person' },
  OPENING_BALANCE: { actors: ['USER'], permission: 'journal:post', controlAccounts: true, description: 'Opening balances at the start of record keeping' },
  REVERSAL: { actors: ['USER'], permission: 'journal:post', controlAccounts: true, description: 'Mirror of an earlier journal (corrections are reversals, never edits)' },
};
export const isJournalSource = (s: string) => Object.prototype.hasOwnProperty.call(JOURNAL_SOURCES, s);
export const API_JOURNAL_SOURCES = ['MANUAL', 'OPENING_BALANCE'] as const;

// ───────────── Money (decimal strings) ─────────────
/** Non-negative decimal string, at most 4 fractional digits here; the PostingService enforces the currency's own minor units. */
export const moneyString = z.string().regex(/^\d{1,15}(\.\d{1,4})?$/, 'Amount must be a decimal string such as "1234.50"');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s), 'Invalid date');

// ───────────── Requests ─────────────
const accountCode = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{0,19}$/, 'Up to 20 letters, digits, dots or hyphens');
const accountFields = {
  code: accountCode, name: z.string().trim().min(1).max(200),
  type: z.enum(ACCOUNT_TYPES), subtype: z.string().refine((s) => ALL_SUBTYPES.includes(s), 'Unknown subtype'),
  isControl: z.boolean().default(false), controlKind: z.enum(CONTROL_KINDS).nullable().default(null),
  taxTreatment: z.enum(TAX_TREATMENTS).default('NOT_APPLICABLE'),
  reportingMapping: z.string().refine((s) => s in REPORT_LINES, 'Unknown reporting line'),
  activeFrom: isoDate.nullable().default(null), activeTo: isoDate.nullable().default(null),
};
export const createAccountSchema = z.object(accountFields).strict()
  .refine((a) => a.isControl === (a.controlKind !== null), { message: 'controlKind is required exactly when isControl is true', path: ['controlKind'] })
  .refine((a) => a.subtype === undefined || ACCOUNT_SUBTYPES[a.type].includes(a.subtype), { message: 'Subtype does not belong to the account type', path: ['subtype'] })
  .refine((a) => REPORT_LINES[a.reportingMapping]?.types.includes(a.type) ?? false, { message: 'Reporting line does not accept this account type', path: ['reportingMapping'] })
  .refine((a) => !a.activeFrom || !a.activeTo || a.activeTo >= a.activeFrom, { message: 'activeTo must not be before activeFrom', path: ['activeTo'] });
export const updateAccountSchema = z.object({
  name: accountFields.name.optional(), subtype: accountFields.subtype.optional(), taxTreatment: accountFields.taxTreatment.optional(),
  reportingMapping: accountFields.reportingMapping.optional(), activeFrom: isoDate.nullable().optional(), activeTo: isoDate.nullable().optional(),
  /** Mandatory when changing the reporting mapping or deactivating: the audit trail records why. */
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

export const journalLineSchema = z.object({
  accountId: z.string().uuid(), debit: moneyString.default('0'), credit: moneyString.default('0'), description: z.string().trim().max(300).optional(),
}).strict();
export const postJournalSchema = z.object({
  journalDate: isoDate, description: z.string().trim().min(1).max(500), source: z.enum(API_JOURNAL_SOURCES).default('MANUAL'),
  reference: z.string().trim().min(1).max(100).optional(),
  /** Optional and only ever the company's own currency: foreign-currency postings are refused (`foreign_currency_not_supported`) until milestone M3 (DEC-009). */
  currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, upper case').optional(),
  lines: z.array(journalLineSchema).min(2).max(500),
  idempotencyKey: z.string().trim().min(8).max(100).optional(),
}).strict();
export const reverseJournalSchema = z.object({ journalDate: isoDate.optional(), reason: z.string().trim().min(1).max(500) }).strict();
export const journalListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().max(100).optional(),
  from: isoDate.optional(), to: isoDate.optional(), source: z.string().max(40).optional(), accountId: z.string().uuid().optional(),
}).strict();
export const ledgerQuerySchema = z.object({
  accountId: z.string().uuid(), from: isoDate.optional(), to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(100).optional(),
}).strict();
export const trialBalanceQuerySchema = z.object({ periodId: z.string().uuid().optional(), asOf: isoDate.optional() }).strict()
  .refine((q) => !(q.periodId && q.asOf), { message: 'Give periodId or asOf, not both' });
export const periodTransitionSchema = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();
export const accountListQuerySchema = z.object({ active: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')), type: z.enum(ACCOUNT_TYPES).optional() }).strict();

// ───────────── Period states ─────────────
export const PERIOD_STATES = ['OPEN', 'CLOSED', 'LOCKED'] as const;
export type PeriodState = (typeof PERIOD_STATES)[number];
export type PeriodAction = 'close' | 'reopen' | 'lock' | 'unlock';
export const PERIOD_TRANSITIONS: Record<PeriodAction, { from: PeriodState; to: PeriodState; permission: string; reasonRequired: boolean }> = {
  close: { from: 'OPEN', to: 'CLOSED', permission: 'period:manage', reasonRequired: false },
  reopen: { from: 'CLOSED', to: 'OPEN', permission: 'period:manage', reasonRequired: true },
  lock: { from: 'CLOSED', to: 'LOCKED', permission: 'period:lock', reasonRequired: true },
  unlock: { from: 'LOCKED', to: 'CLOSED', permission: 'period:lock', reasonRequired: true },
};

// ───────────── Default UK chart of accounts (template, versioned) ─────────────
export const DEFAULT_CHART_VERSION = 1;
export interface ChartTemplateAccount {
  code: string; name: string; type: AccountType; subtype: string; mapping: string;
  control?: ControlKind; tax?: TaxTreatment; system?: boolean;
}
const A = (code: string, name: string, type: AccountType, subtype: string, mapping: string, o: Partial<ChartTemplateAccount> = {}): ChartTemplateAccount => ({ code, name, type, subtype, mapping, ...o });
export const DEFAULT_CHART: readonly ChartTemplateAccount[] = [
  A('0010', 'Intangible assets', 'ASSET', 'FIXED_ASSET_INTANGIBLE', 'BS.FIXED_ASSETS.INTANGIBLE'),
  A('0020', 'Plant and machinery', 'ASSET', 'FIXED_ASSET_TANGIBLE', 'BS.FIXED_ASSETS.TANGIBLE'),
  A('0021', 'Plant and machinery - accumulated depreciation', 'ASSET', 'FIXED_ASSET_DEPRECIATION', 'BS.FIXED_ASSETS.TANGIBLE'),
  A('0030', 'Office equipment', 'ASSET', 'FIXED_ASSET_TANGIBLE', 'BS.FIXED_ASSETS.TANGIBLE'),
  A('0031', 'Office equipment - accumulated depreciation', 'ASSET', 'FIXED_ASSET_DEPRECIATION', 'BS.FIXED_ASSETS.TANGIBLE'),
  A('0040', 'Motor vehicles', 'ASSET', 'FIXED_ASSET_TANGIBLE', 'BS.FIXED_ASSETS.TANGIBLE'),
  A('0041', 'Motor vehicles - accumulated depreciation', 'ASSET', 'FIXED_ASSET_DEPRECIATION', 'BS.FIXED_ASSETS.TANGIBLE'),
  A('1000', 'Stock', 'ASSET', 'CURRENT_ASSET_STOCK', 'BS.CURRENT_ASSETS.STOCK'),
  A('1100', 'Trade debtors', 'ASSET', 'CURRENT_ASSET_RECEIVABLE', 'BS.CURRENT_ASSETS.DEBTORS', { control: 'TRADE_RECEIVABLES', system: true }),
  A('1110', 'Other debtors', 'ASSET', 'CURRENT_ASSET_RECEIVABLE', 'BS.CURRENT_ASSETS.DEBTORS'),
  A('1120', 'Prepayments', 'ASSET', 'CURRENT_ASSET_PREPAYMENT', 'BS.CURRENT_ASSETS.DEBTORS'),
  A('1200', 'Bank current account', 'ASSET', 'CURRENT_ASSET_BANK', 'BS.CURRENT_ASSETS.CASH', { control: 'BANK' }),
  A('1210', 'Bank deposit account', 'ASSET', 'CURRENT_ASSET_BANK', 'BS.CURRENT_ASSETS.CASH', { control: 'BANK' }),
  A('1220', 'Cash in hand', 'ASSET', 'CURRENT_ASSET_CASH', 'BS.CURRENT_ASSETS.CASH', { control: 'CASH' }),
  A('2100', 'Trade creditors', 'LIABILITY', 'CURRENT_LIABILITY_PAYABLE', 'BS.CREDITORS_WITHIN_ONE_YEAR', { control: 'TRADE_PAYABLES', system: true }),
  A('2110', 'Accruals', 'LIABILITY', 'CURRENT_LIABILITY_ACCRUAL', 'BS.CREDITORS_WITHIN_ONE_YEAR'),
  A('2200', 'VAT control account', 'LIABILITY', 'CURRENT_LIABILITY_VAT', 'BS.CREDITORS_WITHIN_ONE_YEAR', { control: 'VAT_CONTROL', tax: 'VAT_CONTROL', system: true }),
  A('2210', 'PAYE and National Insurance', 'LIABILITY', 'CURRENT_LIABILITY_PAYE', 'BS.CREDITORS_WITHIN_ONE_YEAR'),
  A('2220', 'Corporation tax', 'LIABILITY', 'CURRENT_LIABILITY_TAX', 'BS.CREDITORS_WITHIN_ONE_YEAR'),
  A('2230', 'Directors\' loan account', 'LIABILITY', 'CURRENT_LIABILITY_OTHER', 'BS.CREDITORS_WITHIN_ONE_YEAR'),
  A('2300', 'Bank loans', 'LIABILITY', 'LONG_TERM_LIABILITY', 'BS.CREDITORS_AFTER_ONE_YEAR'),
  A('3000', 'Share capital', 'EQUITY', 'SHARE_CAPITAL', 'BS.CAPITAL.SHARE_CAPITAL'),
  A('3100', 'Other reserves', 'EQUITY', 'RESERVES', 'BS.CAPITAL.RESERVES'),
  A('3200', 'Retained earnings', 'EQUITY', 'RETAINED_EARNINGS', 'BS.CAPITAL.RESERVES', { control: 'RETAINED_EARNINGS', system: true }),
  A('3300', 'Dividends', 'EQUITY', 'DIVIDENDS', 'BS.CAPITAL.RESERVES'),
  A('4000', 'Sales - standard rated', 'INCOME', 'SALES', 'PL.TURNOVER', { tax: 'VATABLE' }),
  A('4010', 'Sales - zero rated', 'INCOME', 'SALES', 'PL.TURNOVER', { tax: 'VATABLE' }),
  A('4020', 'Sales - exempt', 'INCOME', 'SALES', 'PL.TURNOVER', { tax: 'EXEMPT' }),
  A('4100', 'Other income', 'INCOME', 'OTHER_INCOME', 'PL.OTHER_INCOME', { tax: 'OUT_OF_SCOPE' }),
  A('4900', 'Interest received', 'INCOME', 'INTEREST_INCOME', 'PL.INTEREST_RECEIVABLE', { tax: 'OUT_OF_SCOPE' }),
  A('5000', 'Cost of goods sold', 'EXPENSE', 'COST_OF_SALES', 'PL.COST_OF_SALES', { tax: 'VATABLE' }),
  A('5100', 'Direct labour', 'EXPENSE', 'COST_OF_SALES', 'PL.COST_OF_SALES', { tax: 'OUT_OF_SCOPE' }),
  A('6000', 'Wages and salaries', 'EXPENSE', 'OVERHEADS', 'PL.ADMIN_EXPENSES', { tax: 'OUT_OF_SCOPE' }),
  A('6010', 'Employer\'s National Insurance', 'EXPENSE', 'OVERHEADS', 'PL.ADMIN_EXPENSES', { tax: 'OUT_OF_SCOPE' }),
  A('6100', 'Rent and rates', 'EXPENSE', 'OVERHEADS', 'PL.ADMIN_EXPENSES', { tax: 'VATABLE' }),
  A('6110', 'Heat, light and power', 'EXPENSE', 'OVERHEADS', 'PL.ADMIN_EXPENSES', { tax: 'VATABLE' }),
  A('6200', 'Insurance', 'EXPENSE', 'OVERHEADS', 'PL.ADMIN_EXPENSES', { tax: 'EXEMPT' }),
  A('6300', 'Telephone and internet', 'EXPENSE', 'OVERHEADS', 'PL.ADMIN_EXPENSES', { tax: 'VATABLE' }),
  A('6310', 'Office costs and stationery', 'EXPENSE', 'OVERHEADS', 'PL.ADMIN_EXPENSES', { tax: 'VATABLE' }),
  A('6320', 'Software and subscriptions', 'EXPENSE', 'OVERHEADS', 'PL.ADMIN_EXPENSES', { tax: 'VATABLE' }),
  A('6400', 'Travel and subsistence', 'EXPENSE', 'OVERHEADS', 'PL.ADMIN_EXPENSES', { tax: 'VATABLE' }),
  A('6410', 'Motor expenses', 'EXPENSE', 'OVERHEADS', 'PL.ADMIN_EXPENSES', { tax: 'VATABLE' }),
  A('6500', 'Advertising and marketing', 'EXPENSE', 'OVERHEADS', 'PL.ADMIN_EXPENSES', { tax: 'VATABLE' }),
  A('6600', 'Professional fees', 'EXPENSE', 'OVERHEADS', 'PL.ADMIN_EXPENSES', { tax: 'VATABLE' }),
  A('6610', 'Accountancy fees', 'EXPENSE', 'OVERHEADS', 'PL.ADMIN_EXPENSES', { tax: 'VATABLE' }),
  A('6700', 'Repairs and maintenance', 'EXPENSE', 'OVERHEADS', 'PL.ADMIN_EXPENSES', { tax: 'VATABLE' }),
  A('6800', 'Bank charges', 'EXPENSE', 'OVERHEADS', 'PL.ADMIN_EXPENSES', { tax: 'EXEMPT' }),
  A('6900', 'Depreciation', 'EXPENSE', 'DEPRECIATION', 'PL.DEPRECIATION', { tax: 'OUT_OF_SCOPE' }),
  A('7000', 'Loan interest', 'EXPENSE', 'INTEREST_EXPENSE', 'PL.INTEREST_PAYABLE', { tax: 'OUT_OF_SCOPE' }),
  A('7100', 'Corporation tax charge', 'EXPENSE', 'TAX_EXPENSE', 'PL.TAXATION', { tax: 'OUT_OF_SCOPE' }),
  A('8000', 'Sundry expenses', 'EXPENSE', 'OTHER_EXPENSE', 'PL.OTHER_EXPENSES', { tax: 'VATABLE' }),
  A('9999', 'Suspense', 'ASSET', 'CURRENT_ASSET_OTHER', 'BS.CURRENT_ASSETS.DEBTORS', { control: 'SUSPENSE', system: true }),
];

// ───────────── Events ─────────────
export const LEDGER_PERMISSIONS = ['account:read', 'account:manage', 'ledger:read', 'journal:post', 'period:lock'] as const;
