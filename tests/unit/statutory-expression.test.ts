import { describe, expect, it } from 'vitest';
import { checkExpression, expressionLines, lineShapeErrors, type BoolExpr, type NumExpr } from '@uk/contracts';
import { ExpressionError, evaluateCondition, evaluateValue, money, versionProblems } from '@uk/accounting';

/** V2-M1 closed expression grammar (v2-plan 3.3, DEC-053): every construct evaluated exactly; everything else refused when written. */
const values: Record<string, string> = { A: '0.10', B: '0.20', C: '0.30', BIG: '123456789012345.6789', NEG: '-5.00' };
const v = (k: string) => (k in values ? money(values[k]!) : undefined);
const num = (e: NumExpr) => evaluateValue(e, v).toString();
const cond = (e: BoolExpr) => evaluateCondition(e, v);

describe('evaluation is exact (no floating point)', () => {
  it('line, const, add, sub, neg', () => {
    expect(num({ add: [{ line: 'A' }, { line: 'B' }] })).toBe('0.3');                                         // 0.1 + 0.2 is exactly 0.3
    expect(num({ sub: [{ line: 'C' }, { add: [{ line: 'A' }, { line: 'B' }] }] })).toBe('0');
    expect(num({ neg: { line: 'NEG' } })).toBe('5');
    expect(num({ const: '-0.0001' })).toBe('-0.0001');
    expect(num({ add: [{ line: 'BIG' }, { const: '0.0001' }] })).toBe('123456789012345.679');
  });
  it('comparisons with and without tolerance, and/or', () => {
    expect(cond({ eq: [{ add: [{ line: 'A' }, { line: 'B' }] }, { line: 'C' }] })).toBe(true);
    expect(cond({ eq: [{ line: 'A' }, { const: '0.11' }] })).toBe(false);
    expect(cond({ eq: [{ line: 'A' }, { const: '0.11' }], tolerance: '0.01' })).toBe(true);
    expect(cond({ eq: [{ line: 'A' }, { const: '0.111' }], tolerance: '0.01' })).toBe(false);
    expect(cond({ ge: [{ line: 'A' }, { line: 'A' }] })).toBe(true);
    expect(cond({ gt: [{ line: 'A' }, { line: 'A' }] })).toBe(false);
    expect(cond({ gt: [{ line: 'A' }, { line: 'A' }], tolerance: '0.001' })).toBe(true);
    expect(cond({ le: [{ line: 'B' }, { line: 'A' }] })).toBe(false);
    expect(cond({ le: [{ line: 'B' }, { line: 'A' }], tolerance: '0.1' })).toBe(true);
    expect(cond({ lt: [{ line: 'NEG' }, { const: '0' }] })).toBe(true);
    expect(cond({ and: [{ lt: [{ line: 'NEG' }, { const: '0' }] }, { gt: [{ line: 'A' }, { const: '1' }] }] })).toBe(false);
    expect(cond({ or: [{ lt: [{ line: 'NEG' }, { const: '0' }] }, { gt: [{ line: 'A' }, { const: '1' }] }] })).toBe(true);
  });
  it('a line without a value, or a construct outside the grammar, is an evaluation error (never code)', () => {
    expect(() => cond({ eq: [{ line: 'MISSING' }, { const: '0' }] })).toThrow(ExpressionError);
    expect(() => cond({ mul: [] } as unknown as BoolExpr)).toThrow(/unknown construct mul/);
    expect(() => num({ fn: 'process.exit()' } as unknown as NumExpr)).toThrow(/unknown construct fn/);
  });
});

describe('the grammar is checked when a rule is written', () => {
  const keys = new Set(['A', 'B', 'C']);
  it('accepts every construct', () => {
    expect(checkExpression({ and: [{ eq: [{ add: [{ line: 'A' }, { neg: { line: 'B' } }] }, { sub: [{ line: 'C' }, { const: '1.5' }] }], tolerance: '0.01' }, { or: [{ ge: [{ line: 'A' }, { const: '0' }] }, { lt: [{ line: 'B' }, { const: '-1' }] }] }] }, keys)).toEqual([]);
  });
  it.each([
    [{ line: 'A' }, 'a value is not a condition'],
    [{ const: '1' }, 'a value is not a condition'],
    [{ mul: [{ line: 'A' }, { line: 'B' }] }, 'unknown construct mul'],
    [{ eq: [{ line: 'A' }] }, 'exactly two values'],
    [{ eq: [{ line: 'A' }, { line: 'Z' }] }, 'Z is not a line of this version'],
    [{ eq: [{ line: 'A' }, { const: 1 }] }, 'a decimal string'],
    [{ eq: [{ line: 'A' }, { const: '1e3' }] }, 'a decimal string'],
    [{ eq: [{ line: 'A' }, { const: '0.00001' }] }, 'a decimal string'],                                   // beyond ledger scale
    [{ eq: [{ line: 'A' }, { line: 'B' }], tolerance: '-0.01' }, 'non-negative'],
    [{ eq: [{ line: 'A' }, { line: 'B' }], extra: 1 }, 'unknown construct extra'],
    [{ and: [] }, 'a list of 1 to 100 conditions'],
    [{ and: [{ line: 'A' }] }, 'a value is not a condition'],
    [{ eq: [{ sub: [{ line: 'A' }] }, { line: 'B' }] }, 'exactly two values'],
    [{ eq: [{ line: 'A', const: '1' }, { line: 'B' }] }, 'exactly one of'],
    [{ eq: [{ line: 'a lower key' }, { line: 'B' }] }, 'a line key'],
    ['eq', 'a condition must be an object'],
    [[{ line: 'A' }], 'a condition must be an object'],
  ])('refuses %j (%s)', (expr, why) => {
    const problems = checkExpression(expr, keys);
    expect(problems.join(' | ')).toContain(why);
  });
  it('refuses unbounded depth and size', () => {
    let deep: NumExpr = { line: 'A' };
    for (let i = 0; i < 40; i++) deep = { neg: deep };
    expect(checkExpression({ eq: [deep, { const: '0' }] }, keys).join()).toContain('nested deeper than 32');
    expect(checkExpression({ eq: [{ add: Array.from({ length: 100 }, () => ({ add: Array.from({ length: 10 }, () => ({ line: 'A' })) })) }, { const: '0' }] }, keys).join()).toContain('more than 500 nodes');
  });
  it('lists the lines an expression refers to', () => {
    expect([...expressionLines({ and: [{ eq: [{ line: 'A' }, { add: [{ line: 'B' }, { line: 'A' }] }] }] })].sort()).toEqual(['A', 'B']);
  });
});

describe('line shapes and version consistency (DEC-055)', () => {
  const L = (key: string, o: Partial<{ statement: string; parentKey: string | null; kind: string; naturalSide: string | null; formula: unknown }> = {}) =>
    ({ id: key, organisationId: 'o', versionId: 'v', key, statement: 'BS', parentKey: null, sort: 0, name: key, kind: 'ACCOUNTS', naturalSide: 'DEBIT', formula: null, removed: false, updatedAt: new Date(), ...o }) as never;
  it('a total has a formula and no side; other lines a side and no formula; nothing refers to itself', () => {
    expect(lineShapeErrors({ key: 'T', kind: 'TOTAL', formula: [{ line: 'A', sign: 1 }] })).toEqual([]);
    expect(lineShapeErrors({ key: 'T', kind: 'TOTAL', naturalSide: 'DEBIT' })).toEqual(['A TOTAL line needs a formula', 'A TOTAL line has no natural side']);
    expect(lineShapeErrors({ key: 'A', kind: 'ACCOUNTS', formula: [{ line: 'B', sign: 1 }] })).toEqual(['Only a TOTAL line has a formula', 'An accounts or retained-profit line needs its natural side']);
    expect(lineShapeErrors({ key: 'T', kind: 'TOTAL', formula: [{ line: 'T', sign: 1 }], parentKey: 'T' })).toEqual(['A total cannot include itself', 'A line cannot be its own parent']);
  });
  it('finds cycles in totals and parents, missing references, parents on another statement, map targets that are not accounts lines', () => {
    const lines = [
      L('A'), L('T1', { kind: 'TOTAL', naturalSide: null, formula: [{ line: 'T2', sign: 1 }] }), L('T2', { kind: 'TOTAL', naturalSide: null, formula: [{ line: 'T1', sign: -1 }, { line: 'GONE', sign: 1 }] }),
      L('P1', { parentKey: 'P2' }), L('P2', { parentKey: 'P1' }), L('X', { parentKey: 'Y' }), L('Q', { parentKey: 'A', statement: 'PL' }),
    ];
    const problems = versionProblems({ lines, map: [{ sourceLine: 'BS.CURRENT_ASSETS.CASH', accountSubtype: null, targetKey: 'T1' }] as never, rules: [{ key: 'R', expression: { eq: [{ line: 'NOPE' }, { const: '0' }] } }] as never,
      notes: [{ key: 'N', requires: { lines: ['MISSING'] } }] as never, overrideTargets: ['T2'] });
    expect(problems).toEqual(expect.arrayContaining([
      'Line T2: total refers to GONE, not a line of this version', 'Line X: parent Y is not a line of this version', 'Line Q: parent A is on another statement',
      'Map BS.CURRENT_ASSETS.CASH: T1 is not an accounts line of this version', 'An account override targets T2, not an accounts line of this version',
      'Rule R: $.eq[0].line: NOPE is not a line of this version', 'Disclosure N: MISSING is not a line of this version',
    ]));
    expect(problems.find((p) => p.startsWith('Totals form a cycle'))).toMatch(/T1 -> T2 -> T1/);
    expect(problems.find((p) => p.startsWith('Parents form a cycle'))).toMatch(/P1 -> P2 -> P1/);
    expect(versionProblems({ lines: [], map: [], rules: [], notes: [] })).toEqual(['The version has no statement lines']);
  });
});
