# V2 milestone V2-M5c - acceptance package (the cash flow statement)

Prepared under the product owner's delegation (DEC-019, DEC-051). The design is in DEC-067, recorded before code.

This is milestone evidence only, **not production approval** (DEC-006). All data is synthetic, and so are the cash-flow classes, the map and the captions: no FRS 102 Section 7 classification or caption has been entered or verified. Entering and verifying them is the named accountant's work in the platform (DEC-052, DEC-056).

## 1. Commit and CI
| Item | Result |
|---|---|
| Code baseline commit | `@@COMMIT@@` (branch `claude/adoring-cori-mra6ze`); specification recorded before code in v2-plan section 5g and DEC-067 |
| CI | @@CI@@ |
| CodeQL | @@CODEQL@@ |
| Clean clone | @@CLEAN@@ |
| Local runs | @@LOCAL@@ |

## 2. What V2-M5c delivers (v2-plan section 5g)
| Part | What it is |
|---|---|
| Content as version data | A standard version gains, all verified with it and frozen after:<ul><li>**cash-flow classes:** a key, a section (operating, investing or financing), an order and a caption; investing and financing classes also caption their non-cash part, and may show gross inflows and outflows;</li><li>**a map:** from V1 reporting lines (optionally narrowed by subtype) to a class or to CASH;</li><li>**the entity sizes** whose accounts include the statement, and its seven captions.</li></ul>Copied when a version is copied or superseded; checked by the service and the database when verified |
| The computation | From the ledger, closing journals left out (DEC-060). For each non-cash account:<ul><li>E is minus its movement;</li><li>C is the same over journals with a cash line;</li><li>N = E - C.</li></ul>The change in cash equals the sum of E, so the statement always reconciles when every account is placed |
| The statement (indirect method) | <ul><li>**Operating:** the profit line (the P&L accounts the map does not place), then the non-cash part (N) of each investing and financing class, then each operating class's whole movement (E).</li><li>**Investing and financing:** each class's cash part (C), gross where the class asks.</li><li>The net change, and opening and closing cash.</li><li>The comparative year on the same version.</li><li>Each line lists its accounts; lines that are zero in both years are left out.</li><li>A proof against the movement in cash.</li></ul> |
| Unplaced accounts | A balance-sheet account with a movement and no target goes to an "Unclassified movements" line and is reported as a problem. The statement still reconciles |
| Accounts document | The statement joins the statements when the version lists the year's entity size. Its problems keep the document incomplete |
| API | 7 operations, all in OpenAPI and behind `accounts.production`:<ul><li>`cash-flow-classes` and `cash-flow-map-entries` under a version: create, update and remove while it is unverified (`accounts:rules-manage`);</li><li>`cash-flow?yearStart&compare` (`ledger:read`).</li></ul>The version PATCH takes `cashFlowAppliesTo` and `cashFlowCaptions` |

**Migration:** `20260126000000_v2_cash_flow` (additive).
* Two version-content tables, `cash_flow_class` and `cash_flow_map_entry`:
  * forced row-level security;
  * DELETE and TRUNCATE revoked;
  * the V2-M1 content guard: they change only while the version is unverified;
  * shape checks: the reserved CASH key, non-cash captions, gross pairs, cash only on balance-sheet lines;
  * retention category ACCOUNTING_RECORDS.
* Two version columns, frozen once verified. Verification checks the captions, the map to CASH and the map targets.

## 3. Golden scenario (DEC-054)
`tests/golden/v2-m5c-cash-flow.json` was written by hand before the code. `docs/architecture/v2-m5c-golden-workings.xlsx` recomputes every line, total and cash balance independently in Python, and checks operating cash by the direct method: 106 checks, 0 differences.

* **The company:** a synthetic medium-sized company over 2025 and 2026, with:
  * credit sales and purchases, and stock;
  * equipment bought, depreciated, and partly sold at a loss;
  * a bank loan drawn and partly repaid;
  * interest paid and accrued, and interest received;
  * tax charged and paid;
  * shares issued and a dividend paid.

  2025 is closed.
* **The statement for 2026 (2025):**
  * Operating 23,000 (11,000): profit before interest and tax 19,500, depreciation and disposals 3,500, interest payable not paid -200, then working capital and tax paid -2,000.
  * Investing -4,400 (-12,000): proceeds 500, purchases -5,000, interest received 100.
  * Financing -9,800 (29,000).
  * Net increase 8,800; cash 28,000 at the beginning of the year and 36,800 at the end.
  * Operating cash also equals receipts less payments (the direct check).
* **Hand figures:** every line, account amount, total and cash balance matched on the first run of the code. Two of my own test set-ups were wrong and were corrected: an overlapping version, and a version not yet in effect.

## 4. Security and permission checks
| Check | Evidence |
|---|---|
| Only rules managers write the content; class shapes, unknown targets and cash on a P&L line are refused; a class in use cannot be removed; a version listing sizes without captions cannot be verified; after verification the content is frozen (service and database) | `tests/api/cash-flow.test.ts`, `tests/db/cash-flow.test.ts` |
| The statement needs `ledger:read`; outsiders get 404; another organisation sees no content; DELETE and TRUNCATE are revoked | `tests/api/cash-flow.test.ts`, `tests/db/cash-flow.test.ts`, `tests/db/privileges.test.ts` |
| The identity holds on 300 generated ledgers, and each kind of account lands where DEC-067 says | `tests/unit/cash-flow.test.ts` |
| The cash flow statement reads the ledger and the framework only and writes nothing; the content has one writer (`statutory.ts`); V2-ARC-01 widened to the cash flow reading version content, recorded here | `tests/unit/architecture.test.ts` |
| The new tables are classified, documented and given a retention category | `tests/db/classification.test.ts`, `tests/db/retention.test.ts` |

## 5. Compliance matrix
V2 matrix v2.0 (61 rows: Implemented 32, Partially 2, Missing 27).
* **Missing -> Implemented:** V2-OUT-03 (cash flow where applicable).
* **Partially -> Implemented:** V2-MOD-13 (statutory statements).
* **V2-TEST-01** gains the V2-M5c golden.
* Each row records that the mechanism is proven on synthetic content only.

## 6. Known limitations
1. **No real content.** The platform presents whatever classes, map and captions the named accountant enters and verifies; none exist yet.
2. **Classification by reporting line and subtype.** The map uses an account's V1 reporting line and subtype; there are no per-company cash-flow overrides yet. Interest or tax accrued into general creditors and paid later counts with the creditors' movement unless the creditor account has its own subtype.
3. **Not in this milestone:**
   * the direct method;
   * the notes on cash flows (the analysis of net debt);
   * approval and the filing-ready package (V2-M6);
   * PDF and iXBRL (V3);
   * screens (V2-M7).
4. **Production gates unchanged:**
   * standard versions, wording, thresholds and cash-flow content verified by Shoaib;
   * a qualified tax reviewer;
   * privacy and retention review (DEC-013);
   * security review;
   * AWS apply and verification;
   * real-volume performance.
