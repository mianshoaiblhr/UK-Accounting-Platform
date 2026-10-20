import { describe, expect, it } from 'vitest';
import { cashFlowLines, money, ZERO, type CashFlowAccount, type CashFlowClassDef, type CashFlowFlows } from '@uk/accounting';
import { cashFlowClassErrors, createCashFlowClassSchema, createCashFlowMapEntrySchema } from '@uk/contracts';

/** V2-M5c (DEC-067): the identity behind the statement, on generated ledgers, and the shape rules of classes. */
const CLASSES: CashFlowClassDef[] = [
  { key: 'OP.WC', section: 'OPERATING', sort: 10, name: 'Working capital', adjustmentName: null, inflowName: null, outflowName: null },
  { key: 'INV.FA', section: 'INVESTING', sort: 10, name: 'Fixed assets', adjustmentName: 'Non-cash fixed assets', inflowName: 'Sales', outflowName: 'Purchases' },
  { key: 'FIN.L', section: 'FINANCING', sort: 10, name: 'Loans', adjustmentName: 'Non-cash loans', inflowName: null, outflowName: null },
];
const ACCOUNTS: CashFlowAccount[] = [
  { id: 'cash', code: '1200', name: 'Bank', type: 'ASSET', subtype: 'CURRENT_ASSET_BANK', mapping: 'BS.CURRENT_ASSETS.CASH', target: 'CASH' },
  { id: 'sales', code: '4000', name: 'Sales', type: 'INCOME', subtype: 'SALES', mapping: 'PL.TURNOVER', target: null },
  { id: 'cost', code: '5000', name: 'Costs', type: 'EXPENSE', subtype: 'COST_OF_SALES', mapping: 'PL.COST_OF_SALES', target: null },
  { id: 'interest', code: '7000', name: 'Interest', type: 'EXPENSE', subtype: 'INTEREST_EXPENSE', mapping: 'PL.INTEREST_PAYABLE', target: 'FIN.L' },
  { id: 'debtors', code: '1110', name: 'Debtors', type: 'ASSET', subtype: 'CURRENT_ASSET_RECEIVABLE', mapping: 'BS.CURRENT_ASSETS.DEBTORS', target: 'OP.WC' },
  { id: 'fa', code: '0030', name: 'Equipment', type: 'ASSET', subtype: 'FIXED_ASSET_TANGIBLE', mapping: 'BS.FIXED_ASSETS.TANGIBLE', target: 'INV.FA' },
  { id: 'dep', code: '0031', name: 'Depreciation', type: 'ASSET', subtype: 'FIXED_ASSET_DEPRECIATION', mapping: 'BS.FIXED_ASSETS.TANGIBLE', target: 'INV.FA' },
  { id: 'loan', code: '2300', name: 'Loan', type: 'LIABILITY', subtype: 'LONG_TERM_LIABILITY', mapping: 'BS.CREDITORS_AFTER_ONE_YEAR', target: 'FIN.L' },
  { id: 'odd', code: '1999', name: 'Unplaced', type: 'ASSET', subtype: 'CURRENT_ASSET_OTHER', mapping: 'BS.CURRENT_ASSETS.DEBTORS', target: null },
];
const accounts = new Map(ACCOUNTS.map((a) => [a.id, a]));
/** A seeded generator, so a failure can be replayed. */
const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

/** The flows of a ledger computed the way the service's query does: E over all journals, C and the gross parts over journals with a cash line. */
function flowsOf(journals: [string, number][][]) {
  const flows = new Map<string, CashFlowFlows>();
  let cash = ZERO;
  for (const j of journals) {
    const touches = j.some(([a]) => a === 'cash');
    for (const [a, dc] of j) {
      const v = money(dc);
      if (a === 'cash') { cash = cash.plus(v); continue; }
      const f = flows.get(a) ?? { e: ZERO, c: ZERO, inflow: ZERO, outflow: ZERO };
      f.e = f.e.minus(v);
      if (touches) { f.c = f.c.minus(v); if (v.isNegative()) f.inflow = f.inflow.minus(v); else f.outflow = f.outflow.minus(v); }
      flows.set(a, f);
    }
  }
  return { flows, cash };
}

describe('the identity (DEC-067)', () => {
  it('on 300 generated ledgers the lines add up to the movement in cash, whatever the mix of cash and non-cash journals', () => {
    const ids = ACCOUNTS.map((a) => a.id);
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const journals: [string, number][][] = [];
      for (let n = 0; n < 25; n++) {
        // a balanced journal of 2 to 4 lines, in pence
        const k = 2 + Math.floor(r() * 3), lines: [string, number][] = [];
        let total = 0;
        for (let i = 0; i < k - 1; i++) { const v = Math.round((r() - 0.5) * 2_000_000) / 100; lines.push([ids[Math.floor(r() * ids.length)]!, v]); total += Math.round(v * 100); }
        lines.push([ids[Math.floor(r() * ids.length)]!, -total / 100]);
        journals.push(lines);
      }
      const { flows, cash } = flowsOf(journals);
      const { parts } = cashFlowLines(CLASSES, accounts, flows, 'Profit');
      const total = [...parts.values()].flatMap((m) => [...m.values()]).reduce((t, v) => t.plus(v), ZERO);
      expect(total.toFixed(2), `seed ${seed}`).toBe(cash.toFixed(2));
    }
  });
  it('places each kind of account where DEC-067 says', () => {
    const { flows } = flowsOf([
      [['cash', 100], ['sales', -100]],                        // cash sale
      [['debtors', 50], ['sales', -50]],                       // credit sale
      [['cash', 30], ['debtors', -30]],                        // receipt
      [['fa', 200], ['cash', -200]],                           // purchase
      [['cash', 40], ['fa', -40]],                             // sale proceeds against cost
      [['cost', 25], ['dep', -25]],                            // depreciation
      [['cash', 500], ['loan', -500]],                         // loan drawn
      [['interest', 10], ['cash', -10]],                       // interest paid
      [['interest', 5], ['loan', -5]],                         // interest added to the loan
      [['odd', 7], ['cash', -7]],                              // an unplaced account
    ]);
    const { defs, parts } = cashFlowLines(CLASSES, accounts, flows, 'Profit');
    const amount = (k: string) => [...(parts.get(k)?.values() ?? [])].reduce((t, v) => t.plus(v), ZERO).toFixed(2);
    expect(defs.map((d) => d.key)).toEqual(['PROFIT', 'ADJ:INV.FA', 'ADJ:FIN.L', 'OP.WC', 'UNCLASSIFIED', 'INV.FA:IN', 'INV.FA:OUT', 'FIN.L']);
    expect(['PROFIT', 'ADJ:INV.FA', 'ADJ:FIN.L', 'OP.WC', 'UNCLASSIFIED', 'INV.FA:IN', 'INV.FA:OUT', 'FIN.L'].map(amount))
      .toEqual(['125.00', '25.00', '0.00', '-20.00', '-7.00', '40.00', '-200.00', '490.00']);
    // 125 + 25 + 0 - 20 - 7 + 40 - 200 + 490 = 453 = 100 + 30 - 200 + 40 + 500 - 10 - 7
  });
});

describe('class shapes', () => {
  it('operating classes show the whole movement; investing and financing need a non-cash caption; gross captions come in pairs', () => {
    expect(cashFlowClassErrors({ section: 'OPERATING' })).toEqual([]);
    expect(cashFlowClassErrors({ section: 'OPERATING', adjustmentName: 'x' })).toHaveLength(1);
    expect(cashFlowClassErrors({ section: 'INVESTING' })).toEqual(['An investing or financing class needs a caption for its non-cash part (adjustmentName)']);
    expect(cashFlowClassErrors({ section: 'FINANCING', adjustmentName: 'x', inflowName: 'in' })).toEqual(['Gross captions come in pairs: inflowName and outflowName']);
    expect(createCashFlowClassSchema.safeParse({ key: 'CASH', section: 'OPERATING', name: 'x' }).success).toBe(false);
    expect(createCashFlowMapEntrySchema.safeParse({ sourceLine: 'PL.TURNOVER', target: 'CASH' }).success).toBe(false);
    expect(createCashFlowMapEntrySchema.safeParse({ sourceLine: 'BS.CURRENT_ASSETS.CASH', target: 'CASH' }).success).toBe(true);
  });
});
