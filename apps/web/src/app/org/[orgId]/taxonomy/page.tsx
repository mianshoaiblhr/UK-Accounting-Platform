'use client';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Form } from '@/components/Form';
import { PracticeShell } from '@/components/PracticeShell';
import { ApiError, api, errorText } from '@/lib/api';

/**
 * V3-M4 (DEC-096): the practice's taxonomy versions and their concept maps (DEC-093), as the API returns them, with verification for a holder
 * of ixbrl:rule-verify. Entries are entered with the import tool or the API; this page reads them. Problems and every refusal are the API's.
 */
interface Summary { id: string; label: string; standardCode: string; effectiveFrom: string; effectiveTo: string | null; status: string }
interface Entry { id: string; sourceKind: string; sourceKey: string; concept: string; dataType: string; periodType: string; negate: boolean; decimals: number | null; dimensions: { axis: string; member: string }[]; mandatory: boolean }
interface Version extends Summary { entryPoint: string; entityScheme: string | null; namespaces: Record<string, string>; source: { url: string; provision: string; retrievedOn: string }; entries: Entry[]; problems: string[]; verifiedByUserId: string | null; createdByUserId: string }

function VersionView({ orgId, id, mayVerify, onChange }: { orgId: string; id: string; mayVerify: boolean; onChange: () => Promise<void> }) {
  const [v, setV] = useState<Version>();
  const [error, setError] = useState('');
  const [notes, setNotes] = useState('');
  const load = useCallback(async () => { try { setV(await api<Version>(`/organisations/${orgId}/ixbrl/taxonomy-versions/${id}`)); } catch (e) { setError(errorText(e)); } }, [orgId, id]);
  useEffect(() => { void load(); }, [load]);
  if (error) return <p className="error" role="alert">{error}</p>;
  if (!v) return <p>Loading…</p>;
  return (
    <div className="card" data-testid="taxonomy-version">
      <h2>{v.label}</h2>
      <p><span className={`badge ${v.status === 'VERIFIED' ? 'status-DONE' : ''}`} data-testid="version-status">{v.status}</span> {v.standardCode}, from {v.effectiveFrom}{v.effectiveTo ? ` to ${v.effectiveTo}` : ''}</p>
      <p className="muted">Entry point <code>{v.entryPoint}</code>. Entity scheme {v.entityScheme ? <code>{v.entityScheme}</code> : 'not set'}. Source: {v.source.provision} (<a href={v.source.url} target="_blank" rel="noreferrer">link</a>, read {v.source.retrievedOn}).</p>
      <p className="muted">Namespaces: {Object.entries(v.namespaces).map(([p, u]) => `${p} = ${u}`).join('; ')}</p>
      {v.problems.length > 0 && <><h3>What stops verification</h3><ul className="error" data-testid="version-problems">{v.problems.map((p) => <li key={p}>{p}</li>)}</ul></>}
      <table data-testid="version-entries">
        <thead><tr><th>Source</th><th>Concept</th><th>Type</th><th>Period</th><th>Decimals</th><th>Dimensions</th><th>Mandatory</th></tr></thead>
        <tbody>{v.entries.map((e) => (
          <tr key={e.id}><td>{e.sourceKind} {e.sourceKey}</td><td><code>{e.concept}</code>{e.negate ? ' (negated)' : ''}</td><td>{e.dataType}</td><td>{e.periodType}</td><td className="num">{e.decimals ?? ''}</td>
            <td>{e.dimensions.map((d) => `${d.axis} = ${d.member}`).join('; ')}</td><td>{e.mandatory ? 'yes' : ''}</td></tr>
        ))}</tbody>
      </table>
      {mayVerify && v.status === 'UNVERIFIED' && (
        <Form submit="Verify this version" onSubmit={async () => {
          await api(`/organisations/${orgId}/ixbrl/taxonomy-versions/${id}/verify`, { body: { notes }, idempotencyKey: crypto.randomUUID() });
          setNotes(''); await load(); await onChange();
          return 'Verified: the version is now frozen';
        }}>
          <label htmlFor="verify-notes">What you checked against the taxonomy</label>
          <input id="verify-notes" required value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Form>
      )}
    </div>
  );
}

function Taxonomy() {
  const { orgId } = useParams<{ orgId: string }>();
  const [list, setList] = useState<Summary[]>();
  const [error, setError] = useState<{ text: string; off: boolean }>();
  const [open, setOpen] = useState<string>();
  const [mayVerify, setMayVerify] = useState(false);
  const load = useCallback(async () => {
    try {
      const [l, me] = await Promise.all([api<{ items: Summary[] }>(`/organisations/${orgId}/ixbrl/taxonomy-versions`), api<{ permissions: string[] }>(`/organisations/${orgId}/me`)]);
      setList(l.items); setMayVerify(me.permissions.includes('ixbrl:rule-verify'));
    } catch (e) { setError({ text: errorText(e), off: e instanceof ApiError && e.code === 'feature_disabled' }); }
  }, [orgId]);
  useEffect(() => { void load(); }, [load]);
  return (
    <>
      <h1>Taxonomy mapping</h1>
      <p className="muted">Which taxonomy concept tags each line of the accounts, for iXBRL filing. A version is used only once someone other than its author has verified it against the taxonomy.</p>
      {error && (error.off ? <div className="card" role="status" data-testid="feature-off"><h2>Accounts filing is not enabled</h2><p>An owner can turn on the &quot;ixbrl.filing&quot; feature.</p></div>
        : <p className="error" role="alert">{error.text}</p>)}
      {list && (list.length === 0 ? <p className="muted">No taxonomy version yet. Import the draft mapping with scripts/ixbrl/import-taxonomy.mjs.</p> : (
        <div className="card">
          <table data-testid="taxonomy-versions">
            <thead><tr><th>Version</th><th>Standard</th><th>Effective</th><th>Status</th></tr></thead>
            <tbody>{list.map((v) => (
              <tr key={v.id}><td><a href="#" onClick={(e) => { e.preventDefault(); setOpen(v.id); }}>{v.label}</a></td><td>{v.standardCode}</td><td className="date">{v.effectiveFrom}{v.effectiveTo ? ` to ${v.effectiveTo}` : ''}</td><td>{v.status}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ))}
      {open && <VersionView key={open} orgId={orgId} id={open} mayVerify={mayVerify} onChange={load} />}
    </>
  );
}

export default function Page() { return <PracticeShell>{() => <Taxonomy />}</PracticeShell>; }
