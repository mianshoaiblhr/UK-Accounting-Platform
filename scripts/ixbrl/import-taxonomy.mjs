#!/usr/bin/env node
/**
 * Imports a draft taxonomy mapping (content/ixbrl/drafts/*.json, DEC-093) through the public API, as the person whose token is used (they need
 * ixbrl:rules-manage). The version lands UNVERIFIED: this tool never verifies anything. A holder of ixbrl:rule-verify who is not the importer
 * checks every entry against the taxonomy and verifies the version in the platform.
 *
 *   node scripts/ixbrl/import-taxonomy.mjs --api https://host/api/v1 --org <organisationId> --token <bearer> <mapping.json>
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** `call(method, path, body)` sends a request under /organisations/:org/ixbrl and resolves to { status, body }. */
export async function importTaxonomy(call, pack) {
  const must = async (what, method, path, body, expect = [200, 201]) => {
    const r = await call(method, path, body);
    if (!expect.includes(r.status)) throw new Error(`${what}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const version = await must('create version', 'post', '/taxonomy-versions', pack.version);
  // the note for the verifier stays in the pack and the worksheet; the platform stores the mapping
  for (const { verifierNote: _note, ...e } of pack.entries) await must(`entry ${e.sourceKind} ${e.sourceKey}`, 'post', `/taxonomy-versions/${version.id}/entries`, e);
  const back = await must('read back', 'get', `/taxonomy-versions/${version.id}`);
  return { versionId: back.id, status: back.status, entries: back.entries.length, problems: back.problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const [api, org, token, file] = [arg('api'), arg('org'), arg('token'), process.argv.at(-1)];
  if (!api || !org || !token || !file || file.startsWith('--')) { console.error('usage: import-taxonomy.mjs --api <url> --org <id> --token <bearer> <mapping.json>'); process.exit(2); }
  const call = async (method, path, body) => {
    const r = await fetch(`${api}/organisations/${org}/ixbrl${path}`, { method: method.toUpperCase(), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  console.log(JSON.stringify(await importTaxonomy(call, JSON.parse(readFileSync(file, 'utf8'))), null, 2));
}
