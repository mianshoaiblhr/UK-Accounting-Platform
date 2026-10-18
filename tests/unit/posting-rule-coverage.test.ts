import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JOURNAL_SOURCES } from '@uk/contracts';
import { CATEGORIES, POSTING_RULE_COVERAGE } from '../rules/posting-rules';

/** V1-TEST-01 (DEC-047): every posting rule has positive, negative, reversal, VAT and period-lock evidence, or a stated design reason. */
const root = resolve(__dirname, '../..');
const titles = new Map<string, string>();
const source = (file: string) => {
  if (!titles.has(file)) titles.set(file, readFileSync(resolve(root, file), 'utf8'));
  return titles.get(file)!;
};
/** The title as it is written in an `it(...)` call, in any of the three quote styles. */
const declared = (text: string, title: string) =>
  [`it('${title.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`, `it("${title.replace(/"/g, '\\"')}"`, `it(\`${title}\``].some((form) => text.includes(form));

describe('posting-rule coverage registry (V1-TEST-01, DEC-047)', () => {
  it('lists every journal source and nothing else', () => {
    expect(Object.keys(POSTING_RULE_COVERAGE).sort()).toEqual(Object.keys(JOURNAL_SOURCES).sort());
  });

  it('fills every category of every source with a named test or a design reason', () => {
    const blank: string[] = [];
    for (const [s, row] of Object.entries(POSTING_RULE_COVERAGE)) {
      for (const c of CATEGORIES) {
        const cell = row[c];
        if (!cell || ('na' in cell ? cell.na.trim().length < 20 : !cell.file || !cell.test)) blank.push(`${s}.${c}`);
      }
    }
    expect(blank).toEqual([]);
  });

  it('names only tests that exist, by file and exact title', () => {
    const missing: string[] = [];
    for (const [s, row] of Object.entries(POSTING_RULE_COVERAGE)) {
      for (const c of CATEGORIES) {
        const cell = row[c];
        if ('na' in cell) continue;
        if (!existsSync(resolve(root, cell.file))) missing.push(`${s}.${c}: no file ${cell.file}`);
        else if (!declared(source(cell.file), cell.test)) missing.push(`${s}.${c}: no test "${cell.test}" in ${cell.file}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps n/a for what the design rules out: VAT only on sources without VAT codes, reversal only on mirrors and corrections', () => {
    const na = Object.entries(POSTING_RULE_COVERAGE).flatMap(([s, row]) => CATEGORIES.filter((c) => 'na' in row[c]).map((c) => `${s}.${c}`));
    for (const x of na) expect(x.endsWith('.reversal'), `${x} may not be n/a`).toBe(true);
    expect(na.sort()).toEqual(['ACCRUAL_CANCELLATION.reversal', 'ADJUSTMENT_RELEASE_REVERSAL.reversal', 'ADJUSTMENT_SETUP_REVERSAL.reversal', 'BANK_TRANSFER_REVERSAL.reversal', 'CASH_PAYMENT_REVERSAL.reversal', 'CASH_RECEIPT_REVERSAL.reversal', 'FIXED_ASSET_ADDITION_REVERSAL.reversal',
      'FIXED_ASSET_DEPRECIATION_REVERSAL.reversal', 'FIXED_ASSET_DISPOSAL_REVERSAL.reversal', 'PROVISION_MOVEMENT_REVERSAL.reversal', 'PURCHASE_DEBIT_NOTE.reversal', 'PURCHASE_PAYMENT_REVERSAL.reversal',
      'REVERSAL.reversal', 'SALES_CREDIT_NOTE.reversal', 'SALES_RECEIPT_REVERSAL.reversal']);
  });
});
