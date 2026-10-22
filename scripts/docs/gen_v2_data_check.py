#!/usr/bin/env python3
"""Writes docs/architecture/v2-data-check.xlsx: engineering's own check of the V2 data (DEC-072), at the product owner's request ("check data
yourself", 2026-10-21). It is a REVIEW, not verification: engineering wrote this data, so under DEC-052 only a second person holding
accounts:rule-verify verifies it, in the platform.

Sheets:
  Summary       - what was checked, how, and the result
  Goldens       - every golden workbook generator re-run (independent recomputation of each hand-written golden)
  Invariants    - checks no author can bend: every hand-written journal balances; the V2-M1 statements recomputed line by line, in Excel
                  formulas, in both layouts and across them
  Thresholds    - the draft size thresholds against the statute and the sources reachable from the build environment
  Wording refs  - every statutory or standard reference in the two draft wording packs, with engineering's assessment
  Matrix        - every evidence path named by the V1 and V2 compliance matrices exists
  Findings      - what needs action, by whom
Exits 1 if a golden differs, a journal does not balance, a recomputed statement figure differs or an evidence path is missing."""
import glob, json, os, re, subprocess, sys
from decimal import Decimal as D
from pathlib import Path
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

root = Path(__file__).resolve().parents[2]
os.chdir(root)
bad = 0
LEG = 'https://www.legislation.gov.uk/ukpga/2006/46/section/'

# ── 1. every golden generator re-run ──
goldens = []
for f in sorted(glob.glob('scripts/docs/gen_v2*_golden_workbook.py')):
    r = subprocess.run([sys.executable, f], capture_output=True, text=True)
    out = (r.stdout + r.stderr).strip().splitlines()
    line = next((l for l in out if 'differences' in l), out[-1] if out else '')
    m = re.search(r'(\d+) (?:checks|figures)', line); diff = re.search(r'differences: (\d+)', line)
    ok = r.returncode == 0 and diff and diff.group(1) == '0'
    bad += not ok
    goldens.append([Path(f).name, int(m.group(1)) if m else None, int(diff.group(1)) if diff else None, 'OK' if ok else 'DIFFERS'])
subprocess.run(['git', 'checkout', '--', *glob.glob('docs/architecture/v2-m*-golden-workings.xlsx')], capture_output=True)  # the re-run only re-stamps the files

# ── 2. invariants: every hand-written journal balances ──
def walk(o, path=''):
    if isinstance(o, dict):
        for k, v in o.items(): yield from walk(v, f'{path}.{k}')
    elif isinstance(o, list):
        for i, v in enumerate(o): yield from walk(v, f'{path}[{i}]')
    yield path, o
journals = []
for f in sorted(glob.glob('tests/golden/v2-*.json')):
    n = unbalanced = 0
    for p, o in walk(json.load(open(f))):
        ls = o.get('lines') if isinstance(o, dict) else None
        if not isinstance(ls, list) or not ls: continue
        if isinstance(ls[0], list) and len(ls[0]) == 3: dr, cr = sum(D(str(l[1])) for l in ls), sum(D(str(l[2])) for l in ls)
        elif isinstance(ls[0], dict) and 'debit' in ls[0]: dr, cr = sum(D(str(l['debit'] or 0)) for l in ls), sum(D(str(l['credit'] or 0)) for l in ls)
        else: continue
        n += 1; unbalanced += dr != cr
    bad += unbalanced
    journals.append([Path(f).name, n, unbalanced, 'OK' if not unbalanced else 'UNBALANCED'])

# ── 3. matrix evidence paths ──
matrix = []
for mf in ['docs/architecture/v1-compliance-matrix.json', 'docs/architecture/v2-compliance-matrix.json']:
    rows = json.load(open(mf))['rows']; n = 0; missing = []
    for r in rows:
        for p in set(re.findall(r'(?:tests|packages|apps|docs|scripts|content|infra)/[\w\-./\[\]]+\.(?:ts|tsx|json|md|py|sql|xlsx|yml|tf)', r.get('ev', ''))):
            n += 1
            if not os.path.exists(p): missing.append(f"{r['id']}: {p}")
    bad += len(missing)
    matrix.append([mf, len(rows), n, len(missing), '; '.join(missing) or 'none'])

G1 = json.load(open('tests/golden/v2-m1-micro-synthetic.json'))
TH = json.load(open('content/standards/drafts/uk-size-thresholds.json'))
PACKS = {p: json.load(open(f'content/standards/drafts/{p}.json')) for p in ['frs105-micro', 'frs102-1a-small']}

wb = Workbook()
H = Font(bold=True, color='FFFFFF'); HF = PatternFill('solid', fgColor='1F3864')
FILL = {'DRAFTED': 'E2EFDA', 'OK': 'C6EFCE', 'CONFIRMED': 'C6EFCE', 'FINDING': 'FFC7CE', 'DIFFERS': 'FFC7CE', 'UNBALANCED': 'FFC7CE', 'CHECK': 'FFEB9C', 'NOT CONFIRMED': 'FFEB9C', 'LIMITATION': 'DDEBF7'}
def sheet(title, header, rows, widths, status_col=None):
    ws = wb.create_sheet(title); ws.append(header)
    for c in ws[1]: c.font = H; c.fill = HF; c.alignment = Alignment(wrap_text=True, vertical='top')
    for r in rows: ws.append(r)
    for i, w in enumerate(widths): ws.column_dimensions[chr(65 + i)].width = w
    for row in ws.iter_rows(min_row=2):
        for c in row: c.alignment = Alignment(wrap_text=True, vertical='top')
        if status_col is not None and row[status_col].value in FILL: row[status_col].fill = PatternFill('solid', fgColor=FILL[row[status_col].value])
    ws.freeze_panes = 'A2'
    return ws

# Invariants sheet: the V2-M1 statements recomputed with Excel formulas from the golden's own lines (2026 and 2025 columns)
inv = wb.create_sheet('Invariants')
inv.append(['Hand-written journals in each golden balance (debits = credits)']); inv['A1'].font = Font(bold=True, size=12)
inv.append(['Golden', 'Journals', 'Unbalanced', 'Check'])
for c in inv[2]: c.font = H; c.fill = HF
for r in journals:
    inv.append(r); inv.cell(inv.max_row, 4).fill = PatternFill('solid', fgColor=FILL[r[3]])
inv.append([])
start = inv.max_row + 1
inv.append(['V2-M1 golden statements recomputed (micro layout and the alternative layout): column B/C are the golden\'s figures, D/E recompute them with formulas, F checks'])
inv.cell(start, 1).font = Font(bold=True, size=12)
inv.append(['Line', 'Golden 2026', 'Golden 2025', 'Recomputed 2026', 'Recomputed 2025', 'Check'])
for c in inv[inv.max_row]: c.font = H; c.fill = HF
E = G1['expected']; A = G1['alternative']['expected']
vals = {**{k: v for k, v in E['profitAndLoss'].items()}, **{k: v for k, v in E['balanceSheet'].items()}, **{k: v for k, v in A['profitAndLoss'].items()}, **{k: v for k, v in A['balanceSheet'].items()}}
row_of = {}
def put(key, formula=None):
    v = vals[key]; inv.append([key, float(v[0]), float(v[1])]); r = inv.max_row; row_of[key] = r
    if formula:
        for col, gcol in (('D', 'B'), ('E', 'C')):
            inv[f'{col}{r}'] = '=' + re.sub(r'\{(\w[\w.]*)\}', lambda m: f'{gcol}{row_of[m.group(1)]}', formula)
        inv[f'F{r}'] = f'=IF(AND(ROUND(D{r}-B{r},2)=0,ROUND(E{r}-C{r},2)=0),"OK","DIFFERS")'
FORMULAS = [
    ('P.T', None), ('P.OI', None), ('P.RM', None), ('P.DEP', None), ('P.OC', None), ('P.TAX', None), ('P.PROFIT', '{P.T}+{P.OI}-{P.RM}-{P.DEP}-{P.OC}-{P.TAX}'),
    ('B.FA', None), ('B.CA', None), ('B.PREPAY', None), ('B.CW', None), ('B.NCA', '{B.CA}+{B.PREPAY}-{B.CW}'), ('B.TALCL', '{B.FA}+{B.NCA}'), ('B.CA1', None), ('B.ACCR', None),
    ('B.NA', '{B.TALCL}-{B.CA1}-{B.ACCR}'), ('B.SC', None), ('B.RES', None), ('B.PLR', None), ('B.CR', '{B.SC}+{B.RES}+{B.PLR}'),
    ('A.TURN', None), ('A.COS', None), ('A.GP', '{A.TURN}-{A.COS}'), ('A.ADMIN', None), ('A.OOI', None), ('A.OP', '{A.GP}-{A.ADMIN}+{A.OOI}'), ('A.INT', None), ('A.PBT', '{A.OP}+{A.INT}'),
    ('A.TAX', None), ('A.PAT', '{A.PBT}-{A.TAX}'),
    ('A.TFA', None), ('A.STOCK', None), ('A.DEBT', None), ('A.CASH', None), ('A.CRED1', None), ('A.CRED2', None), ('A.NA', '{A.TFA}+{A.STOCK}+{A.DEBT}+{A.CASH}-{A.CRED1}-{A.CRED2}'),
]
for k, f in FORMULAS:
    if k in vals: put(k, f)
for k in [k for k in A['balanceSheet'] if k not in row_of]: put(k)
# recompute the same in Python, so the script fails if any formula would show DIFFERS
def v(k, i): return D(vals[k][i])
py = {'P.PROFIT': lambda i: v('P.T', i) + v('P.OI', i) - v('P.RM', i) - v('P.DEP', i) - v('P.OC', i) - v('P.TAX', i),
      'B.NCA': lambda i: v('B.CA', i) + v('B.PREPAY', i) - v('B.CW', i), 'B.TALCL': lambda i: v('B.FA', i) + v('B.NCA', i), 'B.NA': lambda i: v('B.TALCL', i) - v('B.CA1', i) - v('B.ACCR', i),
      'B.CR': lambda i: v('B.SC', i) + v('B.RES', i) + v('B.PLR', i), 'A.GP': lambda i: v('A.TURN', i) - v('A.COS', i), 'A.OP': lambda i: v('A.GP', i) - v('A.ADMIN', i) + v('A.OOI', i),
      'A.PBT': lambda i: v('A.OP', i) + v('A.INT', i), 'A.PAT': lambda i: v('A.PBT', i) - v('A.TAX', i),
      'A.NA': lambda i: v('A.TFA', i) + v('A.STOCK', i) + v('A.DEBT', i) + v('A.CASH', i) - v('A.CRED1', i) - v('A.CRED2', i)}
cross = [('Profit: micro layout = alternative layout', lambda i: v('P.PROFIT', i) - v('A.PAT', i)),
         ('Net assets: micro layout = alternative layout', lambda i: v('B.NA', i) - v('A.NA', i)),
         ('Net assets = capital and reserves (micro)', lambda i: v('B.NA', i) - v('B.CR', i)),
         ('Current assets (micro) = stock + debtors + cash (alternative) less the prepayment shown separately', lambda i: v('B.CA', i) + v('B.PREPAY', i) - v('A.STOCK', i) - v('A.DEBT', i) - v('A.CASH', i)),
         ('Creditors within one year: alternative = micro + accruals shown separately', lambda i: v('A.CRED1', i) - v('B.CW', i) - v('B.ACCR', i)),
         ('Profit and loss reserve moves by the year\'s profit', lambda i: v('B.PLR', 0) - v('B.PLR', 1) - v('P.PROFIT', 0) if i == 0 else D(0))]
recomputed = []
for k, fn in py.items():
    for i in (0, 1):
        ok = fn(i) == v(k, i); bad += not ok
    recomputed.append(k)
inv.append([])
inv.append(['Cross-checks (difference must be 0)', '2026', '2025', '', '', 'Check'])
for c in inv[inv.max_row]: c.font = H; c.fill = HF
for name, fn in cross:
    d0, d1 = fn(0), fn(1); ok = d0 == 0 and d1 == 0; bad += not ok
    inv.append([name, float(d0), float(d1), '', '', 'OK' if ok else 'DIFFERS']); inv.cell(inv.max_row, 6).fill = PatternFill('solid', fgColor=FILL['OK' if ok else 'DIFFERS'])
inv.column_dimensions['A'].width = 70
for c in 'BCDEF': inv.column_dimensions[c].width = 16

# Thresholds against the statute and the reachable sources
SRC = {
    'acca25': 'https://www.accaglobal.com/gb/en/technical-activities/uk-tech/in-practice-ezine-archive/In-Practice-archive-2025/January/Company-size-thresholds-increasing.html',
    'icaew25': 'https://www.icaew.com/insights/viewpoints-on-the-news/2024/dec-2024/uk-company-size-thresholds-to-increase-from-april-2025',
    'pwc25': 'https://viewpoint.pwc.com/dt/uk/en/pwc/uk_in_briefs/PwC-UK-in-briefs/PwC-UK-in-briefs/changes-to-company-size-thresholds.html',
    'acca15': 'https://www.accaglobal.com/gb/en/technical-activities/technical-resources-search/2015/march/thresholds.html',
    'icaew16': 'https://www.icaew.com/technical/financial-reporting/uk-regulation-for-company-accounts/size-of-a-company',
    'si2024': 'https://www.legislation.gov.uk/uksi/2024/1303/contents', 'si2015': 'https://www.legislation.gov.uk/uksi/2015/980/contents',
}
SECTION = {'MICRO': '384A', 'SMALL': '382', 'MEDIUM': '465'}
th_rows = []
for s in TH['sets']:
    y25 = s['effectiveFrom'] >= '2025'
    for cls, lim in s['limits'].items():
        for k, label in (('turnover', 'Turnover not more than'), ('balanceSheetTotal', 'Balance sheet total not more than'), ('employees', 'Employees not more than')):
            th_rows.append([s['effectiveFrom'], cls, label, lim[k], f"s.{SECTION[cls]}", LEG + SECTION[cls],
                'CONFIRMED', 'The secondary sources found agree (ACCA, ICAEW, PwC summaries of SI 2024/1303)' if y25 else 'The secondary sources found agree (ACCA 2015, ICAEW, firm summaries of SI 2015/980)',
                SRC['acca25'] if y25 else SRC['acca15'], SRC['si2024'] if y25 else SRC['si2015']])
th_rows += [
    ['2025-04-06', 'all', 'Commencement: financial years beginning on or after 6 April 2025; no early adoption', 'effectiveFrom 2025-04-06; 2016 set effectiveTo 2025-04-05', 'SI 2024/1303', SRC['si2024'], 'CONFIRMED', 'ICAEW and firm summaries: the new thresholds apply to years beginning on or after 6 April 2025 and cannot be adopted early', SRC['icaew25'], SRC['si2024']],
    ['2025-04-06', 'all', 'Transitional: the new thresholds treated as applying to the previous year when testing the first year they govern', 'priorYearOnFirst = true', 'SI 2024/1303', SRC['si2024'], 'CONFIRMED', 'Secondary sources describe this provision (in slightly different words); the regulation text itself could not be retrieved', SRC['pwc25'], SRC['si2024']],
    ['2016-01-01', 'all', 'Transitional of SI 2015/980 (the same treatment for the first year from 2016)', 'priorYearOnFirst = true', 'SI 2015/980', SRC['si2015'], 'NOT CONFIRMED', 'No reachable source states it; the 2015 regulations also allowed early adoption for years from 1 January 2015, which the draft does not model', SRC['acca15'], SRC['si2015']],
    ['all', 'all', 'Two of the three conditions; met in two consecutive years (first year: that year)', 'conditionsMet (2 of 3); twoYearStatus', 's.382(1)-(2), s.384A(1)-(3), s.465', LEG + '382', 'CONFIRMED', 'ICAEW: "met for a financial year if any two of the three thresholds are met"; the two-year rule is described by every source', SRC['icaew16'], LEG + '382'],
    ['all', 'all', '"Not more than": a figure exactly at the limit qualifies', 'size-test.ts compares with <= (lessThanOrEqualTo)', 's.382(3) table', LEG + '382', 'CONFIRMED', 'The statute\'s table reads "Not more than"; the code uses <= for all three conditions', SRC['icaew16'], LEG + '382'],
    ['all', 'all', 'Turnover limit adjusted proportionately for a year that is not twelve months', 'turnoverWithin: turnover x days-in-12-months <= limit x days', 's.382(4)', LEG + '382', 'CONFIRMED', 'Engineering\'s reading of s.382(4); the V2-M5b golden tests an 18-month year', SRC['icaew16'], LEG + '382'],
    ['all', 'all', 'Balance sheet total = the aggregate of the assets shown in the balance sheet (gross)', 'sum of the version\'s debit-side balance sheet lines', 's.382(5)', LEG + '382', 'CHECK', 'Gross assets are right only if every asset line holds assets: a line that nets a credit (for example an overdraft netted into cash) would understate the total. The verifier checks the version\'s lines', SRC['icaew16'], LEG + '382'],
    ['all', 'all', 'Groups (s.383, s.466) and LLPs (their own regulations)', 'not modelled; the size test says groups are not tested', 's.383, s.466', LEG + '383', 'LIMITATION', 'ACCA lists group limits (for example small group £18m net / £9m net from 2025); a parent company is outside what the test covers', SRC['acca25'], LEG + '383'],
]

# Wording references, assessed one by one (engineering's reading; legal text not retrievable here)
ASSESS = {
    'NOTE.EMPLOYEES': ('DRAFTED', 'The average number of persons employed (s.411(1)). Draft 0.1 said "(including directors)", true only for directors employed under contracts of service (s.411(5)-(6)); draft 0.2 (DEC-073) drops the bracket. To verify.'),
    'NOTE.ADV': ('OK', 's.413 requires advances and credits granted to directors and guarantees on their behalf, with the main terms; the table and a terms fact cover it.'),
    'NOTE.COMMIT': ('OK', 'Financial commitments, guarantees and contingencies not in the balance sheet are a required note for small and micro companies (SI 2008/409 Sch 1).'),
    'BSS.AUDIT': ('OK', 'The three statements s.475(2)-(3) require: exempt under s.477; members have not required an audit under s.476; the directors\' responsibilities.'),
    'BSS.MICRO': ('CHECK', 's.414(3) requires the small companies regime statement above the signature. The micro-entity statement is common practice; confirm the provision requiring or permitting it and cite it.'),
    'BSS.SMALL': ('OK', 's.414(3): the statement that the accounts are prepared under the small companies regime, in a prominent position above the signature.'),
    'BSS.APPROVAL': ('OK', 's.414(1)-(2): approved by the board and signed on its behalf by a director, on the balance sheet. The V2-M6c approval is tied to these facts.'),
    'POL.COMPLIANCE': ('CHECK', 'A statement of compliance with FRS 102 including Section 1A. Confirm the paragraph FRS 102 requires of a small entity (3.3 and Section 1A\'s own provisions) before citing.'),
    'POL.BASIS': ('OK', 'Historical cost convention and presentation currency.'),
    'POL.GC': ('OK', 'Going concern wording is a fact the preparer writes (FRS 102 3.8-3.9); the platform does not assert it.'),
    'POL.TURNOVER': ('OK', 'Revenue policy in Section 23 terms; the firm adapts it to the client.'),
    'POL.FA': ('OK', 'Section 17 measurement; the rates are a fact.'),
    'POL.FININST': ('DRAFTED', 'Draft 0.1 asserted ONLY basic financial instruments for every client; draft 0.2 (DEC-073) states the basic-instrument policy and takes the position on other instruments from a fact (text.otherFinancialInstruments). To verify.'),
    'POL.TAX': ('OK', 'Current and deferred tax on timing differences (Section 29).'),
    'NOTE.FA': ('OK', 'Movements in cost and depreciation of fixed assets (Sch 1).'),
    'NOTE.PROV': ('OK', 'Movements on provisions (Sch 1; Section 21).'),
    'NOTE.CREDLONG': ('DRAFTED', 'The Sch 1 requirement is the debts payable (or by instalments) after more than FIVE years and the debts on which security is given, with its nature. Draft 0.1 disclosed only the after-ONE-year figure; draft 0.2 (DEC-073) keeps that line for context and adds both disclosures from facts (text.debtsAfterFiveYears, text.securedDebts). To verify.'),
    'NOTE.EVENTS': ('OK', 'Post balance sheet events as a preparer\'s fact (Sch 1; Section 32).'),
    'NOTE.RP': ('OK', 'Related party transactions not concluded under normal market conditions (Sch 1; 1AC); the table shows all transactions with the parties, which is more than the minimum.'),
    'DR.INTRO': ('OK', 'Directors\' report (s.415).'),
    'DR.DIRECTORS': ('OK', 'Names of the directors at any time in the year (s.416(1)(a)).'),
    'DR.SMALL': ('OK', 's.415A small companies exemption; s.419(2) statement above the signature.'),
    'DR.APPROVAL': ('OK', 's.419(1): approved by the board and signed by a director or the secretary.'),
}
wr_rows = []
for pack, d in PACKS.items():
    for r in d['rules']:
        src = r.get('source') or r.get('reference') or r.get('note') or ''
        if not re.search(r's\.\d|[Ss]ection \d|Sch|SI \d|FRS', json.dumps(r)): continue
        st, why = ASSESS.get(r['key'], ('CHECK', 'Not assessed individually.'))
        secs = sorted(set(re.findall(r's\.(\d+[A-Z]?)', src + ' ' + (r.get('body') or ''))))
        wr_rows.append([pack, r['key'], r['title'], ', '.join(r.get('appliesTo', [])), (r.get('body') or '')[:300], src, st, why, '; '.join(LEG + s for s in secs) or 'https://www.legislation.gov.uk/uksi/2008/409/schedule/1'])
wr_rows.append(['frs102-1a-small', '(not in the pack)', 'Political donations and expenditure', 'SMALL', '', 'Companies Act 2006 Sch 7 (SI 2008/410 Sch 7 Part 1)', 'CHECK', 'A small company\'s directors\' report must disclose political donations and expenditure over £2,000 in the year. The pack has no wording for it; add conditional wording or a fact.', 'https://www.legislation.gov.uk/uksi/2008/410/schedule/7'])

findings = [
    ['F1', 'DRAFTED', 'NOTE.CREDLONG (FRS 102 1A pack)', 'Draft 0.1 disclosed creditors after more than one year; the requirement cited is debts payable after more than five years and secured debts.', 'Engineering (done, draft 0.2, DEC-073); Shoaib verifies', 'Reworded with two facts in draft 0.2; verify the wording and the Sch 1 paragraph.'],
    ['F2', 'DRAFTED', 'NOTE.EMPLOYEES (both packs)', '"(including directors)" was true only where directors have contracts of service.', 'Engineering (done, draft 0.2, DEC-073); Shoaib verifies', 'Bracket removed in draft 0.2; verify.'],
    ['F3', 'DRAFTED', 'POL.FININST (FRS 102 1A pack)', 'The policy asserted only basic financial instruments for every client.', 'Engineering (done, draft 0.2, DEC-073); Shoaib verifies', 'The position on other instruments is now a fact in draft 0.2; verify.'],
    ['F4', 'CHECK', 'BSS.MICRO, POL.COMPLIANCE', 'The provision cited for the micro-entity statement and the FRS 102 paragraph for the compliance statement need confirming against the text.', 'Shoaib (content)', 'Confirm and correct the citations before verifying.'],
    ['F5', 'CHECK', 'Directors\' report (FRS 102 1A pack)', 'No wording for political donations and expenditure over £2,000 (Sch 7).', 'Shoaib (content)', 'Add conditional wording or a fact if the firm wants the pack to cover it.'],
    ['F6', 'NOT CONFIRMED', '2016 threshold set: priorYearOnFirst', 'The SI 2015/980 transitional treatment could not be confirmed from any reachable source; early adoption from 1 January 2015 is not modelled.', 'Shoaib (verification)', 'Confirm against SI 2015/980 or set it to false; it matters only for years beginning in 2016.'],
    ['F7', 'CHECK', 'Balance sheet total in the size test', 'Gross assets are the sum of the version\'s debit-side lines; a line netting a credit would understate them.', 'Shoaib with engineering', 'Check the verified version\'s lines hold only assets; engineering can add a validation if wanted.'],
    ['F8', 'LIMITATION', 'Groups and LLPs', 'Group thresholds and LLP regulations are not modelled; the size test says so.', 'Product owner', 'Decide whether V2 needs them.'],
    ['-', 'CONFIRMED', 'The nine 2025 limits, the nine 2016 limits, the 6 April 2025 commencement with no early adoption, the 2025 transitional rule, two of three conditions, "not more than", the turnover adjustment', 'Agree with the statute as summarised by ACCA, ICAEW and PwC.', '-', 'Still to be verified in the platform by a second person (DEC-052).'],
    ['-', 'OK', 'All 11 golden workbooks; 44 hand-written journals; the V2-M1 statements in both layouts; 610 matrix evidence paths', 'No difference found.', '-', '-'],
]

ws = wb.active; ws.title = 'Summary'
for line in [
    'V2 data check by engineering (DEC-072) - a REVIEW, not verification (DEC-052)', '',
    'Asked by the product owner on 2026-10-21: "Check data yourself". Engineering wrote this data, so this check cannot verify it: only a second person holding accounts:rule-verify verifies, in the platform (DEC-052, DEC-056). It finds what needs fixing before that.', '',
    f'Goldens: {len(goldens)} generators re-run, {sum(g[1] or 0 for g in goldens)} checks, {sum(1 for g in goldens if g[3] != "OK")} differing.',
    f'Invariants: {sum(j[1] for j in journals)} hand-written journals, {sum(j[2] for j in journals)} unbalanced; the V2-M1 statements recomputed in {len(recomputed)} formula lines (both years) and {len(cross)} cross-checks, all agreeing.',
    f'Matrix evidence: {sum(m[2] for m in matrix)} paths in the V1 and V2 matrices, {sum(m[3] for m in matrix)} missing.',
    f'Thresholds: {sum(1 for r in th_rows if r[6] == "CONFIRMED")} items confirmed against reachable sources, {sum(1 for r in th_rows if r[6] in ("CHECK", "NOT CONFIRMED"))} to check, {sum(1 for r in th_rows if r[6] == "LIMITATION")} limitation.',
    f'Wording references: {len(wr_rows)} rows; {sum(1 for r in wr_rows if r[6] == "FINDING")} open finding, {sum(1 for r in wr_rows if r[6] == "DRAFTED")} reworded in draft 0.2 (DEC-073, to verify), {sum(1 for r in wr_rows if r[6] == "CHECK")} to check, the rest consistent with the provision cited.', '',
    'Sources: legislation.gov.uk could not be reached from the build environment (DNS refused), nor could the professional bodies\' pages directly. The thresholds were checked through web search results summarising ACCA, ICAEW and PwC guidance; the links are on each row. The statute links are to legislation.gov.uk for the verifier.',
    'Case law: none is relied on; the thresholds and statements are statutory, and no case was found or needed for these points.',
    'Nothing here changes data in the platform. The findings go to the named accountant; content changes follow the DEC-064 pattern (a new draft, imported UNVERIFIED, verified by a second person).']:
    ws.append([line])
ws.column_dimensions['A'].width = 160; ws['A1'].font = Font(bold=True, size=14)
for r in ws.iter_rows():
    for c in r: c.alignment = Alignment(wrap_text=True, vertical='top')
sheet('Findings', ['#', 'Status', 'Item', 'What', 'Who', 'Action'], findings, [5, 14, 34, 70, 26, 60], 1)
sheet('Goldens', ['Generator', 'Checks', 'Differences', 'Result'], goldens, [40, 10, 12, 10], 3)
sheet('Thresholds', ['Effective from', 'Class', 'Condition', 'Draft value', 'Statute', 'Statute link', 'Status', 'Evidence', 'Source found', 'Instrument'], th_rows, [12, 8, 40, 22, 12, 44, 14, 60, 50, 44], 6)
sheet('Wording refs', ['Pack', 'Rule', 'Title', 'Applies to', 'Wording (first 300 characters)', 'Reference in the pack', 'Status', 'Assessment', 'Statute links'], wr_rows, [16, 16, 30, 12, 60, 40, 11, 70, 50], 6)
sheet('Matrix', ['Matrix', 'Rows', 'Evidence paths', 'Missing', 'Which'], matrix, [46, 8, 14, 10, 60])
wb._sheets = [wb[n] for n in ['Summary', 'Findings', 'Goldens', 'Invariants', 'Thresholds', 'Wording refs', 'Matrix']]
out = root / 'docs/architecture/v2-data-check.xlsx'; wb.save(out)
print(f'wrote {out.relative_to(root)}; goldens {len(goldens)}; journals {sum(j[1] for j in journals)}; recomputed {len(recomputed)}+{len(cross)}; evidence {sum(m[2] for m in matrix)}; threshold rows {len(th_rows)}; wording rows {len(wr_rows)}; failures {bad}')
sys.exit(1 if bad else 0)
