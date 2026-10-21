import { describe, expect, it } from 'vitest';
import { accountsFingerprint } from '@uk/accounting';
import { approvalDateProblems, canonicalJson, clientApprovalSchema, packageProblems } from '@uk/contracts';

/** V2-M6c (DEC-070): the fingerprint of the accounts, the approval date rule and the package gate (V2-ARC-04). */
describe('the fingerprint', () => {
  it('canonical JSON sorts keys at every level and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: null } })).toBe('{"a":{"c":null,"d":[2,1]},"b":1}');
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
    expect(canonicalJson([undefined, 'x'])).toBe('[null,"x"]');
  });
  it('is the same for the same document in any key order, changes with any figure or word, ignores the notices, and is null while incomplete', () => {
    const doc = { complete: true, verified: true, statements: { balanceSheet: [{ key: 'B.CW', amount: '6400.00' }] }, sections: [{ section: 'NOTES', items: [{ key: 'NOTE.EMP', blocks: [{ type: 'text', text: 'The average number of employees during the year was 1.' }] }] }], notices: ['a'] };
    const reordered = { notices: ['b'], sections: doc.sections, statements: doc.statements, verified: true, complete: true };
    const f = accountsFingerprint(doc)!;
    expect(f).toMatch(/^[0-9a-f]{64}$/);
    expect(accountsFingerprint(reordered)).toBe(f);
    expect(accountsFingerprint({ ...doc, statements: { balanceSheet: [{ key: 'B.CW', amount: '6400.01' }] } })).not.toBe(f);
    expect(accountsFingerprint({ ...doc, sections: [{ section: 'NOTES', items: [{ key: 'NOTE.EMP', blocks: [{ type: 'text', text: 'The average number of employees during the year was 2.' }] }] }] })).not.toBe(f);
    expect(accountsFingerprint({ ...doc, complete: false })).toBeNull();
  });
});

describe('the approval date (DEC-070)', () => {
  it('is after the year end and not in the future', () => {
    const base = { yearEnd: '2025-12-31', today: '2026-10-21' };
    expect(approvalDateProblems({ ...base, approvedOn: '2026-03-16' })).toEqual([]);
    expect(approvalDateProblems({ ...base, approvedOn: '2026-10-21' })).toEqual([]);
    expect(approvalDateProblems({ ...base, approvedOn: '2025-12-31' })).toHaveLength(1);
    expect(approvalDateProblems({ ...base, approvedOn: '2026-10-22' })).toHaveLength(1);
  });
  it('the request names the director, the date and the evidence', () => {
    const ok = { yearStart: '2025-01-01', directorContactId: '11111111-1111-4111-8111-111111111111', approvedOn: '2026-03-16', evidenceDocumentId: '22222222-2222-4222-8222-222222222222' };
    expect(clientApprovalSchema.safeParse(ok).success).toBe(true);
    for (const k of ['directorContactId', 'approvedOn', 'evidenceDocumentId'] as const) { const { [k]: _, ...rest } = ok; expect(clientApprovalSchema.safeParse(rest).success, k).toBe(false); }
    expect(clientApprovalSchema.safeParse({ ...ok, approvedOn: '2026-02-30' }).success).toBe(false);
  });
});

describe('the package gate (DEC-070, V2-ARC-04)', () => {
  const ready = { approved: true, fingerprint: 'b', approvedFingerprint: 'b', documentComplete: true, versionVerified: true, thresholdSetsVerified: true, sizeFits: true };
  it('passes only when approved, unchanged and every rule verified', () => {
    expect(packageProblems(ready)).toEqual([]);
  });
  it('names each reason it refuses, on every combination', () => {
    const flips = { approved: false, fingerprint: 'a', documentComplete: false, versionVerified: false, thresholdSetsVerified: false, sizeFits: null } as const;
    const keys = Object.keys(flips) as (keyof typeof flips)[];
    for (let mask = 1; mask < 1 << keys.length; mask++) {
      const input = { ...ready } as Record<string, unknown>;
      keys.forEach((k, i) => { if (mask & (1 << i)) input[k] = flips[k]; });
      const problems = packageProblems(input as typeof ready);
      expect(problems.length, `mask ${mask}`).toBeGreaterThan(0);
      // the version, the thresholds and the size are refused on their own; an unapproved year is not also called changed
      expect(problems.some((p) => p.includes('standard version')), `mask ${mask}`).toBe(input.versionVerified === false);
      expect(problems.some((p) => p.includes('threshold set')), `mask ${mask}`).toBe(input.thresholdSetsVerified === false);
      expect(problems.some((p) => p.includes('changed since')), `mask ${mask}`).toBe(input.approved === true && input.fingerprint !== 'b');
    }
  });
});
