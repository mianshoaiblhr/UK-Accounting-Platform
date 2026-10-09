import { describe, expect, it } from 'vitest';
import { runWithContext } from '@uk/core';
import { auditRow, changeSet } from './audit';

describe('changeSet', () => {
  it('keeps only the fields that changed, with old and new values', () => {
    const r = changeSet({ name: 'A', status: 'ACTIVE', n: 1 }, { name: 'B', status: 'ACTIVE', n: 1 }, ['name', 'status', 'n']);
    expect(r).toEqual({ before: { name: 'A' }, after: { name: 'B' } });
  });
  it('compares dates by instant and treats equal values as unchanged', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    expect(changeSet({ d }, { d: new Date(d) }, ['d'])).toEqual({ before: {}, after: {} });
  });
});

describe('auditRow', () => {
  it('redacts secrets inside before/after/metadata', () => {
    const row = auditRow({ action: 'x', before: { password: 'p', nested: { apiKey: 'k', token: 't' }, ok: 1 }, after: { secret: 's' }, metadata: { recoveryCode: 'r' } });
    expect(JSON.stringify(row)).not.toMatch(/"p"|"t"|"s"|"r"/);
    expect((row.before as Record<string, unknown>).ok).toBe(1);
    expect(JSON.stringify(row.before)).toContain('[REDACTED]');
  });
  it('replaces oversized snapshots with a marker instead of storing an unbounded blob', () => {
    const big = { blob: 'x'.repeat(40_000), other: 1 };
    const row = auditRow({ action: 'x', after: big });
    expect(row.after).toMatchObject({ _truncated: true, fields: ['blob', 'other'] });
  });
  it('bounds the reason and records the company and source workflow', () => {
    const row = auditRow({ action: 'x', reason: 'r'.repeat(5000), companyId: 'c', sourceWorkflowId: 'w' });
    expect(row.reason).toHaveLength(1000);
    expect(row).toMatchObject({ companyId: 'c', sourceWorkflowId: 'w' });
  });
  it('device metadata (IP, user agent) is captured by default and dropped when disabled; actor and correlation always kept', () => {
    runWithContext({ correlationId: 'corr-1', userId: 'u1', ip: '203.0.113.9', userAgent: 'UA/1' }, () => {
      expect(auditRow({ action: 'x' })).toMatchObject({ ip: '203.0.113.9', userAgent: 'UA/1', actorUserId: 'u1', correlationId: 'corr-1' });
      const min = auditRow({ action: 'x' }, false);
      expect(min.ip).toBeUndefined();
      expect(min.userAgent).toBeUndefined();
      expect(min).toMatchObject({ actorUserId: 'u1', correlationId: 'corr-1' });
    });
  });
});
