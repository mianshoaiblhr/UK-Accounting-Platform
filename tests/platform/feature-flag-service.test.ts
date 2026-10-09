import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@uk/core';
import { Database } from '@uk/db';
import { FeatureFlagService } from '@uk/platform';
import { adminSql } from '../helpers/db';

let db: Database;
let org: string, other: string, userId: string;
beforeAll(() => {
  db = new Database(process.env.DATABASE_URL!);
  org = uuidv7(); other = uuidv7();
  userId = adminSql(`INSERT INTO "user"(email, display_name) VALUES ('ff-${org}@t.test','F') RETURNING id`).split('\n')[0]!;
  adminSql(`INSERT INTO organisation(id,type,name) VALUES ('${org}','BUSINESS','FF1'),('${other}','BUSINESS','FF2')`);
});
afterAll(() => db.close());

describe('FeatureFlagService', () => {
  it('rejects unknown flags in the environment defaults at construction (fail fast)', () => {
    expect(() => new FeatureFlagService(db, { 'nope.flag': true } as never)).toThrow(/Unknown feature flag/);
  });
  it('resolves registry default < environment default < organisation override', async () => {
    const svc = new FeatureFlagService(db, { 'documents.ocr': true }, { ttlMs: 0 });
    expect(await svc.isEnabled('tax.rules.next', org)).toBe(false);   // registry default
    expect(await svc.isEnabled('documents.ocr', org)).toBe(true);     // environment
    await db.tenant({ organisationId: org, userId }, (tx) => svc.set(tx, { organisationId: org, key: 'documents.ocr', enabled: false, userId }));
    expect(await svc.isEnabled('documents.ocr', org)).toBe(false);    // override wins
    expect(await svc.isEnabled('documents.ocr', other)).toBe(true);   // other tenant keeps the environment value
  });
  it('caches reads for the TTL, and a change made through the service is visible immediately on that instance', async () => {
    const svc = new FeatureFlagService(db, {}, { ttlMs: 60_000 });
    expect(await svc.isEnabled('filing.formats.new', org)).toBe(false);          // cached as "no override"
    adminSql(`INSERT INTO feature_flag_override(organisation_id,key,enabled,set_by_user_id) VALUES ('${org}','filing.formats.new',true,'${userId}')`); // changed elsewhere
    expect(await svc.isEnabled('filing.formats.new', org)).toBe(false);          // stale within TTL (documented)
    await db.tenant({ organisationId: org, userId }, (tx) => svc.set(tx, { organisationId: org, key: 'filing.formats.new', enabled: true, userId }));
    expect(await svc.isEnabled('filing.formats.new', org)).toBe(true);           // invalidated by the local write
    const fresh = new FeatureFlagService(db, {}, { ttlMs: 60_000 });
    expect(await fresh.isEnabled('filing.formats.new', org)).toBe(true);         // a second instance sees it after its own (empty) cache
  });
  it('clear() on a flag without an override is a no-op', async () => {
    const svc = new FeatureFlagService(db, {}, { ttlMs: 0 });
    await db.tenant({ organisationId: other, userId }, (tx) => svc.clear(tx, { organisationId: other, key: 'reporting.standards.new', userId }));
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE organisation_id='${other}' AND action='feature_flag.cleared'`)).toBe('0');
  });
});
