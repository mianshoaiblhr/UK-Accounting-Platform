# The design prototype (DEC-079)

The product owner decided on 2026-10-27 that the platform should look "just like" this prototype. It was designed on a Claude design canvas, "UK Practice Platform". These are standalone copies of its six screens; open `index.html` in a browser, and the side menu links the screens together.

| File | Screen | Built in |
|---|---|---|
| `index.html` | Practice overview: deadlines across clients, work by stage, HMRC and Companies House connections | V7 |
| `Clients.html` | Clients: search, services, year end, VAT, next deadline, manager, anti-money-laundering check | V7 |
| `Client.html` | One client's workspace: compliance calendar, profit and loss account, bookkeeping, year-end stages | V1, V2, V7 |
| `VatReturn.html` | MTD VAT return: the nine boxes, checks against the ledger, sign-off, submission and HMRC's receipt (the submission works) | V5 |
| `SelfAssessment.html` | MTD Income Tax: obligations, cumulative quarterly update in HMRC's categories, Self Assessment balance | V13 |
| `CorporationTax.html` | Company Tax Return: computation, CT600 boxes, iXBRL attachments, director approval before submission | V3, V4 |

## How to read it
* **The look:** it applies the visual system of DEC-076 (`../visual-system.md`): tokens, Geist, the sidebar shell, sheets, tables, pills and the ruled totals. Screens built later take their layout from these files.
* **The figures and names:** sample data. Built screens show what the API returns and compute nothing (DEC-048, DEC-071).
* **The font:** the prototype loads Geist from Google Fonts so it opens anywhere. The app keeps its bundled `geist` package (DEC-076).
* **The words:** the CT600 box numbers and HMRC wording are UNVERIFIED (DEC-022).
