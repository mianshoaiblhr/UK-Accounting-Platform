import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobTypes } from '@uk/contracts';
import { adminSql } from '../helpers/db';
import { addMember, bearer, createUser, startStack, waitForJob, type Stack, type TestUser } from '../helpers/stack';

/** Feature flags: registry < environment default < organisation override; gated routes and queued work; audited; tenant-isolated. */
let s: Stack;
let owner: TestUser, other: TestUser, admin: TestUser;
const call = (u: TestUser, m: 'get' | 'post' | 'put' | 'delete', p: string, b?: object) => s.api()[m](`/api/v1/organisations/${u.organisationId}${p}`).set(bearer(u.token)).send(b);
const suggest = (u: TestUser) => call(u, 'post', '/ai/suggestions', { purpose: 'categorise_document', input: 'Receipt for stationery' });
const flag = async (u: TestUser, key: string) => ((await call(u, 'get', '/feature-flags')).body.items as Array<{ key: string; enabled: boolean; source: string }>).find((f) => f.key === key)!;

beforeAll(async () => {
  s = await startStack();  // vitest sets FEATURE_FLAG_DEFAULTS=ai.beta=true
  owner = await createUser(s, { type: 'BUSINESS' });
  other = await createUser(s, { type: 'BUSINESS' });
  admin = await addMember(s, owner, 'admin');
});
afterAll(() => s.stop());

describe('listing', () => {
  it('shows every registered flag with its effective value and where it comes from', async () => {
    const items = (await call(owner, 'get', '/feature-flags')).body.items as Array<{ key: string; enabled: boolean; source: string; description: string }>;
    expect(items.map((f) => f.key)).toEqual(['bookkeeping.core', 'ai.beta', 'documents.ocr', 'tax.rules.next', 'hmrc.endpoints.new', 'filing.formats.new', 'reporting.standards.new']);
    expect(items.find((f) => f.key === 'ai.beta')).toMatchObject({ enabled: true, source: 'environment' });
    expect(items.find((f) => f.key === 'tax.rules.next')).toMatchObject({ enabled: false, source: 'default' });
    expect(items.every((f) => f.description.length > 0)).toBe(true);
  });
  it('any member can read; unrelated organisations cannot', async () => {
    expect((await call(admin, 'get', '/feature-flags')).status).toBe(200);
    expect((await s.api().get(`/api/v1/organisations/${owner.organisationId}/feature-flags`).set(bearer(other.token))).status).toBe(404);
  });
});

describe('changing a flag', () => {
  it('needs org:manage (owner); admins and other roles are refused; unknown flags and bad bodies are rejected', async () => {
    expect((await call(admin, 'put', '/feature-flags/ai.beta', { enabled: false })).status).toBe(403);
    expect((await call(owner, 'put', '/feature-flags/not.a.flag', { enabled: true })).status).toBe(404);
    expect((await call(owner, 'put', '/feature-flags/ai.beta', { enabled: 'yes' })).status).toBe(422);
    expect((await call(owner, 'put', '/feature-flags/ai.beta', { enabled: true, extra: 1 })).status).toBe(422);
    expect((await call(owner, 'delete', '/feature-flags/not.a.flag')).status).toBe(404);
  });
  it('an organisation override beats the environment default, in both directions, and DELETE restores the default', async () => {
    expect((await suggest(owner)).status).toBe(202);                                    // env default: on
    const off = await call(owner, 'put', '/feature-flags/ai.beta', { enabled: false, reason: 'pause AI while we review the policy' });
    expect(off.body).toMatchObject({ key: 'ai.beta', enabled: false, source: 'organisation', reason: 'pause AI while we review the policy' });
    const blocked = await suggest(owner);
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('feature_disabled');
    expect(blocked.body.detail ?? blocked.body.title).toMatch(/ai\.beta/);
    expect((await call(owner, 'put', '/feature-flags/ai.beta', { enabled: true })).body.enabled).toBe(true);
    expect((await suggest(owner)).status).toBe(202);
    expect((await call(owner, 'put', '/feature-flags/tax.rules.next', { enabled: true })).body).toMatchObject({ enabled: true, source: 'organisation' });
    expect((await call(owner, 'delete', '/feature-flags/ai.beta?reason=done')).status).toBe(204);
    expect(await flag(owner, 'ai.beta')).toMatchObject({ enabled: true, source: 'environment' });
    expect((await call(owner, 'delete', '/feature-flags/tax.rules.next')).status).toBe(204);
    expect(await flag(owner, 'tax.rules.next')).toMatchObject({ enabled: false, source: 'default' });
  });
  it('is audited with before/after and the reason', async () => {
    await call(owner, 'put', '/feature-flags/hmrc.endpoints.new', { enabled: true, reason: 'sandbox testing' });
    await call(owner, 'delete', '/feature-flags/hmrc.endpoints.new?reason=testing%20finished');
    const events = (await call(owner, 'get', '/audit-events?entityType=feature_flag&limit=50')).body.items as Array<Record<string, any>>;
    const set = events.find((e) => e.action === 'feature_flag.set' && e.entityId === 'hmrc.endpoints.new')!;
    expect(set).toMatchObject({ before: { enabled: false, source: 'default' }, after: { enabled: true, source: 'organisation' }, reason: 'sandbox testing', actorUserId: owner.userId });
    const cleared = events.find((e) => e.action === 'feature_flag.cleared' && e.entityId === 'hmrc.endpoints.new')!;
    expect(cleared).toMatchObject({ before: { enabled: true }, after: { enabled: false, source: 'default' }, reason: 'testing finished' });
  });
});

describe('scope', () => {
  it('overrides are per organisation: another tenant is unaffected and cannot see them', async () => {
    await call(owner, 'put', '/feature-flags/ai.beta', { enabled: false });
    expect(await flag(other, 'ai.beta')).toMatchObject({ enabled: true, source: 'environment' });
    expect((await suggest(other)).status).toBe(202);
    expect(adminSql(`SELECT count(*) FROM feature_flag_override WHERE organisation_id='${other.organisationId}'`)).toBe('0');
    await call(owner, 'delete', '/feature-flags/ai.beta');
  });
  it('requests queued BEFORE a flag is switched off do not run after it (checked again at execution)', async () => {
    await call(owner, 'put', '/feature-flags/ai.beta', { enabled: false });
    const { record } = await s.worker.producer.enqueue(JobTypes.aiSuggest, { purpose: 'categorise_document', input: 'late request' }, { organisationId: owner.organisationId, userId: owner.userId });
    const done = await waitForJob(s, owner, record.id, ['DEAD', 'FAILED', 'COMPLETED']);
    expect(done.status).not.toBe('COMPLETED');
    expect(JSON.stringify(done)).toMatch(/ai\.beta is disabled/);
    await call(owner, 'delete', '/feature-flags/ai.beta');
  });
  it('only declared flags can be stored (database check) and each organisation has at most one override per flag', async () => {
    expect(() => adminSql(`INSERT INTO feature_flag_override(organisation_id,key,enabled,set_by_user_id) VALUES ('${owner.organisationId}','Bad Key!',true,'${owner.userId}')`)).toThrow(/feature_flag_key_ck/);
    await call(owner, 'put', '/feature-flags/documents.ocr', { enabled: true });
    expect(() => adminSql(`INSERT INTO feature_flag_override(organisation_id,key,enabled,set_by_user_id) VALUES ('${owner.organisationId}','documents.ocr',false,'${owner.userId}')`)).toThrow(/unique|duplicate/i);
    await call(owner, 'delete', '/feature-flags/documents.ocr');
  });
});
