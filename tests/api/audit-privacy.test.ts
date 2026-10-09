import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminSql } from '../helpers/db';
import { bearer, createUser, startStack, type Stack } from '../helpers/stack';

/** IP / device metadata "where lawful": AUDIT_CAPTURE_DEVICE_METADATA=false removes it from every audit event. */
let s: Stack;
beforeAll(async () => { s = await startStack({ AUDIT_CAPTURE_DEVICE_METADATA: 'false' }); });
afterAll(() => s.stop());

describe('device metadata switched off', () => {
  it('no IP address or user agent is stored on audit events - including login events; actor, time and correlation id still are', async () => {
    const u = await createUser(s, { type: 'BUSINESS' });
    const c = await s.api().post(`/api/v1/organisations/${u.organisationId}/companies`).set(bearer(u.token)).send({ name: 'NoIP Ltd' });
    expect(c.status).toBe(201);
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE actor_user_id='${u.userId}' AND (ip IS NOT NULL OR user_agent IS NOT NULL)`)).toBe('0');
    expect(Number(adminSql(`SELECT count(*) FROM audit_event WHERE actor_user_id='${u.userId}' AND correlation_id IS NOT NULL`))).toBeGreaterThan(0);
    expect(adminSql(`SELECT count(*) FROM audit_event WHERE actor_user_id='${u.userId}' AND action IN ('auth.registered','auth.email_verified','auth.login_success','auth.login')`)).not.toBe('0');
  });
});
