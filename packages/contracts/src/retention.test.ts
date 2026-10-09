import { describe, expect, it } from 'vitest';
import { DOCUMENT_TYPES, EVIDENCE_DEFAULT_RETENTION_YEARS } from './documents';
import { RETENTION_CATEGORIES, RETENTION_RULES, retainUntil, retentionCategoryFor } from './retention';

const cat = (code: string) => RETENTION_CATEGORIES.find((c) => c.code === code)!;

describe('retention registry (ADR-39)', () => {
  it('category codes are unique and every rule points at a real category', () => {
    expect(new Set(RETENTION_CATEGORIES.map((c) => c.code)).size).toBe(RETENTION_CATEGORIES.length);
    for (const r of RETENTION_RULES) expect(RETENTION_CATEGORIES.some((c) => c.code === r.category), `${r.kind} ${r.subject}`).toBe(true);
  });
  it('a subject is classified exactly once', () => {
    const keys = RETENTION_RULES.map((r) => `${r.kind}:${r.subject}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('every document type is classified, and no unknown document type is', () => {
    expect(RETENTION_RULES.filter((r) => r.kind === 'DOCUMENT_TYPE').map((r) => r.subject).sort()).toEqual(DOCUMENT_TYPES.map((t) => t.code).sort());
  });
  it('periods are well-formed: a PERIOD has exactly one positive unit and a trigger; the other kinds have none', () => {
    for (const c of RETENTION_CATEGORIES) {
      if (c.kind === 'PERIOD') {
        expect([c.years, c.days].filter((x) => x !== null), c.code).toHaveLength(1);
        expect((c.years ?? c.days)!, c.code).toBeGreaterThan(0);
        expect(c.trigger, c.code).not.toBe('NOT_APPLICABLE');
      } else {
        expect([c.years, c.days, c.trigger], c.code).toEqual([null, null, 'NOT_APPLICABLE']);
      }
      expect(c.basis.length, c.code).toBeGreaterThan(20);
    }
  });
  it('is honest about its status: nothing is CONFIRMED until the DPO/legal decision is recorded', () => {
    expect(RETENTION_CATEGORIES.filter((c) => c.status !== 'PROVISIONAL').map((c) => c.code)).toEqual([]);
  });
  it('agrees with the rules the platform already applies', () => {
    expect(cat('FILING_EVIDENCE').years).toBe(EVIDENCE_DEFAULT_RETENTION_YEARS);
    expect(retentionCategoryFor('DOCUMENT_TYPE', 'FILING_EVIDENCE')?.code).toBe('FILING_EVIDENCE');
    expect(retentionCategoryFor('TABLE', 'audit_event')?.code).toBe('AUDIT_TRAIL');
    expect(retentionCategoryFor('TABLE', 'nope')).toBeUndefined();
  });
});

describe('retainUntil', () => {
  const d = (s: string) => new Date(s);
  it('adds whole years in UTC', () => expect(retainUntil(cat('ACCOUNTING_RECORDS'), d('2025-03-31T00:00:00Z'))?.toISOString()).toBe('2031-03-31T00:00:00.000Z'));
  it('29 February lands on 28 February in a non-leap target year, and stays on 29 February in a leap one', () => {
    expect(retainUntil(cat('IDENTITY_VERIFICATION'), d('2024-02-29T10:00:00Z'))?.toISOString()).toBe('2029-02-28T10:00:00.000Z');
    expect(retainUntil(cat('CORPORATE_RECORDS'), d('2024-02-29T10:00:00Z'))?.toISOString()).toBe('2034-02-28T10:00:00.000Z');
    expect(retainUntil({ ...cat('ACCOUNTING_RECORDS'), years: 4 }, d('2024-02-29T10:00:00Z'))?.toISOString()).toBe('2028-02-29T10:00:00.000Z');
  });
  it('adds days for day-based periods', () => expect(retainUntil(cat('OPERATIONAL_JOBS'), d('2026-01-01T00:00:00Z'))?.toISOString()).toBe('2026-04-01T00:00:00.000Z'));
  it('has no date for categories without a fixed period', () => {
    expect(retainUntil(cat('WHILE_ACTIVE'), new Date())).toBeNull();
    expect(retainUntil(cat('REFERENCE_DATA'), new Date())).toBeNull();
  });
});
