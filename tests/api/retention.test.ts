import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RETENTION_CATEGORIES } from '@uk/contracts';
import { addMember, bearer, createUser, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

let s: Stack;
let owner: TestUser, viewer: TestUser, outsider: TestUser;
beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  viewer = await addMember(s, owner, 'client_viewer');
  outsider = await createUser(s);
});
afterAll(() => s.stop());

describe('GET /reference/retention-categories', () => {
  it('lists the classification with provisional periods and the document types in each category; read-only', async () => {
    const r = await s.api().get(orgPath(owner, '/reference/retention-categories')).set(bearer(viewer.token)); // any member
    expect(r.status).toBe(200);
    expect(r.body.items.map((c: { code: string }) => c.code)).toEqual(RETENTION_CATEGORIES.map((c) => c.code).sort());
    const acc = r.body.items.find((c: { code: string }) => c.code === 'ACCOUNTING_RECORDS');
    expect(acc).toMatchObject({ kind: 'PERIOD', years: 6, days: null, trigger: 'ACCOUNTING_PERIOD_END', status: 'PROVISIONAL' });
    expect(acc.documentTypes).toEqual(expect.arrayContaining(['BANK_STATEMENT', 'SALES_INVOICE', 'VAT_WORKING']));
    expect(acc.basis).toMatch(/Companies Act 2006/);
    expect(r.body.items.every((c: { status: string }) => c.status === 'PROVISIONAL')).toBe(true);
    // table names are internal: the API exposes document types only
    expect(JSON.stringify(r.body)).not.toMatch(/audit_event|job_record/);
    for (const m of ['post', 'put', 'patch', 'delete'] as const) expect((await s.api()[m](orgPath(owner, '/reference/retention-categories')).set(bearer(owner.token)).send({})).status).toBeGreaterThanOrEqual(404);
  });
  it('is organisation-scoped like the other reference endpoints', async () => {
    expect((await s.api().get(orgPath(owner, '/reference/retention-categories')).set(bearer(outsider.token))).status).toBeGreaterThanOrEqual(403);
    expect((await s.api().get(orgPath(owner, '/reference/retention-categories'))).status).toBe(401);
  });
});
