import { describe, expect, it } from 'vitest';
import { conceptEntrySchema, mappingProblems } from './ixbrl';

describe('the concept map (V3-M1, DEC-093)', () => {
  const ns = { namespaces: { core: 'https://example.invalid/core' } };
  const entry = (o: object) => conceptEntrySchema.parse({ sourceKind: 'LINE', sourceKey: 'P.T', concept: 'core:Turnover', dataType: 'MONETARY', periodType: 'DURATION', decimals: 2, ...o });
  it('a version must map something, with declared prefixes and company details the platform knows', () => {
    expect(mappingProblems(ns, [])).toEqual(['the version maps nothing']);
    expect(mappingProblems(ns, [entry({})])).toEqual([]);
    expect(mappingProblems(ns, [entry({ dimensions: [{ axis: 'dim:Axis', member: 'core:Member' }] })])).toEqual(['LINE P.T: the prefix of dim:Axis is not declared']);
    expect(mappingProblems(ns, [entry({ sourceKind: 'COMPANY', sourceKey: 'company.vat', dataType: 'TEXT', decimals: null })])).toEqual(['COMPANY company.vat: not a company detail the platform knows (company.name, company.number, period.start, period.end, balanceSheetDate, directors, approval.director, approval.date)']);
  });
  it('the request refuses money without decimals, and decimals or a sign rule on anything else', () => {
    expect(conceptEntrySchema.safeParse({ sourceKind: 'LINE', sourceKey: 'P.T', concept: 'core:Turnover', dataType: 'MONETARY', periodType: 'DURATION' }).success).toBe(false);
    expect(conceptEntrySchema.safeParse({ sourceKind: 'COMPANY', sourceKey: 'company.name', concept: 'core:Name', dataType: 'TEXT', periodType: 'DURATION', negate: true }).success).toBe(false);
    expect(conceptEntrySchema.safeParse({ sourceKind: 'LINE', sourceKey: 'P.T', concept: 'Turnover', dataType: 'MONETARY', periodType: 'DURATION', decimals: 0 }).success).toBe(false);
  });
});
