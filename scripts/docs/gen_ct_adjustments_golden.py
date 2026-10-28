#!/usr/bin/env python3
"""Writes docs/architecture/v4-m2-golden-workings.xlsx: the hand workings of the synthetic CT period in tests/golden/v4-m2-adjusted-profit.json
(V4-M2, DEC-099), for review by the named accountant (the DEC-054 pattern). Every figure is a formula over the journal lines, so a reviewer can
trace it; the expected column holds the golden the API test asserts. The rules are synthetic fixtures, not tax advice.
Usage: python3 scripts/docs/gen_ct_adjustments_golden.py (needs openpyxl)."""
import datetime as dt
import json
import pathlib
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

root = pathlib.Path(__file__).resolve().parents[2]
G = json.loads((root / "tests/golden/v4-m2-adjusted-profit.json").read_text())
OUT = root / "docs/architecture/v4-m2-golden-workings.xlsx"
HEAD = PatternFill("solid", fgColor="1F3A5F")
EXPECT = PatternFill("solid", fgColor="E8F1E4")
THIN = Side(style="thin", color="BFBFBF")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
PL = {"4000": "INCOME", "4100": "INCOME", "6000": "EXPENSE", "6600": "EXPENSE", "6900": "EXPENSE", "7100": "TAX", "8000": "EXPENSE"}
START, END = G["year"]["yearStart"], G["year"]["yearEnd"]
D = dt.date.fromisoformat
XD = lambda s: "DATE(%d,%d,%d)" % (D(s).year, D(s).month, D(s).day)


def header(ws, row, titles, widths):
    for i, (t, w) in enumerate(zip(titles, widths), start=1):
        c = ws.cell(row=row, column=i, value=t)
        c.font, c.fill, c.alignment, c.border = Font(bold=True, color="FFFFFF"), HEAD, Alignment(wrap_text=True, vertical="top"), BOX
        ws.column_dimensions[get_column_letter(i)].width = w


wb = Workbook()
about = wb.active
about.title = "About"
for r, t in enumerate([
    "V4-M2 golden workings: the profit of a synthetic CT period adjusted for tax (DEC-099)", "",
    G["about"], f"CT period: {START} to {END}.",
    "Accounting profit = the net credit of income and expense accounts in the period, leaving out the tax charge (7100) and journals outside the period.",
    "A rule adds back (debits - credits) x percentage of its account for the journals inside both the period and the rule's dates; a credit result is deducted.",
    "Manual adjustments count unless withdrawn. Green cells are the golden the API test asserts.",
], start=1):
    about.cell(row=r, column=1, value=t).font = Font(bold=(r == 1))
about.column_dimensions["A"].width = 140

j = wb.create_sheet("Journals")
header(j, 1, ["Date", "Description", "Account", "Kind", "Debit", "Credit", "In period", "Net credit to profit"], [12, 44, 10, 10, 12, 12, 10, 18])
for i, x in enumerate(G["journals"], start=2):
    j.cell(row=i, column=1, value=D(x["date"])).number_format = "yyyy-mm-dd"; j.cell(row=i, column=2, value=x["description"]); j.cell(row=i, column=3, value=x["account"])
    j.cell(row=i, column=4, value=PL[x["account"]]); j.cell(row=i, column=5, value=float(x["debit"])); j.cell(row=i, column=6, value=float(x["credit"]))
    j.cell(row=i, column=7, value=f'=AND(A{i}>={XD(START)},A{i}<={XD(END)})')
    j.cell(row=i, column=8, value=f'=IF(AND(G{i},D{i}<>"TAX"),F{i}-E{i},0)')
last = len(G["journals"]) + 1
j.cell(row=last + 1, column=7, value="Accounting profit").font = Font(bold=True)
j.cell(row=last + 1, column=8, value=f"=ROUND(SUM(H2:H{last}),2)").font = Font(bold=True)
acc_profit = f"Journals!H{last + 1}"

r = wb.create_sheet("Adjustments")
header(r, 1, ["Source", "Account", "Category", "Percentage", "From", "Debits in range", "Credits in range", "Adjustment (+ add, - deduct)", "Expected", "Direction"], [10, 10, 22, 11, 12, 15, 15, 22, 12, 10])
row = 2
for k, x in enumerate(G["rules"]):
    e = G["expected"]["ruleAdjustments"][k]
    rf = max(x["effectiveFrom"], START)
    r.cell(row=row, column=1, value="RULE"); r.cell(row=row, column=2, value=x["account"]); r.cell(row=row, column=3, value=x["category"])
    r.cell(row=row, column=4, value=float(x["percentage"])); r.cell(row=row, column=5, value=D(rf)).number_format = "yyyy-mm-dd"
    cond = f'Journals!$C$2:$C${last},"{x["account"]}",Journals!$A$2:$A${last},">="&E{row},Journals!$A$2:$A${last},"<="&{XD(END)}'
    r.cell(row=row, column=6, value=f"=SUMIFS(Journals!$E$2:$E${last},{cond})")
    r.cell(row=row, column=7, value=f"=SUMIFS(Journals!$F$2:$F${last},{cond})")
    r.cell(row=row, column=8, value=f"=ROUND((F{row}-G{row})*D{row}/100,2)")
    c = r.cell(row=row, column=9, value=float(e["amount"]) * (1 if e["direction"] == "ADD" else -1)); c.fill = EXPECT
    r.cell(row=row, column=10, value=e["direction"])
    row += 1
for x in G["manual"]:
    r.cell(row=row, column=1, value="MANUAL"); r.cell(row=row, column=3, value=x["category"])
    amt = 0.0 if x.get("withdraw") else float(x["amount"]) * (1 if x["direction"] == "ADD" else -1)
    r.cell(row=row, column=8, value=amt); r.cell(row=row, column=9, value=amt).fill = EXPECT
    r.cell(row=row, column=10, value=f'{x["direction"]}{" (withdrawn: not counted)" if x.get("withdraw") else ""}')
    row += 1
end = row - 1
s = wb.create_sheet("Statement")
header(s, 1, ["Line", "Workings", "Expected (API)"], [34, 18, 18])
lines = [
    ("Accounting profit", f"={acc_profit}", G["expected"]["accountingProfit"]),
    ("Total added", f'=SUMIF(Adjustments!H2:H{end},">0")', G["expected"]["totalAdded"]),
    ("Total deducted", f'=-SUMIF(Adjustments!H2:H{end},"<0")', G["expected"]["totalDeducted"]),
    ("Adjusted profit (before capital allowances and losses)", "=B2+B3-B4", G["expected"]["adjustedProfit"]),
]
for i, (a, b, c) in enumerate(lines, start=2):
    s.cell(row=i, column=1, value=a); s.cell(row=i, column=2, value=b).number_format = "#,##0.00"
    s.cell(row=i, column=3, value=float(c)).fill = EXPECT; s.cell(row=i, column=3).number_format = "#,##0.00"
s.cell(row=7, column=1, value="Check: workings equal expected"); s.cell(row=7, column=2, value="=AND(ROUND(B2-C2,2)=0,ROUND(B3-C3,2)=0,ROUND(B4-C4,2)=0,ROUND(B5-C5,2)=0)")
wb.save(OUT)
print(OUT)
