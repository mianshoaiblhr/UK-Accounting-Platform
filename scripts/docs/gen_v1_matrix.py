#!/usr/bin/env python3
"""Regenerates docs/architecture/v1-compliance-matrix.md and .xlsx from v1-compliance-matrix.json (the source of truth).
Usage: python3 scripts/docs/gen_v1_matrix.py [--commit SHA] [--ci URL]   (needs openpyxl for the workbook)
Statuses are changed only in the JSON, together with the evidence (files and passing tests) that justifies the change."""
import argparse, collections, datetime, json, pathlib

root = pathlib.Path(__file__).resolve().parents[2]
src = root / "docs/architecture/v1-compliance-matrix.json"
ap = argparse.ArgumentParser(); ap.add_argument("--commit", default=""); ap.add_argument("--ci", default="")
a = ap.parse_args()
d = json.loads(src.read_text())
names = d["statuses"]
rows = d["rows"]
cnt = collections.Counter(r["s"] for r in rows)
total = len(rows); applicable = total - cnt["N"]
ms = collections.OrderedDict((k, [r for r in rows if r["m"] == k]) for k in d["milestones"])
esc = lambda s: (s or "").replace("|", "\\|").replace("\n", " ")

md = [f"# {d['title']}", "",
      f"Source requirements: {d['source']}.", "",
      f"Generated from `v1-compliance-matrix.json`" + (f" at commit `{a.commit}`" if a.commit else "") + (f"; CI: <{a.ci}>" if a.ci else "") + ". **Statuses change only with evidence (code and passing tests); a requirement is never marked implemented because a table or flag exists.**", "",
      "## Summary", "", "| Status | Rows |", "|---|---|"]
for k in "IPMN": md.append(f"| {names[k]} | {cnt[k]}" + (f" ({cnt[k]*100//applicable}% of applicable)" if k != "N" and applicable else "") + " |")
md += [f"| **Total** | **{total}** |", "", "## Milestones", "", "| Milestone | Scope | Rows | Implemented |", "|---|---|---|---|"]
for k, rs in ms.items(): md.append(f"| {k} | {d['milestones'][k]} | {len(rs)} | {sum(1 for r in rs if r['s'] == 'I')} |")
md += ["", d["acceptance"], ""]
for k, rs in ms.items():
    md += [f"## {k} - {d['milestones'][k]}", "", "| ID | Reference | Requirement | Status | Evidence | Notes |", "|---|---|---|---|---|---|"]
    for r in rs: md.append(f"| **{r['id']}** | {esc(r['ref'])} | {esc(r['req'])} | **{names[r['s']]}** | {esc(r['ev'])} | {esc(r['note'])} |")
    md.append("")
(root / "docs/architecture/v1-compliance-matrix.md").write_text("\n".join(md))

try:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter
except ImportError:
    print("openpyxl missing: workbook not written"); raise SystemExit(0)
wb = Workbook(); ws = wb.active; ws.title = "V1 matrix"
ws.append(["ID", "Reference", "Requirement", "Milestone", "Status", "Evidence", "Notes"])
fills = {"I": "C6EFCE", "P": "FFEB9C", "M": "FFC7CE", "N": "D9D9D9"}
for r in rows:
    ws.append([r["id"], r["ref"], r["req"], r["m"], names[r["s"]], r["ev"], r["note"]]); ws.cell(ws.max_row, 5).fill = PatternFill("solid", fgColor=fills[r["s"]])
for c in ws[1]: c.font = Font(bold=True, color="FFFFFF"); c.fill = PatternFill("solid", fgColor="1F3864")
for i, w in enumerate([14, 30, 70, 10, 24, 80, 60], 1): ws.column_dimensions[get_column_letter(i)].width = w
for row in ws.iter_rows(min_row=2):
    for c in row: c.alignment = Alignment(wrap_text=True, vertical="top")
ws.freeze_panes = "B2"; ws.auto_filter.ref = ws.dimensions
s = wb.create_sheet("Summary"); s.append(["Status", "Rows"])
for k in "IPMN": s.append([names[k], cnt[k]])
s.append(["Total", total]); s.append([]); s.append(["Milestone", "Scope", "Rows", "Implemented"])
for k, rs in ms.items(): s.append([k, d["milestones"][k], len(rs), sum(1 for r in rs if r["s"] == "I")])
s.append([]); s.append(["Commit", a.commit]); s.append(["CI", a.ci]); s.append(["Generated", datetime.date.today().isoformat()])
s.column_dimensions["A"].width = 22; s.column_dimensions["B"].width = 80
wb.save(root / "docs/architecture/v1-compliance-matrix.xlsx")
print(total, dict(cnt))
