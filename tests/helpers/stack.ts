import 'reflect-metadata';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { loadConfig, type AppConfig } from '@uk/core';
import { Database } from '@uk/db';
import { createApp } from '../../apps/api/src/bootstrap';
import { startWorker, type WorkerHandle } from '../../apps/worker/src/worker';

export const ORIGIN = 'http://localhost:3000';
export const PASSWORD = 'Correct-Horse-Battery-9';
let seq = 0;
export const uniq = (p = 'u') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface Stack {
  app: NestExpressApplication;
  config: AppConfig;
  worker: WorkerHandle;
  db: Database; // runtime-role handle for assertions
  mailDir: string;
  api(): request.Agent;
  mail: { waitFor(to: string, subject?: RegExp, timeoutMs?: number): Promise<{ to: string; subject: string; text: string }>; tokenFrom(text: string): string };
  stop(): Promise<void>;
}

export async function startStack(env: Record<string, string> = {}, opts: { worker?: boolean } = {}): Promise<Stack> {
  const mailDir = mkdtempSync(join(tmpdir(), 'uk-mail-'));
  const config = loadConfig({ ...process.env, EMAIL_DRIVER: 'file', EMAIL_FILE_DIR: mailDir, ...env } as NodeJS.ProcessEnv);
  const app = await createApp(config);
  await app.listen(0, '127.0.0.1'); // one stable listener (supertest otherwise opens/closes ephemeral ports per request)
  const worker = startWorker(config);
  const db = new Database(config.DATABASE_URL);
  const server = app.getHttpServer();
  return {
    app, config, worker, db, mailDir,
    api: () => request.agent(server),
    mail: {
      async waitFor(to, subject, timeoutMs = 15_000) {
        const t0 = Date.now();
        for (;;) {
          const hit = readdirSync(mailDir).map((f) => JSON.parse(readFileSync(join(mailDir, f), 'utf8')) as { to: string; subject: string; text: string })
            .filter((m) => m.to === to && (!subject || subject.test(m.subject))).pop();
          if (hit) return hit;
          if (Date.now() - t0 > timeoutMs) throw new Error(`No email to ${to} matching ${subject} within ${timeoutMs}ms`);
          await new Promise((r) => setTimeout(r, 100));
        }
      },
      tokenFrom(text) {
        const m = /token=([\w-]+)/.exec(text);
        if (!m) throw new Error('no token in email');
        return m[1]!;
      },
    },
    async stop() {
      await worker.stop();
      await db.close();
      await app.close();
      rmSync(mailDir, { recursive: true, force: true });
    },
  };
}

export interface TestUser { email: string; password: string; token: string; userId: string; organisationId: string; displayName: string }

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}`, Origin: ORIGIN });

/** Full real flow: register -> email (via worker) -> verify -> bearer login. */
export async function createUser(s: Stack, o: { type?: 'PRACTICE' | 'BUSINESS'; email?: string; orgName?: string } = {}): Promise<TestUser> {
  const email = o.email ?? `${uniq()}@example.test`;
  const displayName = `User ${email.split('@')[0]}`;
  const reg = await s.api().post('/api/v1/auth/register').set('Origin', ORIGIN)
    .send({ email, password: PASSWORD, displayName, organisationName: o.orgName ?? `Org ${uniq('o')}`, organisationType: o.type ?? 'PRACTICE' });
  if (reg.status !== 202) throw new Error(`register failed ${reg.status} ${JSON.stringify(reg.body)}`);
  const mail = await s.mail.waitFor(email, /Verify/);
  const v = await s.api().post('/api/v1/auth/verify-email').set('Origin', ORIGIN).send({ token: s.mail.tokenFrom(mail.text) });
  if (v.status !== 200) throw new Error(`verify failed ${v.status}`);
  const login = await s.api().post('/api/v1/auth/login/bearer').set('Origin', ORIGIN).send({ email, password: PASSWORD });
  if (login.status !== 200 || !login.body.sessionToken) throw new Error(`login failed ${login.status} ${JSON.stringify(login.body)}`);
  const me = await s.api().get('/api/v1/auth/me').set(bearer(login.body.sessionToken));
  return { email, password: PASSWORD, token: login.body.sessionToken, userId: me.body.user.id, organisationId: me.body.organisations[0].id, displayName };
}

export const orgPath = (u: { organisationId: string }, p = '') => `/api/v1/organisations/${u.organisationId}${p}`;

export async function waitForJob(s: Stack, user: TestUser, jobId: string, statuses: string[], timeoutMs = 15_000) {
  const t0 = Date.now();
  for (;;) {
    const r = await s.api().get(orgPath(user, `/jobs/${jobId}`)).set(bearer(user.token));
    if (statuses.includes(r.body.status)) return r.body;
    if (Date.now() - t0 > timeoutMs) throw new Error(`job ${jobId} stuck in ${r.body.status}`);
    await new Promise((res) => setTimeout(res, 100));
  }
}

export async function roleId(s: Stack, owner: TestUser, key: string): Promise<string> {
  const r = await s.api().get(orgPath(owner, '/roles')).set(bearer(owner.token));
  return r.body.items.find((x: { key: string }) => x.key === key).id;
}

/** Invites a brand-new user into owner's organisation with a role (real invitation + email + accept flow). */
export async function addMember(s: Stack, owner: TestUser, key: string, o: { scope?: 'ALL' | 'ASSIGNED'; companyIds?: string[] } = {}): Promise<TestUser> {
  const u = await createUser(s);
  const inv = await s.api().post(orgPath(owner, '/invitations')).set(bearer(owner.token))
    .send({ email: u.email, roleId: await roleId(s, owner, key), companyScope: o.scope ?? 'ALL', companyIds: o.companyIds ?? [] });
  if (inv.status !== 201) throw new Error(`invite failed ${inv.status} ${JSON.stringify(inv.body)}`);
  const mail = await s.mail.waitFor(u.email, /invited/);
  const acc = await s.api().post('/api/v1/invitations/accept').set(bearer(u.token)).send({ token: s.mail.tokenFrom(mail.text) });
  if (acc.status !== 200) throw new Error(`accept failed ${acc.status} ${JSON.stringify(acc.body)}`);
  return { ...u, organisationId: owner.organisationId };
}

export async function makeCompany(s: Stack, u: TestUser, name = `Co ${uniq('c')}`, companyNumber?: string) {
  const r = await s.api().post(orgPath(u, '/companies')).set(bearer(u.token)).send({ name, ...(companyNumber ? { companyNumber } : {}) });
  if (r.status !== 201) throw new Error(`company failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; name: string };
}

export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

/** Create + upload (via API) a document; returns ids. */
export async function uploadDoc(s: Stack, u: TestUser, o: { name?: string; companyId?: string; contentType?: string; body?: Buffer } = {}) {
  const body = o.body ?? PDF;
  const contentType = o.contentType ?? 'application/pdf';
  const c = await s.api().post(orgPath(u, '/documents')).set(bearer(u.token)).send({ name: o.name ?? 'invoice.pdf', companyId: o.companyId, contentType, sizeBytes: body.length });
  if (c.status !== 201) throw new Error(`doc create failed ${c.status} ${JSON.stringify(c.body)}`);
  const up = await s.api().put(c.body.upload.url).set(bearer(u.token)).set('Content-Type', contentType).send(body);
  return { documentId: c.body.document.id as string, versionId: c.body.version.id as string, createResponse: c, uploadResponse: up };
}

export async function waitForVersion(s: Stack, u: TestUser, documentId: string, versionId: string, statuses = ['AVAILABLE', 'QUARANTINED', 'FAILED']) {
  const t0 = Date.now();
  for (;;) {
    const r = await s.api().get(orgPath(u, `/documents/${documentId}`)).set(bearer(u.token));
    const v = r.body.versions?.find((x: { id: string }) => x.id === versionId);
    if (v && statuses.includes(v.status)) return v;
    if (Date.now() - t0 > 15_000) throw new Error(`version stuck: ${v?.status}`);
    await new Promise((res) => setTimeout(res, 100));
  }
}
