import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, bearer, createUser, makeCompany, orgPath, startStack, uploadDoc, waitForJob, waitForVersion, type Stack, type TestUser } from '../helpers/stack';

/**
 * V1-M7a through the public API with the real worker: a CSV statement uploaded as a document is scanned, imported by the background job (progress
 * and outcome on the job record), listed, voided and imported again; bank accounts with masked details; transfers; permissions. Synthetic data.
 */
let s: Stack;
let owner: TestUser, accountant: TestUser, bookkeeper: TestUser, reviewer: TestUser, viewer: TestUser, outsider: TestUser;
let company: { id: string };
const acc: Record<string, string> = {};
const c = (p = '') => `/companies/${company.id}${p}`;
const as = (u: TestUser, m: 'get' | 'post' | 'patch', p: string, b?: object) => s.api()[m](orgPath(owner, p)).set(bearer(u.token)).send(b);
const MAPPING = { dateColumn: 'Date', dateFormat: 'DD/MM/YYYY', descriptionColumn: 'Description', moneyInColumn: 'Paid in', moneyOutColumn: 'Paid out', balanceColumn: 'Balance' };
const CSV = 'Date,Description,Paid in,Paid out,Balance\r\n'
  + '01/04/2026,OPENING DEPOSIT,500.00,,500.00\r\n'
  + '02/04/2026,"CARD, STATIONERS",,12.40,487.60\r\n'
  + '03/04/2026,BANK CHARGE,,5.00,482.60\r\n';
async function statement(body: string, by = bookkeeper) {
  const d = await uploadDoc(s, by, { name: 'statement.csv', companyId: company.id, contentType: 'text/csv', body: Buffer.from(body) });
  expect((await waitForVersion(s, by, d.documentId, d.versionId)).status).toBe('AVAILABLE');
  return { documentId: d.documentId, versionId: d.versionId };
}

beforeAll(async () => {
  s = await startStack();
  owner = await createUser(s, { type: 'PRACTICE' });
  company = await makeCompany(s, owner, 'Bank Client');
  accountant = await addMember(s, owner, 'accountant');
  bookkeeper = await addMember(s, owner, 'bookkeeper');
  reviewer = await addMember(s, owner, 'reviewer');
  viewer = await addMember(s, owner, 'client_viewer');
  outsider = await createUser(s, { type: 'PRACTICE' });
  await as(owner, 'post', c('/periods'), { startDate: '2026-01-01', endDate: '2026-12-31' });
  for (const a of (await as(owner, 'post', c('/accounts/initialise'))).body.items) acc[a.code] = a.id;
});
afterAll(() => s.stop());

describe('bank through the API (M7a)', () => {
  let bankId: string;
  it('a bookkeeper creates the bank account; details are masked in every view; the full details need bank:manage and are audited', async () => {
    expect((await as(reviewer, 'post', c('/bank-accounts'), {})).status).toBe(403);
    const r = await as(bookkeeper, 'post', c('/bank-accounts'), { accountId: acc['1200'], name: 'Business current', details: { sortCode: '12-34-56', accountNumber: '12345678' }, statementOpeningDate: '2026-03-31', statementOpeningBalance: '0.00' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ accountCode: '1200', detailsMasked: '**-**-56 ****5678', currency: 'GBP' });
    expect(JSON.stringify(r.body)).not.toContain('12345678');
    bankId = r.body.id;
    expect((await as(reviewer, 'get', c('/bank-accounts'))).body.items.map((x: { id: string }) => x.id)).toEqual([bankId]);
    expect((await as(reviewer, 'get', c(`/bank-accounts/${bankId}/details`))).status).toBe(403);
    expect((await as(bookkeeper, 'get', c(`/bank-accounts/${bankId}/details`))).body.details).toEqual({ sortCode: '123456', accountNumber: '12345678' });
    expect((await as(viewer, 'get', c('/bank-accounts'))).status).toBe(403);
    expect((await s.api().get(orgPath(owner, c('/bank-accounts'))).set(bearer(outsider.token))).status).toBe(404);
    expect((await as(bookkeeper, 'post', c('/bank-accounts'), { accountId: acc['1200'], name: 'x', statementOpeningDate: '2026-03-31', details: { sortCode: '12-34-56' } })).status).toBe(422);
  });
  it('a CSV statement is imported by the background job: progress and outcome on the job, lines in date order, nothing posted', async () => {
    const d = await statement(CSV);
    const r = await as(bookkeeper, 'post', c(`/bank-accounts/${bankId}/statement-imports`), { ...d, mapping: MAPPING });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ status: 'QUEUED', jobId: expect.any(String) });
    const job = await waitForJob(s, owner, r.body.jobId, ['COMPLETED', 'FAILED', 'DEAD']);
    expect(job).toMatchObject({ type: 'bank.statement.import', status: 'COMPLETED', progress: 100, result: { status: 'COMPLETED', rowsImported: 3 } });
    const imp = (await as(reviewer, 'get', c(`/statement-imports/${r.body.id}`))).body;
    expect(imp).toMatchObject({ status: 'COMPLETED', rowsRead: 3, rowsImported: 3, rowsDuplicate: 0, openingBalance: '0.00', closingBalance: '482.60' });
    const lines = (await as(reviewer, 'get', c(`/bank-accounts/${bankId}/statement-lines`))).body;
    expect(lines.items.map((l: { amount: string; description: string }) => `${l.description}:${l.amount}`)).toEqual(['OPENING DEPOSIT:500.00', 'CARD, STATIONERS:-12.40', 'BANK CHARGE:-5.00']);
    expect((await as(reviewer, 'get', c(`/bank-accounts/${bankId}`))).body).toMatchObject({ ledgerBalance: '0.00', statement: { lines: 3, balance: '482.60', unmatchedLines: 3 } });
    // the same file again is refused without a reason
    expect((await as(bookkeeper, 'post', c(`/bank-accounts/${bankId}/statement-imports`), { ...d, mapping: MAPPING })).body.code).toBe('statement_already_imported');
  });
  it('a broken file fails as a whole with row errors; the job completes and says so', async () => {
    const d = await statement('Date,Description,Paid in,Paid out,Balance\n04/04/2026,X,1.00,,483.60\n05/04/2026,Y,,1.00,999.00\n');
    const r = await as(bookkeeper, 'post', c(`/bank-accounts/${bankId}/statement-imports`), { ...d, mapping: MAPPING });
    const job = await waitForJob(s, owner, r.body.jobId, ['COMPLETED', 'FAILED', 'DEAD']);
    expect(job.result).toMatchObject({ status: 'FAILED', errors: 1 });
    expect((await as(reviewer, 'get', c(`/statement-imports/${r.body.id}`))).body).toMatchObject({ status: 'FAILED', rowsImported: null, errors: [{ row: 3, message: expect.stringMatching(/running balance/) }] });
  });
  it('a reviewer cannot void; a bookkeeper voids with a reason; the void lines stay listed', async () => {
    const list = (await as(reviewer, 'get', c(`/bank-accounts/${bankId}/statement-imports`))).body.items;
    const done = list.find((i: { status: string }) => i.status === 'COMPLETED');
    expect((await as(reviewer, 'post', c(`/statement-imports/${done.id}/void`), { reason: 'Wrong account chosen' })).status).toBe(403);
    expect((await as(bookkeeper, 'post', c(`/statement-imports/${done.id}/void`), { reason: 'short' })).status).toBe(422);
    const v = await as(bookkeeper, 'post', c(`/statement-imports/${done.id}/void`), { reason: 'Imported into the wrong account' });
    expect(v.body).toMatchObject({ status: 'VOID' });
    expect((await as(reviewer, 'get', `${c(`/bank-accounts/${bankId}/statement-lines`)}?status=VOID`)).body.items).toHaveLength(3);
  });
  it('transfers need bank:transfer; bank to petty cash posts one journal; the reverse direction respects the cash box', async () => {
    const body = { fromAccountId: acc['1200'], toAccountId: acc['1220'], transferDate: '2026-04-06', amount: '50.00', description: 'Petty cash float' };
    expect((await as(bookkeeper, 'post', c('/bank-transfers'), body)).status).toBe(403);
    const t = await as(accountant, 'post', c('/bank-transfers'), body);
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ amount: '50.00', status: 'POSTED', balanceWarnings: [{ kind: 'BANK', lowestBalance: '-50.00' }] });
    expect((await as(reviewer, 'get', c(`/journals/${t.body.journalId}`))).body).toMatchObject({ sourceType: 'BANK_TRANSFER' });
    const back = await as(accountant, 'post', c('/bank-transfers'), { ...body, fromAccountId: acc['1220'], toAccountId: acc['1200'], amount: '80.00', transferDate: '2026-04-07' });
    expect(back.body).toMatchObject({ code: 'negative_cash', errors: { lowestBalance: '-30.00' } });
    expect((await as(accountant, 'post', c(`/journals/${t.body.journalId}/reverse`), { reason: 'Ledger route' })).body.code).toBe('subledger_journal');
    const rev = await as(accountant, 'post', c(`/bank-transfers/${t.body.id}/reverse`), { reason: 'Float not needed after all' });
    expect(rev.body).toMatchObject({ status: 'REVERSED' });
    expect((await as(reviewer, 'get', `${c('/bank-transfers')}?status=REVERSED`)).body.items.map((x: { id: string }) => x.id)).toEqual([t.body.id]);
  });
  it('requests are validated: mapping shape, IBAN checksum, strict bodies', async () => {
    const d = await statement('Date,Description,Amount\n06/04/2026,Z,1.00\n');
    for (const mapping of [{ dateColumn: 'Date', dateFormat: 'DD/MM/YYYY', descriptionColumn: 'Description' }, { ...MAPPING, invertSign: true }, { ...MAPPING, dateFormat: 'D/M/Y' }]) {
      expect((await as(bookkeeper, 'post', c(`/bank-accounts/${bankId}/statement-imports`), { ...d, mapping })).status).toBe(422);
    }
    expect((await as(bookkeeper, 'patch', c(`/bank-accounts/${bankId}`), { details: { iban: 'GB29NWBK60161331926818' }, reason: 'New IBAN' })).status).toBe(422);
    expect((await as(bookkeeper, 'patch', c(`/bank-accounts/${bankId}`), { details: { iban: 'GB29 NWBK 6016 1331 9268 19' }, reason: 'New IBAN' })).body.detailsMasked).toBe('GB** **** 6819');
    expect((await as(accountant, 'post', c('/bank-transfers'), { fromAccountId: acc['1200'], toAccountId: acc['1200'], transferDate: '2026-04-06', amount: '1.00', description: 'x' })).status).toBe(422);
  });
});
