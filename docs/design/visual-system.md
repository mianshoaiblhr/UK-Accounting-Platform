# The platform's visual system (UI-1, DEC-076)

Written before code, following the product owner's frontend-design skill (plan, review against the brief, then build) and the
design-taste-frontend skill's app-screen run. The style was dealt by the skill's own draw (`draw.mjs --app --kind finance`,
seed 117641326): **Achromatic ledger**, light, on an **Open plane** shell.

## 1. The brief, grounded
* **Subject:** a UK accounting practice platform. It covers bookkeeping, VAT, bank reconciliation, the year end, statutory accounts and their approval for small companies.
* **People:** accountants, bookkeepers, managers and partners in a practice. They work in it for hours at a desk, often on a laptop, sometimes checking on a phone. A reviewer reads without acting.
* **The screen's one job** (every screen): show the figures exactly as the ledger computed them, and the next thing to do. The platform never invents a number on screen (DEC-048).
* **The product's own things:**
  * the company being worked on and its currency;
  * the financial year;
  * the ledger's columns of figures;
  * the accountant's ruled totals;
  * the 14 steps of the year end;
  * the people who prepare, review and approve.

## 2. Tokens
| Name | Hex | Role | Contrast |
|---|---|---|---|
| Ledger ground | `#f2f4f7` | The page ground and the sidebar: a blue-grey taken from ledger paper, one level off white | - |
| Sheet | `#ffffff` | Cards, tables and forms: the white sheet the figures sit on | - |
| Blue-black ink | `#172231` | Text, money, the primary button: the ink of a ledger, not a tinted #111 | 16.0:1 on sheet, 14.6:1 on ground |
| Pencil | `#566170` | Secondary text, column headers, meta | 6.3:1 on sheet, 5.7:1 on ground |
| Rule | `#e1e6ec` (card edge), `#edf0f4` (row rule), `#c9d0d9` (control edge) | Lines in three steps, as the skill measures them | - |
| Signal blue | `#1d5fbf` | The one hue. It goes on the main data element only: the current step of the year end, the active year, the focus ring. Under 1% of a screen | 6.1:1 on sheet |
| Red ink | `#b3261e` | Refusals, failures and blockers, only: the accountant's red ink for what is wrong, never on an ordinary negative figure (the sign carries that) | 6.5:1 on sheet |
| Settled green | `#276b2b` | Something confirmed: reconciled, saved, signed off. Darkened from the sheet's `#2e7d32`, which falls to 4.2:1 on the active pill | 6.5:1 on sheet, 5.3:1 on the active pill |

* **Status pills:**
  * positive: `#dcfae5` with ink `#04250e`;
  * negative: `#ffedea` with ink `#831c1e`;
  * notice: `#fffbeb` with ink `#92400e`;
  * neutral: `#e9edf2` with ink `#3a4553`.
* **Dark mode** (the screens already follow the system setting): true neutral darks.
  * Grounds: `#0c0d0f` ground, `#15171a` sheet.
  * Text: `#f2f4f7` ink, `#aab2bd` pencil.
  * Lines: `#262a30` rule, `#3a4049` control.
  * Accents: signal `#6d9eea`, red `#f08a80`, green `#5bbf73`.
* **Contrast:** every pair above is checked by `scripts/docs/check_contrast.py`; every text colour must reach 4.5:1 on each surface it sits on, including the active pill `#e3e8ee`. All 37 pairs pass.

## 3. Type
* **Geist** for everything, bundled with the app (the `geist` package, served from the platform itself; no request to Google). It is the face dealt for this style.
* **Weights:** 400 for text, 500 for labels and headings, 700 for money totals only.
* **Sizes:**

  | Role | Size |
  |---|---|
  | Page title | 24/32 |
  | Section | 16/24 |
  | Body and cells | 14/20 |
  | Labels and meta | 12/16 |

* **Figures:**
  * tabular (`font-variant-numeric: tabular-nums`) on every amount, right-aligned, two decimals, exactly as the API sends them;
  * the sign is in the text; red is never used on an ordinary negative.
* **Geist Mono** has one job: identifiers a person copies or compares (fingerprints, SHA-256, journal references).
* **Case:** sentence case everywhere; no tracked capitals and no eyebrow labels.

## 4. Layout (Open plane)
```
+-----------------+--------------------------------------------------------------+
| [=] UK Accounting|  Trial balance                                     (24/500) |
|     Platform     |                                                              |
|                  |  +--------------------------------------------------------+  |
| Northwind Ltd    |  | As at [2026-06-30]                                     |  |
| GBP · change     |  |  Account                          Debit      Credit    |  |
|                  |  |  1200 Bank current account     1,330.00              |  |
| Books            |  |  ...                                                   |  |
|  Dashboard       |  |  Total                         ========   ========    |  |
|  Accounts        |  +--------------------------------------------------------+  |
|  Journals        |                                                              |
|  Trial balance   |                                                              |
|  ...             |                                                              |
| Year end         |                                                              |
|  Year end        |                                                              |
|  Registers       |                                                              |
|                  |                                                              |
| owner@firm.test  |                                                              |
| Security · Sign out                                                             |
+-----------------+--------------------------------------------------------------+
   256px, on the ground       fluid canvas, 32px gutter, content up to 1240px
```
* **The sidebar sits on the ledger ground** with no line between it and the canvas, and no top bar. It holds:
  * the product's mark and name at the top;
  * the company being worked on (the scope), with its currency;
  * the sections, in labelled groups (sentence-case grey group labels at 12px);
  * the person and "Sign out" at the bottom.
* **The active section** is a neutral pill (`#e3e8ee`, radius 6), with the label unchanged. There is no coloured bar.
* **Sheets:**
  * white, a 1px rule edge, radius 8, no shadow;
  * the canvas content is left-aligned on one left edge;
  * forms stack in a single column, or a row of fields that wraps.
* **Tables:**
  * 12px pencil headers, no band and no zebra;
  * 1px row rules;
  * numbers right-aligned and tabular;
  * the identity column gets the width.
* **Sub-navigation** inside a section (the year end's four screens, the seven registers) is a row of links. The current one is in ink with a 2px ink rule under it. There are no middle-dot strings and no coloured pills.
* **Buttons:**
  * the primary action is blue-black ink with a white label;
  * the secondary is a grey pill (`#e3e8ee`);
  * a reversal or a cancellation is secondary, and asks for its reason.
* **Phone (≤ 760px):** the sidebar becomes a block at the top. The product and company row comes first, then the sections as one horizontally scrolling row. Content takes the full width with 16px margins, and wide tables scroll inside their sheet.

## 5. The one memorable thing: the ruled total
Every set of accounts an accountant has ever signed puts a single rule above a subtotal and a double rule under the final total. The platform draws the same thing:
* on every total row of a statement, a register or the trial balance: a 1px ink rule above;
* on the last total of a statement: a 3px double ink rule under.

This is the product's own convention, from its own world, and no template draws it. Everything around it stays quiet.

## 6. Motion, focus and states
* **Motion:** none at rest. A disclosure (a statement line opening its accounts) changes instantly. `prefers-reduced-motion` is respected, and framer-motion and gsap are not needed.
* **Focus:** a 2px signal-blue outline, offset 2px, on every link, button and field.
* **States:**
  * an error is red ink on a pale negative tint, with the API's words;
  * a success is settled green;
  * an empty list keeps its frame and says what to do;
  * loading says "Loading…" in pencil.

## 7. Reviewed against the brief before building
Engineering checked the plan against the defaults both skills name as the commonest tells of generated design, and against what it would have produced for any dashboard. It revised three things:

* **Ink.** The sheet's `#0a0a0a` is the "tinted near-black standing in for black" tell. It became blue-black ink `#172231`, the colour of a ledger's ink, which ties the type to the subject.
* **Sub-navigation.** The V2 screens joined their sub-navigation with middle dots ("Workflow · Review · Accounts · Approval"), the "meta strings joined with middle dots" tell. They become a row of links with the current one ruled.
* **Ground.** The default `#f8f8f8` ground and white 12px cards are the "kit's own face" the app-screen chapter warns about. The ledger ground, the 8px radius and the ruled totals give the product its own face instead.

The plan also keeps clear of the other defaults:
* no cream with terracotta;
* no black with an acid accent;
* no broadsheet zero-radius columns;
* no identical shadowed cards;
* no tracked-capital eyebrows;
* no arrow on links;
* no monospace labels;
* no gradient, glow or emoji.

## 8. What must not change
* What every screen shows: every figure, word and state comes from the API.
* Every route, permission check and action.
* The accessible names and test ids the real-browser tests use.

The 32 existing e2e tests must pass unchanged.
