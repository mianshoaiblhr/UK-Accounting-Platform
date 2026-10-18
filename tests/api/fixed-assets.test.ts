import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, type Stack, type TestUser } from '../helpers/stack';
import { adminSql } from '../helpers/db';

/**
 * V2-M2 through the public API (v2-plan 4.4): the golden fixed-asset scenario (DEC-054) reproduced to the cent, the reversals and the refused
 * ones, tax kept apart, the reconciliation with an unregistered posting, permissions and tenancy. Synthetic data only.
 */
type Step = { do: string; asAt?: string; asset?: string; on?: string; proceeds?: string; proceedsAccount?: string; lifeMonths?: number; residual?: string; reason?: string; expect: Record<string, any> };
const G = JSON.parse(readFileSync(resolve(__dirname, '../golden/v2-m2-fixed-assets.json'), 'utf8')) as {
  periods: [string, string][]; accounts: Record<string, string>[]; classes: Record<string, any>[]; assets: Record<string, any>[]; steps: Step[];
  seed: ({ kind: 'cash'; date: string; direction: string; bank: string; lines: [string, string][]; description: string; ref: string } | { kind: 'journal'; date: string; description: string; lines: [string, string, string][]; ref: string })[];
};

let s: Stack;
let owner: TestUser, accountant: TestUser, bookkeeper: TestUser, viewer: TestUser, outsider: TestUser;
let company: { id: string };
const acc: Record<string, string> = {}, journals: Record<string, string> = {}, classIds: Record<string, string> = {}, assetIds: Record<string, string> = {}, runIds: Record<string, string> = {};
const c = (p = '') => `/companies/${company.id}${p}`;
const as = (u: TestUser, m: 'get' | 'post' | 'patch', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const ok = (r: { status: number; body: unknown }, status = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(status); return r.body as any; };
const code = (id: string) => Object.entries(acc).find(([, v]) => v === id)![0];
const journalLines = (journalId: string) => adminSql(`SELECT string_agg(a.code || ':' || l.debit::numeric(19,2) || ':' || l.credit::numeric(19,2), ',' ORDER BY a.code, l.debit, l.credit) FROM journal_line l JOIN account a ON a.id = l.account_id WHERE l.journal_id = '${journalId}'`);
const expected = (lines: [string, string, string][]) => lines.map(([k, d, cr]) => `${k}:${d}:${cr}`).sort().join(',');
const ledger = (accountCode: string, from: string, to: string) => adminSql(`SELECT coalesce(sum(l.debit - l.credit), 0)::numeric(19,2) FROM journal_line l JOIN journal j ON j.id = l.journal_id WHERE l.account_id = '${acc[accountCode]}' AND j.journal_date BETWEEN '${from}' AND '${to}'`);
const step = (k: string) => G.steps.find((x) => `${x.do}:${x.asAt ?? x.asset}` === k)!;

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'Golden Assets Ltd');
  accountant = await addMember(s, owner, 'accountant');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  viewer = await addMember(s, owner, 'client_viewer');
  outsider = await createUser(s, { type: 'PRACTICE' });
  for (const [startDate, endDate] of G.periods) ok(await as(owner, 'post', c('/periods'), { startDate, endDate }), 201);
  for (const a of ok(await as(owner, 'post', c('/accounts/initialise')), 201).items) acc[a.code] = a.id;
  for (const a of G.accounts) acc[a.code!] = ok(await as(owner, 'post', c('/accounts'), a), 201).id;
  for (const p of G.seed) {
    const r = p.kind === 'cash'
      ? await as(accountant, 'post', c('/cash-transactions'), { direction: p.direction, transactionDate: p.date, bankAccountId: acc[p.bank], description: p.description, lines: p.lines.map(([k, amount]) => ({ description: p.description, accountId: acc[k], amount })) })
      : await as(accountant, 'post', c('/journals'), { journalDate: p.date, description: p.description, lines: p.lines.map(([k, debit, credit]) => ({ accountId: acc[k], debit, credit })) });
    journals[p.ref] = ok(r, 201)[p.kind === 'cash' ? 'journalId' : 'id'];
  }
});
afterAll(() => s.stop());

describe('classes and additions', () => {
  it('classes name four accounts of the right kind, never control accounts; bookkeepers may read but not manage', async () => {
    const base = G.classes[0]!;
    const body = (k: Record<string, any>) => ({ code: k.code, name: k.name, costAccountId: acc[k.costAccount], depreciationAccountId: acc[k.depreciationAccount], expenseAccountId: acc[k.expenseAccount], disposalAccountId: acc[k.disposalAccount],
      method: k.method, ...(k.lifeMonths ? { lifeMonths: k.lifeMonths } : {}), ...(k.ratePercent ? { ratePercent: k.ratePercent } : {}), convention: k.convention });
    expect((await as(bookkeeper, 'post', c('/fixed-asset-classes'), body(base))).status).toBe(403);
    expect((await as(accountant, 'post', c('/fixed-asset-classes'), { ...body(base), code: 'BAD1', costAccountId: acc['6900'] })).body.code).toBe('invalid_class_account');
    expect((await as(accountant, 'post', c('/fixed-asset-classes'), { ...body(base), code: 'BAD2', disposalAccountId: acc['1200'] })).body).toMatchObject({ code: 'invalid_class_account' });
    expect((await as(accountant, 'post', c('/fixed-asset-classes'), { ...body(base), code: 'BAD3', lifeMonths: undefined })).status).toBe(422);
    for (const k of G.classes) classIds[k.code] = ok(await as(accountant, 'post', c('/fixed-asset-classes'), body(k)), 201).id;
    expect((await as(accountant, 'post', c('/fixed-asset-classes'), body(base))).body.code).toBe('class_exists');
    expect(ok(await as(bookkeeper, 'get', c('/fixed-asset-classes'))).items.map((x: { code: string }) => x.code)).toEqual(['MOTOR', 'OFFICE']);
  });
  it('the four golden assets are added: linked to their existing postings, posted from an offset account, and taken on; over-linking and control offsets are refused', async () => {
    const body = (x: Record<string, any>) => ({ classId: classIds[x.class], description: x.description, acquiredOn: x.acquiredOn, inUseFrom: x.inUseFrom, cost: x.cost,
      addition: x.addition.kind === 'POSTED' ? { kind: 'POSTED', offsetAccountId: acc[x.addition.offsetAccount] } : x.addition.kind === 'LINKED' ? { kind: 'LINKED', journalId: journals[x.addition.journalRef] }
        : { kind: 'TAKE_ON', takeOnDate: x.addition.takeOnDate, accumulatedDepreciation: x.addition.accumulatedDepreciation, journalId: journals[x.addition.journalRef] },
      ...(x.method ? { method: x.method } : {}), ...(x.lifeMonths ? { lifeMonths: x.lifeMonths } : {}), ...(x.residual ? { residual: x.residual } : {}), ...(x.convention ? { convention: x.convention } : {}), tax: x.tax });
    for (const x of G.assets) {
      const r = ok(await as(accountant, 'post', c('/fixed-assets'), body(x)), 201);
      assetIds[x.key] = r.id;
      expect(r).toMatchObject({ status: 'ACTIVE', cost: x.cost, additionKind: x.addition.kind });
    }
    // the printer journal is fully registered now; the van posted Dr cost / Cr directors' loan
    const printer = G.assets.find((x) => x.key === 'A3')!;
    expect((await as(accountant, 'post', c('/fixed-assets'), { ...body(printer), description: 'Twice' })).body.code).toBe('link_amount_exceeded');
    expect((await as(accountant, 'post', c('/fixed-assets'), { ...body(G.assets[3]!), description: 'From the bank', addition: { kind: 'POSTED', offsetAccountId: acc['1200'] } })).body.code).toBe('control_account_restricted');
    expect((await as(accountant, 'post', c('/fixed-assets'), { ...body(G.assets[1]!), description: 'No remaining life', method: undefined, lifeMonths: undefined })).body.code).toBe('remaining_life_required');
    const van = ok(await as(bookkeeper, 'get', c(`/fixed-assets/${assetIds.A2}`)));
    expect(journalLines(van.additionJournalId)).toBe(expected([['0040', '12000.00', '0.00'], ['2230', '0.00', '12000.00']]));
    expect(van.bases).toEqual([expect.objectContaining({ effectiveFrom: '2026-07-01', carryingAmount: '12000.00', method: 'REDUCING_BALANCE', ratePercent: '25', residual: '1000.00', convention: 'DAILY' })]);
    const furniture = ok(await as(bookkeeper, 'get', c(`/fixed-assets/${assetIds.A4}`)));
    expect(furniture).toMatchObject({ accumulatedDepreciation: '2000.00', carryingAmount: '3000.00', bases: [expect.objectContaining({ effectiveFrom: '2026-01-01', carryingAmount: '3000.00', accumulatedBefore: '2000.00', lifeMonths: 30, residual: '500.00' })] });
    expect(ok(await as(bookkeeper, 'get', c(`/fixed-assets/${assetIds.A1}`)))).toMatchObject({ bases: [expect.objectContaining({ method: 'STRAIGHT_LINE', lifeMonths: 36, convention: 'MONTHLY', residual: '0.00' })] });
  });
});

describe('the golden scenario (DEC-054)', () => {
  const run = async (st: Step) => {
    const preview = ok(await as(bookkeeper, 'get', c(`/depreciation-runs/preview?asAt=${st.asAt}`)));
    expect(Object.fromEntries(preview.lines.map((l: { number: number; amount: string }) => [G.assets.find((x) => assetIds[x.key] === preview.lines.find((y: { number: number }) => y.number === l.number).assetId)!.key, l.amount]))).toEqual(st.expect.lines);
    expect((await as(bookkeeper, 'post', c('/depreciation-runs'), { asAt: st.asAt })).status).toBe(403);
    const r = ok(await as(accountant, 'post', c('/depreciation-runs'), { asAt: st.asAt }), 201);
    expect(r).toMatchObject({ asAt: st.asAt, status: 'POSTED', total: st.expect.total });
    expect(journalLines(r.journalId)).toBe(expected(st.expect.journal));
    expect(adminSql(`SELECT source_type FROM journal WHERE id = '${r.journalId}'`)).toBe('FIXED_ASSET_DEPRECIATION');
    runIds[st.asAt!] = r.id;
    return r;
  };
  it('run as at 31.12.2025: the printer only', async () => { await run(step('run:2025-12-31')); });
  it('the printer is disposed of at a gain: catch-up, cost and depreciation removed, carrying amount and proceeds on the disposal account', async () => {
    const st = step('dispose:A3');
    expect((await as(accountant, 'post', c(`/fixed-assets/${assetIds.A3}/dispose`), { disposedOn: st.on, proceeds: st.proceeds, proceedsAccountId: acc['1200'], reason: 'Sold to a member of staff' })).body.code).toBe('control_account_restricted');
    const r = ok(await as(accountant, 'post', c(`/fixed-assets/${assetIds.A3}/dispose`), { disposedOn: st.on, proceeds: st.proceeds, proceedsAccountId: acc[st.proceedsAccount!], reason: 'Sold to a member of staff' }));
    expect(r).toMatchObject({ status: 'DISPOSED', disposedOn: st.on, disposalCatchUp: st.expect.catchUp, carryingAmount: st.expect.carrying, gainOrLoss: st.expect.gainOrLoss, accumulatedDepreciation: '1795.07' });
    expect(journalLines(r.disposalJournalId)).toBe(expected(st.expect.journal));
    expect(adminSql(`SELECT reason FROM audit_event WHERE action = 'assets.asset_disposed' AND entity_id = '${assetIds.A3}'`)).toBe('Sold to a member of staff');
  });
  it('run as at 30.6.2026 and 31.12.2026', async () => { await run(step('run:2026-06-30')); await run(step('run:2026-12-31')); });
  it('the register at 31.12.2026 matches the hand figures and reconciles to the ledger by account; the ledger holds the expected expense and gain', async () => {
    const st = step('register:2026-12-31');
    const reg = ok(await as(bookkeeper, 'get', c('/fixed-asset-register?asAt=2026-12-31')));
    const got = Object.fromEntries(reg.classes.flatMap((k: { assets: { id: string; cost: string; accumulatedDepreciation: string; carryingAmount: string; status: string }[] }) => k.assets)
      .map((x: { id: string; cost: string; accumulatedDepreciation: string; carryingAmount: string; status: string }) => [G.assets.find((y) => assetIds[y.key] === x.id)!.key, [x.cost, x.accumulatedDepreciation, x.carryingAmount, x.status]]));
    expect(got).toEqual(st.expect.assets);
    expect(Object.fromEntries(reg.reconciliation.map((r: { code: string; register: string; ledger: string }) => [r.code, [r.register, r.ledger]]))).toEqual(st.expect.reconciliation);
    expect(reg.reconciliation.every((r: { items: unknown[] }) => r.items.length === 0)).toBe(true);
    expect(reg.reconciled).toBe(true);
    const l = step('ledger:undefined');
    for (const [k, years] of Object.entries(l.expect as Record<string, Record<string, string>>)) for (const [y, v] of Object.entries(years)) expect(ledger(k, `${y}-01-01`, `${y}-12-31`), `${k} ${y}`).toBe(v);
  });
  it('a prospective change of estimate starts the day after the last charge, at the carrying amount then; the next run follows it', async () => {
    const st = step('estimate:A1');
    expect((await as(bookkeeper, 'post', c(`/fixed-assets/${assetIds.A1}/estimate`), { lifeMonths: st.lifeMonths, reason: st.reason })).status).toBe(403);
    const r = ok(await as(accountant, 'post', c(`/fixed-assets/${assetIds.A1}/estimate`), { lifeMonths: st.lifeMonths, residual: st.residual, reason: st.reason }), 201);
    expect(r.bases.at(-1)).toMatchObject({ effectiveFrom: st.expect.effectiveFrom, carryingAmount: st.expect.carryingAtBasis, accumulatedBefore: '1000.00', lifeMonths: 13, reason: st.reason });
    expect(r.bases).toHaveLength(2);
    await run(step('run:2027-01-31'));
  });
});

describe('reversals, refusals and tax kept apart', () => {
  it('only the latest live run is reversed, by its mirror; a re-run gives the same charges; a run must be later than every live run', async () => {
    expect((await as(accountant, 'post', c(`/depreciation-runs/${runIds['2026-12-31']}/reverse`), { reason: 'Not the latest' })).body.code).toBe('not_latest_run');
    expect((await as(accountant, 'post', c('/depreciation-runs'), { asAt: '2027-01-15' })).body.code).toBe('run_not_later');
    const rev = ok(await as(accountant, 'post', c(`/depreciation-runs/${runIds['2027-01-31']}/reverse`), { reason: 'Re-run after review' }));
    expect(rev).toMatchObject({ status: 'REVERSED', reversedReason: 'Re-run after review' });
    expect(journalLines(rev.reversalJournalId)).toBe(expected(step('run:2027-01-31').expect.journal.map(([k, d, cr]: [string, string, string]) => [k, cr, d])));
    expect((await as(accountant, 'post', c(`/depreciation-runs/${runIds['2027-01-31']}/reverse`), { reason: 'Again' })).body.code).toBe('run_reversed');
    const again = ok(await as(accountant, 'post', c('/depreciation-runs'), { asAt: '2027-01-31' }), 201);
    expect(again.total).toBe(step('run:2027-01-31').expect.total);
    runIds['2027-01-31'] = again.id;
    // a run relied on by a change of estimate, or one that charged an asset later disposed of, cannot be reversed
    ok(await as(accountant, 'post', c(`/depreciation-runs/${again.id}/reverse`), { reason: 'Back to 2026' }));
    expect((await as(accountant, 'post', c(`/depreciation-runs/${runIds['2026-12-31']}/reverse`), { reason: 'Not allowed' })).body.code).toBe('estimate_changed_after_run');
    runIds['2027-01-31'] = ok(await as(accountant, 'post', c('/depreciation-runs'), { asAt: '2027-01-31' }), 201).id;
    // the ledger refuses to reverse a register journal directly
    const j = ok(await as(bookkeeper, 'get', c(`/depreciation-runs/${runIds['2027-01-31']}`))).journalId;
    expect((await as(accountant, 'post', c(`/journals/${j}/reverse`), { reason: 'Bypass the register' })).body.code).toBe('subledger_journal');
  });
  it('a disposal is reversed only while no later run is live; an addition only before any depreciation, and the asset becomes VOID', async () => {
    expect((await as(accountant, 'post', c(`/fixed-assets/${assetIds.A3}/reverse-disposal`), { reason: 'Sale fell through' })).body.code).toBe('later_run_exists');
    expect((await as(accountant, 'post', c(`/fixed-assets/${assetIds.A2}/reverse-addition`), { reason: 'Wrong van' })).body.code).toBe('asset_depreciated');
    expect((await as(accountant, 'post', c(`/fixed-assets/${assetIds.A1}/reverse-addition`), { reason: 'Linked' })).body.code).toBe('addition_not_posted');
    const k = classIds.MOTOR;
    const spare = ok(await as(accountant, 'post', c('/fixed-assets'), { classId: k, description: 'Trailer entered twice', acquiredOn: '2027-01-31', cost: '800.00', addition: { kind: 'POSTED', offsetAccountId: acc['2230'] }, residual: '0' }), 201);
    const voided = ok(await as(accountant, 'post', c(`/fixed-assets/${spare.id}/reverse-addition`), { reason: 'Entered twice' }));
    expect(voided).toMatchObject({ status: 'VOID', carryingAmount: '0.00' });
    expect(journalLines(voided.additionReversalJournalId)).toBe(expected([['0040', '0.00', '800.00'], ['2230', '800.00', '0.00']]));
    expect((await as(accountant, 'post', c(`/fixed-assets/${spare.id}/reverse-addition`), { reason: 'Again' })).body.code).toBe('asset_not_active');
    // dispose and reverse at once when nothing later is live: the asset is ACTIVE again with its figures restored
    const before = ok(await as(bookkeeper, 'get', c(`/fixed-assets/${assetIds.A4}`)));
    const d = ok(await as(accountant, 'post', c(`/fixed-assets/${assetIds.A4}/dispose`), { disposedOn: '2027-02-28', proceeds: '0', reason: 'Scrapped' }));
    expect(d).toMatchObject({ status: 'DISPOSED', gainOrLoss: `-${d.carryingAmount}` });
    const back = ok(await as(accountant, 'post', c(`/fixed-assets/${assetIds.A4}/reverse-disposal`), { reason: 'Not scrapped after all' }));
    expect(back).toMatchObject({ status: 'ACTIVE', accumulatedDepreciation: before.accumulatedDepreciation, carryingAmount: before.carryingAmount, disposedOn: null });
    expect(journalLines(adminSql(`SELECT id FROM journal WHERE source_type = 'FIXED_ASSET_DISPOSAL_REVERSAL' AND source_id = '${assetIds.A4}'`))).toBe(
      journalLines(d.disposalJournalId).split(',').map((x: string) => { const [k, dr, cr] = x.split(':'); return `${k}:${cr}:${dr}`; }).sort().join(','));
  });
  it('tax fields are stored apart: changing them changes no depreciation figure', async () => {
    const before = ok(await as(bookkeeper, 'get', c('/depreciation-runs/preview?asAt=2027-03-31')));
    const t = ok(await as(accountant, 'post', c(`/fixed-assets/${assetIds.A2}/tax`), { category: 'SPECIAL_RATE_POOL', cost: '9000.00', reason: 'Reclassified for capital allowances' }));
    expect(t.tax).toEqual({ category: 'SPECIAL_RATE_POOL', cost: '9000.00' });
    expect(ok(await as(bookkeeper, 'get', c('/depreciation-runs/preview?asAt=2027-03-31')))).toEqual(before);
  });
  it('a closed period refuses register postings dated in it', async () => {
    const periods = ok(await as(owner, 'get', c('/periods'))).items as { id: string; startDate: string }[];
    const p2025 = periods.find((p) => p.startDate.startsWith('2025'))!;
    ok(await as(accountant, 'post', c(`/periods/${p2025.id}/close`), { acknowledgeUnreconciledBank: true, acknowledgeUnrevaluedFx: true }));
    const r = await as(accountant, 'post', c('/fixed-assets'), { classId: classIds.OFFICE, description: 'Back-dated chair', acquiredOn: '2025-06-01', cost: '100.00', addition: { kind: 'POSTED', offsetAccountId: acc['2230'] } });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('period_closed');
    expect(adminSql(`SELECT count(*) FROM fixed_asset WHERE description = 'Back-dated chair'`)).toBe('0');
  });
  it('an unregistered posting on a register account shows as a reconciling item', async () => {
    ok(await as(accountant, 'post', c('/journals'), { journalDate: '2027-02-15', description: 'Shelving, not yet registered', lines: [{ accountId: acc['0030'], debit: '250.00', credit: '0' }, { accountId: acc['2230'], debit: '0', credit: '250.00' }] }), 201);
    const reg = ok(await as(bookkeeper, 'get', c('/fixed-asset-register?asAt=2027-02-28')));
    const r0030 = reg.reconciliation.find((r: { code: string }) => r.code === '0030');
    expect(r0030).toMatchObject({ register: '8600.00', ledger: '8850.00', difference: '-250.00', reconciled: false, items: [expect.objectContaining({ description: 'Shelving, not yet registered', unregistered: '250.00', sourceType: 'MANUAL' })] });
    expect(reg.reconciled).toBe(false);
  });
});

describe('access', () => {
  it('reading needs assets:read; another organisation sees nothing; the routes are behind accounts.production', async () => {
    expect((await as(viewer, 'get', c('/fixed-assets'))).status).toBe(403);
    expect((await as(viewer, 'get', c('/fixed-asset-register?asAt=2026-12-31'))).status).toBe(403);
    expect((await s.api().get(orgPath(owner, c('/fixed-assets'))).set(bearer(outsider.token))).status).toBe(404);
    const theirs = await makeCompany(s, outsider, 'Other Assets Co');
    const other = (p: string) => s.api().get(`/api/v1/organisations/${outsider.organisationId}/companies/${theirs.id}${p}`).set(bearer(outsider.token));
    expect((await other('/fixed-assets')).body).toEqual({ items: [] });
    expect((await other(`/fixed-assets/${assetIds.A1}`)).status).toBe(404);
    expect((await s.api().put(`/api/v1/organisations/${outsider.organisationId}/feature-flags/accounts.production`).set(bearer(outsider.token)).send({ enabled: false })).status).toBe(200);
    expect((await other('/fixed-assets')).body.code).toBe('feature_disabled');
    void code;
  });
});
