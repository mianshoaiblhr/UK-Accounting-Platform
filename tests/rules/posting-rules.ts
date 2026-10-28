/**
 * Posting-rule coverage registry (V1-TEST-01, DEC-047). Every journal source of JOURNAL_SOURCES names, per category, the test that proves it
 * (file + exact test title) or `n/a` with a reason that follows from the design. tests/unit/posting-rule-coverage.test.ts fails when a source is
 * missing, a category is blank, a file does not exist, or a file has no test with that title. Add a journal source, add its row here.
 */
export const CATEGORIES = ['positive', 'negative', 'reversal', 'vat', 'periodLock'] as const;
export type Category = (typeof CATEGORIES)[number];
export type Cell = { file: string; test: string } | { na: string };
const T = (file: string, test: string): Cell => ({ file, test });
const NA = (na: string): Cell => ({ na });

const P = (f: string) => `tests/platform/${f}.test.ts`, A = (f: string) => `tests/api/${f}.test.ts`, D = (f: string) => `tests/db/${f}.test.ts`;
const RULES = P('posting-rules');
const LOCK = T(RULES, 'Lock Co: after January is closed, every document, receipt, payment, cash entry, transfer and their reversals dated in it are refused; nothing is written');
const NO_VAT = T(RULES, 'a source whose design carries no VAT refuses a VAT code: receipts, payments, transfers, allocations, revaluations, reversals and requests');
const CONTROL_KINDS = T(RULES, 'every sub-ledger source reaches only its own control kinds (retained earnings is none of them)');
const FX_ALLOC = T(RULES, 'FX Lock Co: an allocation dated in a closed period would post its realised difference there, so it is refused (sales and purchases)');
const FA_NO_VAT = T(P('fixed-assets'), 'a register source refuses a VAT code (none of them carries VAT)');
const FA_LOCK = T(P('fixed-assets'), 'after 2026 is closed, every register posting dated in it is refused: additions, runs, disposals and the reversals of each; nothing is written');
const YE_NO_VAT = T(P('year-end'), 'a year-end source refuses a VAT code (none of them carries VAT)');
const YE_LOCK = T(P('year-end'), 'after 2026 is closed, every year-end posting dated in it is refused: accruals and their reversals and cancellations, set-ups and their cancellations, provision movements and their reversals; nothing is written');
const YE_RUN_LOCK = T(P('year-end'), 'a release run and its reversal dated in a closed period are refused (a company with no later runs)');
const YEC_NO_VAT = T(P('year-end-close'), 'a closing source refuses a VAT code (neither carries VAT)');
const YEC_LOCK = T(P('year-end-close'), 'a close and its reversal dated in a closed or locked period are refused; nothing is written');
const MIRROR_FINAL = NA('A mirror is final: reversing a reversal is refused (tested in the negative cell)');

export const POSTING_RULE_COVERAGE: Record<string, Record<Category, Cell>> = {
  MANUAL: {
    positive: T(P('posting-service'), 'posts a balanced journal in an open period with a number, totals, source, actor, audit and outbox event'),
    negative: T(P('posting-service'), 'unbalanced journal'),
    reversal: T(P('posting-service'), 'posts a linked mirror journal that cancels the original in the ledger'),
    vat: T(P('vat'), 'exclusive sale: the service adds a visible VAT line on the output account; the journal balances'),
    periodLock: T(P('posting-service'), 'posting needs an OPEN period: closed and locked periods refuse (period-lock test)'),
  },
  OPENING_BALANCE: {
    positive: T(A('ledger-controls'), 'a different approver posts it: journal with number, source OPENING_BALANCE, requester/approver recorded, evidence linked, request APPROVED'),
    negative: T(A('ledger-controls'), "unbalanced, one line, zero, negative, foreign currency, unknown account, another company's account"),
    reversal: T(A('ledger-controls'), 'the approved opening balance is reversible, and the reversal links to it'),
    vat: NO_VAT,
    periodLock: T(A('ledger-controls'), 'wrong date for an opening balance, no period, closed period'),
  },
  CONTROL_ADJUSTMENT: {
    positive: T(A('ledger-controls'), 'an accountant requests, a partner approves; the adjustment posts to the control account with the evidence linked'),
    negative: T(A('ledger-controls'), 'a control adjustment needs evidence, must touch a control account, and MANUAL journals are still refused on control accounts'),
    reversal: T(A('ledger-controls'), 'an approved adjustment is corrected by a reversal, never edited'),
    vat: NO_VAT,
    periodLock: T(A('ledger-controls'), 'a period closed between request and approval refuses the approval and leaves the request pending'),
  },
  FX_REVALUATION: {
    positive: T(P('fx'), 'posting revalues once, posts the unrealised difference, and the auto-reversal lands on the first day of the next period'),
    negative: T(P('fx'), 'a missing closing rate stops the run and says which currency; a closing rate can be chosen by id'),
    reversal: T(P('fx'), 'when the next period does not exist yet the reversal stays due; the period that contains its date cannot close until it is posted'),
    vat: NO_VAT,
    periodLock: T(P('fx'), 'a closed period refuses a revaluation that would post (the PostingService guards closed and locked periods)'),
  },
  REVERSAL: {
    positive: T(P('posting-service'), 'posts a linked mirror journal that cancels the original in the ledger'),
    negative: T(P('posting-service'), 'a journal is reversed at most once, a reversal cannot be reversed, and the reversal cannot predate the original'),
    reversal: MIRROR_FINAL,
    vat: T(D('vat'), 'a superseded version is refused for new journals but accepted on a reversal (corrections mirror history)'),
    periodLock: T(P('posting-service'), 'reversing into a closed period is refused; a journal of another company cannot be reversed'),
  },
  SALES_INVOICE: {
    positive: T(P('sales'), 'posts Dr receivables / Cr revenue / Cr output VAT, numbers from the start number, snapshots the customer and publishes InvoiceCreated (V1-EX-01)'),
    negative: T(P('sales'), 'sales journals reach trade receivables and no other control account'),
    reversal: T(P('sales'), 'a sales journal is corrected with a credit note, never reversed in the ledger (service and database)'),
    vat: T(P('sales'), 'VAT-inclusive entry takes the VAT fraction out of the gross'),
    periodLock: LOCK,
  },
  SALES_CREDIT_NOTE: {
    positive: T(P('sales'), 'a full credit mirrors the invoice, is allocated to it and settles it (V1-MOD-06, V1-EX-05)'),
    negative: T(P('sales'), 'a credit cannot exceed what is outstanding, use another VAT code, precede its invoice, or credit a draft'),
    reversal: NA('A credit note is itself the correction of an invoice; the ledger refuses to reverse any sub-ledger journal (sales and purchase invoice tests); a mistaken credit is corrected by a new invoice'),
    vat: T(P('sales'), 'the credit note takes the VAT rate version its invoice used, at its own tax point (DEC-029)'),
    periodLock: LOCK,
  },
  SALES_RECEIPT: {
    positive: T(P('sales-receipts'), 'a receipt posts Dr bank / Cr receivables; allocated at entry in full and in part; the overpayment stays unallocated credit'),
    negative: T(P('sales-receipts'), 'a possible duplicate receipt needs a reason; the bank account must be a bank or cash account; recording needs sales:approve'),
    reversal: T(P('sales-receipts'), 'an allocated receipt cannot be reversed; an unallocated one is reversed with a mirror journal and is then final'),
    vat: NO_VAT,
    periodLock: LOCK,
  },
  SALES_RECEIPT_REVERSAL: {
    positive: T(P('sales-receipts'), 'an allocated receipt cannot be reversed; an unallocated one is reversed with a mirror journal and is then final'),
    negative: T(P('cash'), 'a customer receipt into cash, reversed after the cash was spent, needs a reason'),
    reversal: MIRROR_FINAL,
    vat: NO_VAT,
    periodLock: LOCK,
  },
  SALES_ALLOCATION_FX: {
    positive: T(P('sales-receipts'), 'an EUR invoice settled by two receipts at different rates realises a gain then a loss that net to cash received less carried'),
    negative: CONTROL_KINDS,
    reversal: FX_ALLOC,
    vat: NO_VAT,
    periodLock: FX_ALLOC,
  },
  PURCHASE_BILL: {
    positive: T(P('purchases'), 'a bill posts Dr expense / Dr input VAT / Cr payables, with zero, exempt and reverse-charge lines, hand-calculated'),
    negative: T(P('purchases'), 'separation of duties and permissions; AI never approves'),
    reversal: T(D('purchases'), 'a purchase journal cannot be reversed in the ledger, even by a direct insert'),
    vat: T(P('purchases'), 'a bill posts Dr expense / Dr input VAT / Cr payables, with zero, exempt and reverse-charge lines, hand-calculated'),
    periodLock: LOCK,
  },
  PURCHASE_DEBIT_NOTE: {
    positive: T(P('purchases'), 'a full debit note mirrors the bill, reverse-charge pair included, and settles it'),
    negative: T(P('purchases'), 'a debit note on a BOTH-direction code reduces INPUT VAT; a debit note cannot exceed the bill or precede it'),
    reversal: NA('A debit note is itself the correction of a bill; the ledger refuses to reverse any sub-ledger journal (bill tests); a mistaken debit note is corrected by a new bill'),
    vat: T(P('purchases'), 'a debit note on a BOTH-direction code reduces INPUT VAT; a debit note cannot exceed the bill or precede it'),
    periodLock: LOCK,
  },
  PURCHASE_PAYMENT: {
    positive: T(P('purchase-payments'), 'a payment posts Dr payables / Cr bank; allocated in full and in part at entry; the rest stays a prepayment'),
    negative: T(P('purchase-payments'), 'duplicates need a reason; bank account and permission checks; allocated payments cannot be reversed; unallocated ones are mirrored'),
    reversal: T(P('purchase-payments'), 'duplicates need a reason; bank account and permission checks; allocated payments cannot be reversed; unallocated ones are mirrored'),
    vat: NO_VAT,
    periodLock: LOCK,
  },
  PURCHASE_PAYMENT_REVERSAL: {
    positive: T(P('purchase-payments'), 'duplicates need a reason; bank account and permission checks; allocated payments cannot be reversed; unallocated ones are mirrored'),
    negative: CONTROL_KINDS,
    reversal: MIRROR_FINAL,
    vat: NO_VAT,
    periodLock: LOCK,
  },
  PURCHASE_ALLOCATION_FX: {
    positive: T(P('purchase-payments'), 'an EUR bill paid at two rates: a loss when paying more in sterling, a gain when paying less; no residue'),
    negative: CONTROL_KINDS,
    reversal: FX_ALLOC,
    vat: NO_VAT,
    periodLock: FX_ALLOC,
  },
  CASH_PAYMENT: {
    positive: T(P('cash'), 'money out: Dr expense / Dr input VAT / Cr cash, VAT-inclusive amounts; exempt lines carry none'),
    negative: T(P('cash'), 'lines go to non-control, non-bank, non-reserved accounts with a VAT code of the right direction'),
    reversal: T(P('cash'), 'a reversal mirrors the posted journal line by line at the same VAT rate versions and tax point; once only; never through the ledger'),
    vat: T(P('cash'), 'money out: Dr expense / Dr input VAT / Cr cash, VAT-inclusive amounts; exempt lines carry none'),
    periodLock: LOCK,
  },
  CASH_RECEIPT: {
    positive: T(P('cash'), 'money in: Dr cash / Cr income / Cr output VAT, per line, exclusive amounts'),
    negative: T(P('cash'), 'duplicates need a reason; people only, with cash:record; an unregistered company records without VAT codes only'),
    reversal: T(P('posting-rules'), 'a cash receipt reversal mirrors its VAT lines at the same rate version and tax point, and the VAT workpaper nets to nil'),
    vat: T(P('cash'), 'money in: Dr cash / Cr income / Cr output VAT, per line, exclusive amounts'),
    periodLock: T(P('cash'), 'a closed period refuses the posting; nothing is half-written'),
  },
  CASH_PAYMENT_REVERSAL: {
    positive: T(P('cash'), 'a reversal mirrors the posted journal line by line at the same VAT rate versions and tax point; once only; never through the ledger'),
    negative: T(P('cash'), 'a reversal mirrors the posted journal line by line at the same VAT rate versions and tax point; once only; never through the ledger'),
    reversal: MIRROR_FINAL,
    vat: T(P('cash'), 'a reversal mirrors the posted journal line by line at the same VAT rate versions and tax point; once only; never through the ledger'),
    periodLock: LOCK,
  },
  CASH_RECEIPT_REVERSAL: {
    positive: T(P('posting-rules'), 'a cash receipt reversal mirrors its VAT lines at the same rate version and tax point, and the VAT workpaper nets to nil'),
    negative: T(P('cash'), 'reversing money in that has since been spent takes the box below zero, so it needs a reason too'),
    reversal: MIRROR_FINAL,
    vat: T(P('posting-rules'), 'a cash receipt reversal mirrors its VAT lines at the same rate version and tax point, and the VAT workpaper nets to nil'),
    periodLock: LOCK,
  },
  BANK_TRANSFER: {
    positive: T(P('bank'), 'bank to cash posts one journal; cash back to the bank; the cash box cannot go below zero without a reason'),
    negative: T(P('bank'), 'same foreign currency at one rate (no exchange difference); different currencies are refused; only bank or cash accounts; people with bank:transfer'),
    reversal: T(P('bank'), 'duplicates need a reason; a reversal mirrors the journal and is refused when it would empty the cash box'),
    vat: NO_VAT,
    periodLock: LOCK,
  },
  BANK_TRANSFER_REVERSAL: {
    positive: T(P('bank'), 'duplicates need a reason; a reversal mirrors the journal and is refused when it would empty the cash box'),
    negative: T(D('bank'), 'point at their own journal; are immutable; a reversal must mirror the journal line by line; never deleted; never reversed in the ledger'),
    reversal: MIRROR_FINAL,
    vat: NO_VAT,
    periodLock: LOCK,
  },
  // V2-M2 fixed assets (DEC-058): the register's own sources, each corrected by its mirror in the register
  FIXED_ASSET_ADDITION: {
    positive: T(P('fixed-assets'), 'posts Dr cost / Cr the offset account, and the asset is numbered in the register'),
    negative: T(P('fixed-assets'), 'refuses a control offset, a class account as offset, a person without assets:manage and an AI actor; nothing is written'),
    reversal: T(P('fixed-assets'), 'FIXED_ASSET_ADDITION_REVERSAL mirrors the addition and voids the asset; a second reversal and a depreciated asset are refused'),
    vat: FA_NO_VAT,
    periodLock: FA_LOCK,
  },
  FIXED_ASSET_ADDITION_REVERSAL: {
    positive: T(P('fixed-assets'), 'FIXED_ASSET_ADDITION_REVERSAL mirrors the addition and voids the asset; a second reversal and a depreciated asset are refused'),
    negative: T(P('fixed-assets'), 'FIXED_ASSET_ADDITION_REVERSAL mirrors the addition and voids the asset; a second reversal and a depreciated asset are refused'),
    reversal: MIRROR_FINAL,
    vat: FA_NO_VAT,
    periodLock: FA_LOCK,
  },
  FIXED_ASSET_DEPRECIATION: {
    positive: T(P('fixed-assets'), 'posts one pair of lines per class and one line per asset; a run that charges nothing is refused'),
    negative: T(A('fixed-assets'), 'only the latest live run is reversed, by its mirror; a re-run gives the same charges; a run must be later than every live run'),
    reversal: T(P('fixed-assets'), 'FIXED_ASSET_DEPRECIATION_REVERSAL mirrors the latest live run only; a reversed run cannot be reversed again; the ledger cannot reverse it directly'),
    vat: FA_NO_VAT,
    periodLock: FA_LOCK,
  },
  FIXED_ASSET_DEPRECIATION_REVERSAL: {
    positive: T(P('fixed-assets'), 'FIXED_ASSET_DEPRECIATION_REVERSAL mirrors the latest live run only; a reversed run cannot be reversed again; the ledger cannot reverse it directly'),
    negative: T(P('fixed-assets'), 'FIXED_ASSET_DEPRECIATION_REVERSAL mirrors the latest live run only; a reversed run cannot be reversed again; the ledger cannot reverse it directly'),
    reversal: MIRROR_FINAL,
    vat: FA_NO_VAT,
    periodLock: FA_LOCK,
  },
  FIXED_ASSET_DISPOSAL: {
    positive: T(P('fixed-assets'), 'posts the catch-up, removes cost and depreciation, and puts the carrying amount and proceeds on the disposal account; refuses a second disposal and a date before use'),
    negative: T(P('fixed-assets'), 'posts the catch-up, removes cost and depreciation, and puts the carrying amount and proceeds on the disposal account; refuses a second disposal and a date before use'),
    reversal: T(P('fixed-assets'), 'FIXED_ASSET_DISPOSAL_REVERSAL mirrors the disposal and restores the asset; refused once a later run is live'),
    vat: FA_NO_VAT,
    periodLock: FA_LOCK,
  },
  FIXED_ASSET_DISPOSAL_REVERSAL: {
    positive: T(P('fixed-assets'), 'FIXED_ASSET_DISPOSAL_REVERSAL mirrors the disposal and restores the asset; refused once a later run is live'),
    negative: T(P('fixed-assets'), 'FIXED_ASSET_DISPOSAL_REVERSAL mirrors the disposal and restores the asset; refused once a later run is live'),
    reversal: MIRROR_FINAL,
    vat: FA_NO_VAT,
    periodLock: FA_LOCK,
  },
  // V2-M3a year-end adjustments (DEC-059): each corrected only by its own mirror
  ACCRUAL: {
    positive: T(P('year-end'), 'an accrual posts Dr expense / Cr accruals and its reversal on the next day; accrued income the other way round'),
    negative: T(P('year-end'), 'refuses accounts of the wrong type, control accounts, a missing next period, a person without accounts:prepare and an AI actor; nothing is written'),
    reversal: T(P('year-end'), 'ACCRUAL_CANCELLATION mirrors the accrual and its reversal at their own dates; a second cancellation is refused'),
    vat: YE_NO_VAT,
    periodLock: YE_LOCK,
  },
  ACCRUAL_AUTO_REVERSAL: {
    positive: T(P('year-end'), 'an accrual posts Dr expense / Cr accruals and its reversal on the next day; accrued income the other way round'),
    negative: T(P('year-end'), 'refuses accounts of the wrong type, control accounts, a missing next period, a person without accounts:prepare and an AI actor; nothing is written'),
    reversal: T(P('year-end'), 'ACCRUAL_CANCELLATION mirrors the accrual and its reversal at their own dates; a second cancellation is refused'),
    vat: YE_NO_VAT,
    periodLock: YE_LOCK,
  },
  ACCRUAL_CANCELLATION: {
    positive: T(P('year-end'), 'ACCRUAL_CANCELLATION mirrors the accrual and its reversal at their own dates; a second cancellation is refused'),
    negative: T(P('year-end'), 'ACCRUAL_CANCELLATION mirrors the accrual and its reversal at their own dates; a second cancellation is refused'),
    reversal: MIRROR_FINAL,
    vat: YE_NO_VAT,
    periodLock: YE_LOCK,
  },
  ADJUSTMENT_SETUP: {
    positive: T(P('year-end'), 'a posted set-up reclassifies from the P&L account; a release run releases by schedule; nothing to release is refused'),
    negative: T(A('year-end'), 'wrong accounts, control accounts, over-linking and a reversal day with no period are refused; nothing is written'),
    reversal: T(P('year-end'), 'ADJUSTMENT_SETUP_REVERSAL mirrors a set-up nothing was released from; a released schedule and a second cancellation are refused'),
    vat: YE_NO_VAT,
    periodLock: YE_LOCK,
  },
  ADJUSTMENT_SETUP_REVERSAL: {
    positive: T(P('year-end'), 'ADJUSTMENT_SETUP_REVERSAL mirrors a set-up nothing was released from; a released schedule and a second cancellation are refused'),
    negative: T(P('year-end'), 'ADJUSTMENT_SETUP_REVERSAL mirrors a set-up nothing was released from; a released schedule and a second cancellation are refused'),
    reversal: MIRROR_FINAL,
    vat: YE_NO_VAT,
    periodLock: YE_LOCK,
  },
  ADJUSTMENT_RELEASE: {
    positive: T(P('year-end'), 'a posted set-up reclassifies from the P&L account; a release run releases by schedule; nothing to release is refused'),
    negative: T(P('year-end'), 'a posted set-up reclassifies from the P&L account; a release run releases by schedule; nothing to release is refused'),
    reversal: T(P('year-end'), 'ADJUSTMENT_RELEASE_REVERSAL mirrors the latest live run only, once; the ledger cannot reverse it directly'),
    vat: YE_NO_VAT,
    periodLock: YE_RUN_LOCK,
  },
  ADJUSTMENT_RELEASE_REVERSAL: {
    positive: T(P('year-end'), 'ADJUSTMENT_RELEASE_REVERSAL mirrors the latest live run only, once; the ledger cannot reverse it directly'),
    negative: T(P('year-end'), 'ADJUSTMENT_RELEASE_REVERSAL mirrors the latest live run only, once; the ledger cannot reverse it directly'),
    reversal: MIRROR_FINAL,
    vat: YE_NO_VAT,
    periodLock: YE_RUN_LOCK,
  },
  PROVISION_MOVEMENT: {
    positive: T(P('year-end'), 'made, used and released post their pairs; never below zero, in date order, never against a control account'),
    negative: T(P('year-end'), 'made, used and released post their pairs; never below zero, in date order, never against a control account'),
    reversal: T(P('year-end'), 'PROVISION_MOVEMENT_REVERSAL mirrors the latest live movement only, once'),
    vat: YE_NO_VAT,
    periodLock: YE_LOCK,
  },
  PROVISION_MOVEMENT_REVERSAL: {
    positive: T(P('year-end'), 'PROVISION_MOVEMENT_REVERSAL mirrors the latest live movement only, once'),
    negative: T(P('year-end'), 'PROVISION_MOVEMENT_REVERSAL mirrors the latest live movement only, once'),
    reversal: MIRROR_FINAL,
    vat: YE_NO_VAT,
    periodLock: YE_LOCK,
  },
  YEAR_END_CLOSE: {
    positive: T(P('year-end-close'), 'closes a year: one journal dated the year end, income and expense to retained earnings in code order; a loss debits retained earnings'),
    negative: T(P('year-end-close'), 'refuses a year that is not aligned to periods, has a gap, runs over 18 months, overlaps a live close or has nothing to close, and anyone without accounts:prepare or an AI; nothing is written'),
    reversal: T(P('year-end-close'), 'YEAR_END_CLOSE is corrected only by its mirror: the ledger cannot reverse it directly'),
    vat: YEC_NO_VAT,
    periodLock: YEC_LOCK,
  },
  VAT_RETURN: {
    positive: T(A('vat-filing'), 'posts the liability journal at the period end and marks the obligation DONE with the receipt; once only'),
    negative: T(A('vat-filing'), 'needs vat:file and the VAT liability account, which must differ from the output and input accounts'),
    reversal: T(A('vat-filing'), 'VAT_RETURN is corrected in a later return: the ledger cannot reverse the liability journal directly'),
    vat: T(A('vat-filing'), 'the liability journal carries no VAT code or tax point'),
    periodLock: T(A('vat-filing'), 'a filing whose liability journal falls in a closed accounting period is refused; nothing is written'),
  },
  YEAR_END_CLOSE_REVERSAL: {
    positive: T(P('year-end-close'), 'reversing a close posts its mirror at the year end and opens the year to income and expense again; closing again closes what is there now'),
    negative: T(P('year-end-close'), 'a reversed close cannot be reversed again; a closing source reaches no control account but retained earnings; the mirror is final'),
    reversal: MIRROR_FINAL,
    vat: YEC_NO_VAT,
    periodLock: YEC_LOCK,
  },
};
