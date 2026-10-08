import { describe, expect, it } from 'vitest';
import { ALL_JOB_DEFINITIONS, PERMISSIONS, QUEUES, SYSTEM_ROLES, createCompanySchema, createPeriodSchema, inviteMemberSchema, registerSchema } from './index';

describe('permission catalogue', () => {
  it('system roles only use catalogued permissions', () => {
    for (const r of SYSTEM_ROLES) for (const p of r.permissions) expect(PERMISSIONS).toContain(p);
  });
  it('owner holds everything; client viewer cannot write', () => {
    expect(SYSTEM_ROLES.find((r) => r.key === 'owner')!.permissions).toHaveLength(PERMISSIONS.length);
    const v = SYSTEM_ROLES.find((r) => r.key === 'client_viewer')!.permissions;
    expect(v.some((p) => /create|upload|manage|invite|update|archive/.test(p))).toBe(false);
  });
});

describe('job definitions', () => {
  it('every definition targets a declared queue with a sane retry policy', () => {
    for (const d of ALL_JOB_DEFINITIONS) {
      expect(QUEUES).toContain(d.queue);
      expect(d.retry.attempts).toBeGreaterThan(0);
      expect(d.retry.backoffMs).toBeGreaterThan(0);
    }
    expect(new Set(ALL_JOB_DEFINITIONS.map((d) => d.type)).size).toBe(ALL_JOB_DEFINITIONS.length);
  });
  it('declares a queue for every V0 workload class', () => {
    for (const q of ['documents', 'imports', 'exports', 'ai', 'reconciliation', 'notifications', 'reports', 'integrations', 'scheduled']) expect(QUEUES).toContain(q);
  });
});

describe('request schemas', () => {
  it('rejects unknown fields (mass-assignment guard)', () => {
    expect(createCompanySchema.safeParse({ name: 'X', organisationId: 'evil' }).success).toBe(false);
  });
  it('normalises email', () => {
    const r = registerSchema.parse({ email: ' A@B.Co ', password: 'a-very-long-passphrase', displayName: 'A', organisationName: 'O', organisationType: 'BUSINESS' });
    expect(r.email).toBe('a@b.co');
  });
  it('validates period ordering and invite payload', () => {
    expect(createPeriodSchema.safeParse({ startDate: '2025-04-01', endDate: '2025-03-31' }).success).toBe(false);
    expect(createPeriodSchema.safeParse({ startDate: '2025-04-01', endDate: '2026-03-31' }).success).toBe(true);
    expect(inviteMemberSchema.safeParse({ email: 'x@y.zz', roleId: 'nope' }).success).toBe(false);
  });
});
