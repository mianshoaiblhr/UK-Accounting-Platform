import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildCtIxbrl, type CtIxbrlInput } from './ct-return';

/** V4-M5 (DEC-102): the computation's inline XBRL builder: pure, deterministic, and checked. The concepts are synthetic fixtures. */
const entry = (sourceKey: string, concept: string, o: Partial<CtIxbrlInput['taxonomy']['entries'][number]> = {}) => ({
  id: sourceKey, sourceKind: 'FACT', sourceKey, concept, dataType: 'MONETARY', periodType: 'DURATION', negate: false, decimals: 2, dimensions: [], mandatory: true, ...o,
});
const input = (o: Partial<CtIxbrlInput> = {}): CtIxbrlInput => ({
  taxonomy: { entryPoint: 'https://example.invalid/ct.xsd', entityScheme: 'https://example.invalid/utr', namespaces: { ct: 'https://example.invalid/ct' },
    entries: [entry('ct.taxableTotalProfits', 'ct:TTP'), entry('ct.fy1.profit', 'ct:FyProfit'), entry('ct.fy2.profit', 'ct:FyProfit'), entry('ct.losses.carriedForward', 'ct:LossesCf', { mandatory: false })] },
  company: { name: 'Synthetic & Co Ltd', utr: '1234567890' }, currency: 'GBP', period: { start: '2027-01-01', end: '2027-12-31' },
  fyParts: [{ from: '2027-01-01', to: '2027-03-31' }, { from: '2027-04-01', to: '2027-12-31' }],
  values: { taxableTotalProfits: '120000.00', 'fy1.profit': '29589.04', 'fy2.profit': '90410.96', 'losses.carriedForward': '0.00' },
  ...o,
});

describe('the computation as inline XBRL (V4-M5, DEC-102)', () => {
  it('tags each value in its context (the period or its financial-year part), well-formed and deterministic', () => {
    const a = buildCtIxbrl(input()), b = buildCtIxbrl(input());
    expect(a.errors).toEqual([]);
    expect(a.sha256).toBe(b.sha256);
    expect(a).toMatchObject({ factCount: 4, contextCount: 3 });
    expect(a.content).toContain('<xbrli:startDate>2027-04-01</xbrli:startDate><xbrli:endDate>2027-12-31</xbrli:endDate>');
    expect(a.content).toContain('>90,410.96</ix:nonFraction>');
    expect(a.content).toContain('Synthetic &amp; Co Ltd');
    execFileSync('xmllint', ['--noout', '-'], { input: a.content });
  });
  it('refuses unknown keys, missing mandatory values, a missing UTR or scheme, and a reserved prefix', () => {
    const r = buildCtIxbrl(input({ company: { name: 'X', utr: null }, fyParts: [{ from: '2027-04-01', to: '2028-03-31' }],
      taxonomy: { entryPoint: 'e', entityScheme: null, namespaces: { ix: 'https://example.invalid/clash' }, entries: [entry('ct.notAField', 'ct:X'), entry('ct.fy2.profit', 'ct:FyProfit')] } }));
    expect(r.errors).toEqual([
      'The taxonomy version declares the prefix "ix", which the inline XBRL specification uses', 'The company has no UTR: the entity identifier needs it',
      'The taxonomy version has no entity identifier scheme', 'FACT ct.notAField is not a key of the computation (ct.<field>)', 'The mandatory ct.fy2.profit (ct:FyProfit) has no value',
    ]);
  });
});
