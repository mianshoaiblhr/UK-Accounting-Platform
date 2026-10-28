#!/usr/bin/env node
/**
 * Imports the draft Corporation Tax rules (content/tax/drafts/uk-ct-rules.json, DEC-097) through the public API, as the person whose token is used
 * (they need ct:manage on the company named). Every rule lands UNVERIFIED: this tool never verifies anything. A holder of tax:rule-verify who is
 * not the importer checks each rule against its source and verifies it in the platform.
 *
 *   node scripts/tax/import-ct-rules.mjs --api https://host/api/v1 --org <organisationId> --company <companyId> --token <bearer> <rules.json>
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** `call(method, path, body)` sends a request under /organisations/:org/companies/:company and resolves to { status, body }. */
export async function importCtRules(call, pack) {
  const out = [];
  for (const { verifierNote: _note, ...rule } of pack.rules) {
    // the note for the verifier stays in the pack and the worksheet; the platform stores the rule and its source
    const r = await call('post', '/ct-rules', rule);
    if (r.status !== 201) throw new Error(`rule ${rule.kind} from ${rule.effectiveFrom}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
    out.push({ id: r.body.id, kind: r.body.kind, effectiveFrom: r.body.effectiveFrom, verificationStatus: r.body.verificationStatus });
  }
  return { rules: out };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const [api, org, company, token, file] = [arg('api'), arg('org'), arg('company'), arg('token'), process.argv.at(-1)];
  if (!api || !org || !company || !token || !file || file.startsWith('--')) { console.error('usage: import-ct-rules.mjs --api <url> --org <id> --company <id> --token <bearer> <rules.json>'); process.exit(2); }
  const call = async (method, path, body) => {
    const r = await fetch(`${api}/organisations/${org}/companies/${company}${path}`, { method: method.toUpperCase(), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  console.log(JSON.stringify(await importCtRules(call, JSON.parse(readFileSync(file, 'utf8'))), null, 2));
}
