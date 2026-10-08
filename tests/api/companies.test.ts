import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

let s: Stack;
let u: TestUser;
beforeAll(async () => { s = await startStack(); u = await createUser(s); });
afterAll(() => s.stop());

describe('companies', () => {
  it('creates, reads, renames and lists with cursor pagination', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await makeCompany(s, u, `Pager ${i} Ltd`)).id);
    const p1 = await s.api().get(orgPath(u, '/companies?limit=2')).set(bearer(u.token));
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await s.api().get(orgPath(u, `/companies?limit=2&cursor=${p1.body.nextCursor}`)).set(bearer(u.token));
    expect(p2.body.items.length).toBeGreaterThanOrEqual(1);
    const seen = new Set([...p1.body.items, ...p2.body.items].map((c: { id: string }) => c.id));
    expect(seen.size).toBe(p1.body.items.length + p2.body.items.length);
    const ren = await s.api().patch(orgPath(u, `/companies/${ids[0]}`)).set(bearer(u.token)).send({ name: 'Renamed Ltd' });
    expect(ren.body.name).toBe('Renamed Ltd');
  });
  it('rejects duplicate company numbers inside an organisation but allows them across organisations', async () => {
    await makeCompany(s, u, 'Dup One', 'DUPE0001');
    const dup = await s.api().post(orgPath(u, '/companies')).set(bearer(u.token)).send({ name: 'Dup Two', companyNumber: 'dupe0001' });
    expect(dup.status).toBe(409);
    const other = await createUser(s);
    expect(await makeCompany(s, other, 'Same Number', 'DUPE0001')).toBeTruthy();
  });
  it('validates input strictly (422, field errors, unknown fields refused)', async () => {
    const r = await s.api().post(orgPath(u, '/companies')).set(bearer(u.token)).send({ name: '', companyNumber: '123' });
    expect(r.status).toBe(422);
    expect(r.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(['companyNumber', 'name']);
    const mass = await s.api().post(orgPath(u, '/companies')).set(bearer(u.token)).send({ name: 'x', organisationId: '11111111-1111-4111-8111-111111111111' });
    expect(mass.status).toBe(422);
  });
  it('Idempotency-Key prevents duplicate creation on client retry', async () => {
    const key = `co-${Math.random()}`;
    const a = await s.api().post(orgPath(u, '/companies')).set(bearer(u.token)).set('Idempotency-Key', key).send({ name: 'Idem Co' });
    const b = await s.api().post(orgPath(u, '/companies')).set(bearer(u.token)).set('Idempotency-Key', key).send({ name: 'Idem Co' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    const list = await s.api().get(orgPath(u, '/companies?limit=100')).set(bearer(u.token));
    expect(list.body.items.filter((c: { name: string }) => c.name === 'Idem Co')).toHaveLength(1);
  });
});

describe('accounting periods (shell only — no accounting semantics in V0)', () => {
  it('creates ordered periods and rejects overlaps and inverted ranges', async () => {
    const co = await makeCompany(s, u);
    const mk = (startDate: string, endDate: string) => s.api().post(orgPath(u, `/companies/${co.id}/periods`)).set(bearer(u.token)).send({ startDate, endDate });
    const p1 = await mk('2024-04-01', '2025-03-31');
    expect(p1.status).toBe(201);
    expect(p1.body.status).toBe('OPEN');
    expect((await mk('2025-04-01', '2026-03-31')).status).toBe(201);
    const overlap = await mk('2025-01-01', '2025-06-30');
    expect(overlap.status).toBe(409);
    expect(overlap.body.code).toBe('period_overlap');
    expect((await mk('2027-04-01', '2027-03-31')).status).toBe(422);
    const list = await s.api().get(orgPath(u, `/companies/${co.id}/periods`)).set(bearer(u.token));
    expect(list.body.items.map((p: { startDate: string }) => p.startDate.slice(0, 10))).toEqual(['2024-04-01', '2025-04-01']);
  });
  it('different companies may use identical period dates', async () => {
    const [c1, c2] = [await makeCompany(s, u), await makeCompany(s, u)];
    for (const c of [c1, c2]) {
      const r = await s.api().post(orgPath(u, `/companies/${c.id}/periods`)).set(bearer(u.token)).send({ startDate: '2030-01-01', endDate: '2030-12-31' });
      expect(r.status).toBe(201);
    }
  });
});

describe('organisation audit trail', () => {
  it('records who did what, in order, with correlation ids', async () => {
    const co = await makeCompany(s, u, 'Audited Ltd');
    const audit = await s.api().get(orgPath(u, '/audit-events?entityType=company')).set(bearer(u.token));
    const ev = audit.body.items.find((e: { entityId: string }) => e.entityId === co.id);
    expect(ev).toMatchObject({ action: 'company.created', actorUserId: u.userId, outcome: 'SUCCESS', organisationId: u.organisationId });
    expect(ev.correlationId).toBeTruthy();
    expect(ev.ip).toBeTruthy();
  });
});
