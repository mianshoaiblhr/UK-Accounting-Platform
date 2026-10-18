import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';
import { adminSql } from '../helpers/db';

/** V2-M3a through the public API (v2-plan 5.3): the golden year-end adjustments (DEC-054) to the cent, cancellations and refusals, permissions and tenancy. Synthetic data. */
type Lines = [string, string, string][];
const G = JSON.parse(readFileSync(resolve(__dirname, '../golden/v2-m3a-adjustments.json'), 'utf8')) as {
  periods: [string, string][]; accounts: Record<string, string>[]; seed: { ref: string; date: string; direction: string; lines: [string, string][]; description: string }[];
  items: (Record<string, any> & { key: string; expect?: { journal: Lines; reversal?: { date: string; journal: Lines } } })[];
  provision: { name: string; account: string; expenseAccount: string; basis: string; movements: { kind: string; date: string; amount: string; offsetAccount?: string; reason: string; journal: Lines }[]; reports: Record<string, string>[] };
  runs: { asAt: string; lines: Record<string, string>; total: string; journal: Lines }[]; reconciliation: Record<string, Record<string, string>>; pl: Record<string, Record<string, string>>;
};

let s: Stack;
let owner: TestUser, accountant: TestUser, reviewer: TestUser, bookkeeper: TestUser, viewer: TestUser, outsider: TestUser;
let company: { id: string };
const acc: Record<string, string> = {}, journals: Record<string, string> = {}, itemIds: Record<string, string> = {};
let provisionId: string;
const c = (p = '') => `/companies/${company.id}${p}`;
const as = (u: TestUser, m: 'get' | 'post', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: unknown }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body as any; };
const journalLines = (journalId: string) => adminSql(`SELECT string_agg(a.code || ':' || l.debit::numeric(19,2) || ':' || l.credit::numeric(19,2), ',' ORDER BY a.code, l.debit, l.credit) FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.journal_id = '${journalId}'`);
const expected = (lines: Lines) => lines.map(([k, d, cr]) => `${k}:${d}:${cr}`).sort().join(',');
const pl = (code: string, from: string, to: string) => adminSql(`SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(19,2) FROM journal_line l JOIN journal j ON j.id = l.journal_id WHERE l.account_id = '${acc[code]}' AND j.journal_date BETWEEN '${from}' AND '${to}'`);
const itemBody = (x: Record<string, any>) => ({ kind: x.kind, description: x.description, amount: x.amount, plAccountId: acc[x.plAccount], balanceAccountId: acc[x.balanceAccount], date: x.date,
  ...(x.periodStart ? { periodStart: x.periodStart, periodEnd: x.periodEnd, convention: x.convention, setup: x.setup === 'POSTED' ? { kind: 'POSTED' } : { kind: 'LINKED', journalId: journals[x.journalRef] } } : {}) });

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'Golden Year End Ltd');
  accountant = await addMember(s, owner, 'accountant');
  reviewer = await addMember(s, owner, 'reviewer');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  viewer = await addMember(s, owner, 'client_viewer');
  outsider = await createUser(s, { type: 'PRACTICE' });
  for (const [startDate, endDate] of G.periods) ok(await as(owner, 'post', c('/periods'), { startDate, endDate }), 201);
  for (const a of ok(await as(owner, 'post', c('/accounts/initialise')), 201).items) acc[a.code] = a.id;
  for (const a of G.accounts) acc[a.code!] = ok(await as(owner, 'post', c('/accounts'), a), 201).id;
  for (const p of G.seed) journals[p.ref] = ok(await as(accountant, 'post', c('/cash-transactions'), { direction: p.direction, transactionDate: p.date, bankAccountId: acc['1200'], description: p.description,
    lines: p.lines.map(([k, amount]) => ({ description: p.description, accountId: acc[k], amount })) }), 201).journalId;
});
afterAll(() => s.stop());

describe('items (DEC-059)', () => {
  it('accruals and accrued income post at the year end with their reversal on the next day; the schedules set up posted or linked', async () => {
    expect((await as(bookkeeper, 'post', c('/year-end-items'), itemBody(G.items[0]!))).status).toBe(403);
    for (const x of G.items) {
      const r = ok(await as(accountant, 'post', c('/year-end-items'), itemBody(x)), 201);
      itemIds[x.key] = r.id;
      expect(r).toMatchObject({ kind: x.kind, amount: x.amount, status: 'ACTIVE' });
      if (x.kind === 'ACCRUAL' || x.kind === 'ACCRUED_INCOME') {
        expect(journalLines(r.accrualJournalId)).toBe(expected(x.expect!.journal));
        expect(journalLines(r.autoReversalJournalId)).toBe(expected(x.expect!.reversal!.journal));
        expect(adminSql(`SELECT journal_date::text || ':' || source_type FROM journal WHERE id = '${r.autoReversalJournalId}'`)).toBe(`${x.expect!.reversal!.date}:ACCRUAL_AUTO_REVERSAL`);
      } else if (x.setup === 'POSTED') {
        expect(journalLines(r.setupJournalId)).toBe(expected(x.expect!.journal));
      } else expect(r.setupJournalId).toBe(journals[x.journalRef]);
    }
  });
  it('wrong accounts, control accounts, over-linking and a reversal day with no period are refused; nothing is written', async () => {
    const before = adminSql(`SELECT count(*) FROM journal WHERE company_id = '${company.id}'`);
    const base = itemBody(G.items[0]!);
    expect((await as(accountant, 'post', c('/year-end-items'), { ...base, plAccountId: acc['4000'] })).body.code).toBe('invalid_item_account');
    expect((await as(accountant, 'post', c('/year-end-items'), { ...base, balanceAccountId: acc['2100'] })).body.code).toBe('control_account_restricted');
    expect((await as(accountant, 'post', c('/year-end-items'), { ...base, date: '2027-12-31' })).body.code).toBe('next_period_missing');
    expect((await as(accountant, 'post', c('/year-end-items'), itemBody({ ...G.items.find((x) => x.key === 'PRE2')!, description: 'Linked twice' }))).body.code).toBe('link_amount_exceeded');
    expect((await as(accountant, 'post', c('/year-end-items'), { ...itemBody(G.items.find((x) => x.key === 'PRE1')!), periodEnd: '2026-01-01' })).status).toBe(422);
    expect(adminSql(`SELECT count(*) FROM journal WHERE company_id = '${company.id}'`)).toBe(before);
  });
});

describe('the golden scenario (DEC-054)', () => {
  it('provision made at the year end', async () => {
    const p = G.provision;
    provisionId = ok(await as(accountant, 'post', c('/provisions'), { name: p.name, accountId: acc[p.account], expenseAccountId: acc[p.expenseAccount], basis: p.basis }), 201).id;
    const m = p.movements[0]!;
    const r = ok(await as(accountant, 'post', c(`/provisions/${provisionId}/movements`), { kind: m.kind, date: m.date, amount: m.amount, reason: m.reason }), 201);
    expect(r.balance).toBe('800.00');
    expect(journalLines(r.movements[0].journalId)).toBe(expected(m.journal));
  });
  const run = async (i: number) => {
    const g = G.runs[i]!;
    const preview = ok(await as(reviewer, 'get', c(`/release-runs/preview?asAt=${g.asAt}`)));
    const key = (id: string) => Object.entries(itemIds).find(([, v]) => v === id)![0];
    expect(Object.fromEntries(preview.lines.map((l: { itemId: string; amount: string }) => [key(l.itemId), l.amount]))).toEqual(g.lines);
    const r = ok(await as(accountant, 'post', c('/release-runs'), { asAt: g.asAt }), 201);
    expect(r).toMatchObject({ asAt: g.asAt, total: g.total, status: 'POSTED' });
    expect(journalLines(r.journalId)).toBe(expected(g.journal));
    expect(ok(await as(reviewer, 'get', c(`/journals/${r.journalId}/source`))).source).toMatchObject({ entityType: 'release_run', id: r.id });
    return r;
  };
  it('release run as at 31.12.2026, then the register reconciles to the ledger by balance account', async () => {
    await run(0);
    const reg = ok(await as(reviewer, 'get', c('/year-end-register?asAt=2026-12-31')));
    expect(Object.fromEntries(reg.reconciliation.map((r: { code: string; register: string }) => [r.code, r.register]))).toEqual(G.reconciliation['2026-12-31']);
    expect(Object.fromEntries(reg.reconciliation.map((r: { code: string; ledger: string }) => [r.code, r.ledger]))).toEqual(G.reconciliation['2026-12-31']);
    expect(reg.reconciled).toBe(true);
  });
  it('provision used and released in 2027; the release run as at 31.3.2027; the register reconciles again', async () => {
    for (const m of G.provision.movements.slice(1)) {
      const r = ok(await as(accountant, 'post', c(`/provisions/${provisionId}/movements`), { kind: m.kind, date: m.date, amount: m.amount, reason: m.reason, ...(m.offsetAccount ? { offsetAccountId: acc[m.offsetAccount] } : {}) }), 201);
      expect(journalLines(r.movements.at(-1).journalId)).toBe(expected(m.journal));
    }
    await run(1);
    const reg = ok(await as(reviewer, 'get', c('/year-end-register?asAt=2027-03-31')));
    expect(Object.fromEntries(reg.reconciliation.map((r: { code: string; ledger: string }) => [r.code, r.ledger]))).toEqual(G.reconciliation['2027-03-31']);
    expect(reg.reconciled).toBe(true);
  });
  it('the provision movement report and the P&L effect per account match the hand figures', async () => {
    for (const rep of G.provision.reports) {
      const r = ok(await as(reviewer, 'get', c(`/provisions/report?from=${rep.from}&to=${rep.to}`)));
      expect(r.provisions[0]).toMatchObject({ opening: rep.opening, made: rep.made, used: rep.used, released: rep.released, closing: rep.closing });
    }
    for (const [k, v] of Object.entries(G.pl['2026']!)) expect(pl(k, '2026-01-01', '2026-12-31'), `${k} 2026`).toBe(v);
    for (const [k, v] of Object.entries(G.pl['2027Q1']!)) expect(pl(k, '2027-01-01', '2027-03-31'), `${k} 2027 Q1`).toBe(v);
  });
});

describe('cancellations, reversals and refusals', () => {
  it('only the latest live release run is reversed by its mirror; a released schedule cannot be cancelled; a re-run gives the same releases', async () => {
    const runs = ok(await as(reviewer, 'get', c('/release-runs'))).items as { id: string; asAt: string }[];
    expect((await as(accountant, 'post', c(`/release-runs/${runs[0]!.id}/reverse`), { reason: 'Not the latest' })).body.code).toBe('not_latest_run');
    expect((await as(accountant, 'post', c(`/year-end-items/${itemIds.PRE1}/cancel`), { reason: 'Released already' })).body.code).toBe('item_released');
    const rev = ok(await as(accountant, 'post', c(`/release-runs/${runs[1]!.id}/reverse`), { reason: 'Re-run after review' }));
    expect(journalLines(rev.reversalJournalId)).toBe(expected(G.runs[1]!.journal.map(([k, d, cr]) => [k, cr, d] as [string, string, string])));
    expect((await as(accountant, 'post', c(`/release-runs/${runs[1]!.id}/reverse`), { reason: 'Again' })).body.code).toBe('run_reversed');
    expect(ok(await as(accountant, 'post', c('/release-runs'), { asAt: '2027-03-31' }), 201).total).toBe(G.runs[1]!.total);
    expect((await as(accountant, 'post', c('/release-runs'), { asAt: '2027-02-28' })).body.code).toBe('run_not_later');
    expect((await as(accountant, 'post', c(`/journals/${rev.journalId}/reverse`), { reason: 'Bypass' })).body.code).toBe('subledger_journal');
  });
  it('a wrong accrual is cancelled by mirrors of both journals at their own dates; a provision movement only latest-first, never below zero', async () => {
    const r = ok(await as(accountant, 'post', c(`/year-end-items/${itemIds.ACC2}/cancel`), { reason: 'Interest already received in December' }));
    expect(r).toMatchObject({ status: 'CANCELLED', cancelledReason: 'Interest already received in December' });
    expect(r.cancellationJournalIds).toHaveLength(2);
    expect(journalLines(r.cancellationJournalIds[0])).toBe(expected(G.items.find((x) => x.key === 'ACC2')!.expect!.journal.map(([k, d, cr]) => [k, cr, d] as [string, string, string])));
    expect(adminSql(`SELECT string_agg(journal_date::text, ',' ORDER BY journal_date) FROM journal WHERE id = ANY(ARRAY['${r.cancellationJournalIds.join("','")}']::uuid[])`)).toBe('2026-12-31,2027-01-01');
    expect((await as(accountant, 'post', c(`/year-end-items/${itemIds.ACC2}/cancel`), { reason: 'Again' })).body.code).toBe('item_cancelled');
    const p = ok(await as(reviewer, 'get', c(`/provisions/${provisionId}`)));
    expect((await as(accountant, 'post', c(`/provision-movements/${p.movements[0].id}/reverse`), { reason: 'Not the latest' })).body.code).toBe('not_latest_movement');
    expect((await as(accountant, 'post', c(`/provisions/${provisionId}/movements`), { kind: 'RELEASED', date: '2027-03-31', amount: '400.01', reason: 'Too much' })).body.code).toBe('provision_exceeded');
    expect((await as(accountant, 'post', c(`/provisions/${provisionId}/movements`), { kind: 'MADE', date: '2027-01-01', amount: '1.00', reason: 'Back-dated' })).body.code).toBe('invalid_date');
    expect((await as(accountant, 'post', c(`/provisions/${provisionId}/movements`), { kind: 'USED', date: '2027-03-31', amount: '1.00', reason: 'No offset' })).status).toBe(422);
    const back = ok(await as(accountant, 'post', c(`/provision-movements/${p.movements[2].id}/reverse`), { reason: 'Release made in error' }));
    expect(back.balance).toBe('500.00');
    expect(journalLines(back.movements[2].reversalJournalId)).toBe(expected([['2160', '0.00', '100.00'], ['6700', '100.00', '0.00']]));
  });
  it('an unregistered posting on a register account shows as a reconciling item', async () => {
    ok(await as(accountant, 'post', c('/journals'), { journalDate: '2027-03-31', description: 'Prepaid rent, not registered', lines: [{ accountId: acc['1120'], debit: '90.00', credit: '0' }, { accountId: acc['6100'], debit: '0', credit: '90.00' }] }), 201);
    const reg = ok(await as(reviewer, 'get', c('/year-end-register?asAt=2027-03-31')));
    expect(reg.reconciliation.find((r: { code: string }) => r.code === '1120')).toMatchObject({ register: '1028.00', ledger: '1118.00', difference: '-90.00', reconciled: false,
      items: [expect.objectContaining({ description: 'Prepaid rent, not registered', unregistered: '90.00' })] });
  });
});

describe('access', () => {
  it('reading needs ledger:read; another organisation sees nothing; behind accounts.production', async () => {
    expect((await as(viewer, 'get', c('/year-end-items'))).status).toBe(403);
    expect((await as(viewer, 'get', c('/provisions'))).status).toBe(403);
    expect((await s.api().get(orgPath(owner, c('/year-end-items'))).set(bearer(outsider.token))).status).toBe(404);
    const theirs = await makeCompany(s, outsider, 'Other YE Co');
    const other = (p: string) => s.api().get(`/api/v1/organisations/${outsider.organisationId}/companies/${theirs.id}${p}`).set(bearer(outsider.token));
    expect((await other('/year-end-items')).body).toEqual({ items: [] });
    expect((await other(`/provisions/${provisionId}`)).status).toBe(404);
    expect((await s.api().put(`/api/v1/organisations/${outsider.organisationId}/feature-flags/accounts.production`).set(bearer(outsider.token)).send({ enabled: false })).status).toBe(200);
    expect((await other('/year-end-items')).body.code).toBe('feature_disabled');
  });
});
