import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';

/** V1-M8 through the public API: statements, drill-down and alerts for readers; who may see what; the new close control. Synthetic data. */
let s: Stack;
let owner: TestUser, accountant: TestUser, reviewer: TestUser, viewer: TestUser, outsider: TestUser;
let company: { id: string };
const acc: Record<string, string> = {};
const c = (p = '') => `/companies/${company.id}${p}`;
const as = (u: TestUser, m: 'get' | 'post', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'Reports Client');
  accountant = await addMember(s, owner, 'accountant');
  reviewer = await addMember(s, owner, 'reviewer');
  viewer = await addMember(s, owner, 'client_viewer');
  outsider = await createUser(s, { type: 'PRACTICE' });
  await as(owner, 'post', c('/periods'), { startDate: '2026-01-01', endDate: '2026-12-31' });
  for (const a of (await as(owner, 'post', c('/accounts/initialise'))).body.items) acc[a.code] = a.id;
});
afterAll(() => s.stop());

describe('reports through the API (M8)', () => {
  let journalId: string;
  it('a cash sale shows in the P&L and the balance sheet; both reconcile; readers may read, client viewers and outsiders may not', async () => {
    const r = await as(accountant, 'post', c('/cash-transactions'), { direction: 'RECEIPT', transactionDate: '2026-03-02', bankAccountId: acc['1200'], description: 'Consultancy paid in', lines: [{ description: 'Fee', accountId: acc['4000'], amount: '500.00' }] });
    expect(r.status).toBe(201);
    journalId = r.body.journalId;
    const pl = await as(reviewer, 'get', `${c('/reports/profit-and-loss')}?from=2026-01-01&to=2026-12-31`);
    expect(pl.status).toBe(200);
    expect(pl.body).toMatchObject({ profitForPeriod: '500.00', reconciliation: { reconciled: true } });
    const bs = await as(reviewer, 'get', `${c('/reports/balance-sheet')}?asOf=2026-12-31`);
    expect(bs.body).toMatchObject({ netAssets: '500.00', reconciliation: { balanced: true }, financialYearStart: '2026-01-01' });
    expect((await as(viewer, 'get', `${c('/reports/profit-and-loss')}?from=2026-01-01&to=2026-12-31`)).status).toBe(403);
    expect((await s.api().get(orgPath(owner, `${c('/reports/balance-sheet')}?asOf=2026-12-31`)).set(bearer(outsider.token))).status).toBe(404);
    expect((await as(reviewer, 'get', `${c('/reports/profit-and-loss')}?from=2026-12-31&to=2026-01-01`)).status).toBe(422);
    expect((await as(reviewer, 'get', `${c('/reports/profit-and-loss')}?from=2026-01-01&to=2026-12-31&compareFrom=2025-01-01`)).status).toBe(422);
  });
  it('drill-down from the journal reaches the cash transaction; the FX report and the alert list answer', async () => {
    const d = await as(reviewer, 'get', c(`/journals/${journalId}/source`));
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ journal: { sourceType: 'CASH_RECEIPT' }, source: { entityType: 'cash_transaction', direction: 'RECEIPT', gross: '500.00' } });
    expect((await as(reviewer, 'get', `${c('/reports/fx')}?from=2026-01-01&to=2026-12-31`)).body).toMatchObject({ realised: { total: '0.00' }, unrealised: { total: '0.00' }, openBalances: [] });
    const a = await as(reviewer, 'get', `${c('/alerts')}?asOf=2026-12-31&draftDays=7`);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ thresholds: { draftDays: 7, unmatchedDays: 30 }, count: 0, alerts: [] });
    expect((await as(viewer, 'get', c('/alerts'))).status).toBe(403);
  });
  it('closing a period takes the new acknowledgement fields; unknown fields are refused', async () => {
    const period = (await as(owner, 'get', c('/periods'))).body.items[0].id;
    expect((await as(accountant, 'post', c(`/periods/${period}/close`), { acknowledgeUnreconciledBank: true, surprise: true })).status).toBe(422);
    const closed = await as(accountant, 'post', c(`/periods/${period}/close`), { acknowledgeUnreconciledBank: true, acknowledgeUnrevaluedFx: true });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(closed.body.status).toBe('CLOSED');
  });
});
