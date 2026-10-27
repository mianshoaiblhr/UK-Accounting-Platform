'use client';
import { useState } from 'react';
import { Form } from '@/components/Form';
import { KIND_NAMES, STATUS_NAMES, StatusPill, periodText, workName, type Obligation } from '@/components/compliance/common';
import { api, errorText } from '@/lib/api';
import { WorkspaceShell, qs, useApi, useWorkspace } from '@/lib/workspace';

/**
 * V7-M1 (DEC-088): one client's deadlines. The list, due dates and the overdue flag are the API's; generation uses only verified rules and the
 * API says what it skipped and why. Changes are sent against the obligation's version; the API decides what needs a reason.
 */
interface Generated { from: string; through: string; created: Obligation[]; existing: number; skipped: { kind: string; anchor: string; reason: string }[]; notApplicable: { kind: string; reason: string }[] }
interface Profile { confirmationDate: string | null }
const WINDOWS: [string, string][] = [['all', 'All'], ['open', 'Open'], ['overdue', 'Overdue'], ['next90', 'Next 90 days']];
const SKIP_REASONS: Record<string, string> = { rule_unverified: 'its deadline rule is not verified yet', no_rule_for_date: 'no deadline rule covers this date' };

function ObligationRow({ o, onDone }: { o: Obligation; onDone: () => Promise<void> }) {
  const w = useWorkspace();
  const [status, setStatus] = useState(o.status);
  const [doneOn, setDoneOn] = useState(o.doneOn ?? '');
  const [reference, setReference] = useState(o.doneReference ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setError('');
    try {
      await api(w.path(`/compliance/obligations/${o.id}`), { method: 'PATCH', body: {
        version: o.version, ...(status !== o.status ? { status } : {}),
        ...(status === 'DONE' ? { ...(doneOn ? { doneOn } : {}), ...(reference.trim() && reference.trim() !== (o.doneReference ?? '') ? { doneReference: reference.trim() } : {}) } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      } });
      setReason(''); await onDone();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <tr data-obligation={o.id}>
      <td>{workName(o)}{o.source === 'MANUAL' && <span className="muted"> (entered by hand)</span>}</td>
      <td>{periodText(o)}</td>
      <td>{o.dueDate}</td>
      <td><StatusPill o={o} />{o.doneOn && <div className="muted">Done {o.doneOn}{o.doneReference ? `, ${o.doneReference}` : ''}</div>}</td>
      {w.can('compliance:manage') && (
        <td>
          <div className="inline-actions">
            <select aria-label={`Status of ${workName(o)} due ${o.dueDate}`} value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto', height: 32 }}>
              {Object.entries(STATUS_NAMES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            {status === 'DONE' && <input type="date" aria-label={`Done on, ${workName(o)} due ${o.dueDate}`} value={doneOn} onChange={(e) => setDoneOn(e.target.value)} />}
            {status === 'DONE' && <input aria-label={`Reference, ${workName(o)} due ${o.dueDate}`} placeholder="Reference (optional)" value={reference} onChange={(e) => setReference(e.target.value)} />}
            <input aria-label={`Reason, ${workName(o)} due ${o.dueDate}`} placeholder="Reason (when the API asks for one)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <button disabled={busy} onClick={save}>Save</button>
            {error && <p className="error" role="alert">{error}</p>}
          </div>
        </td>
      )}
    </tr>
  );
}

function Deadlines() {
  const w = useWorkspace();
  const [due, setDue] = useState('all');
  const list = useApi<{ today: string; items: Obligation[] }>(w.path(`/compliance/obligations${qs({ due })}`));
  const profile = useApi<Profile>(w.path('/compliance/profile'));
  const manage = w.can('compliance:manage');
  const [through, setThrough] = useState('');
  const [from, setFrom] = useState('');
  const [result, setResult] = useState<Generated>();
  const [confirmation, setConfirmation] = useState('');
  const [profileReason, setProfileReason] = useState('');
  const [kind, setKind] = useState('OTHER');
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [manualReason, setManualReason] = useState('');

  return (
    <>
      <div className="card">
        <h1>Deadlines</h1>
        <nav className="subnav" aria-label="Which deadlines">
          {WINDOWS.map(([v, l]) => v === due ? <span key={v} aria-current="page">{l}</span> : <a key={v} href="#" onClick={(e) => { e.preventDefault(); setDue(v); }}>{l}</a>)}
        </nav>
        {list.error && <p className="error" role="alert">{list.error}</p>}
        {list.data && (list.data.items.length === 0 ? <p className="muted">No deadlines here yet. {manage ? 'Create them from the verified deadline rules below, or enter one by hand.' : ''}</p> : (
          <table data-testid="obligations">
            <thead><tr><th>Work</th><th>Period</th><th>Due</th><th>Status</th>{manage && <th>Change</th>}</tr></thead>
            <tbody>{list.data.items.map((o) => <ObligationRow key={`${o.id}-${o.version}`} o={o} onDone={list.reload} />)}</tbody>
          </table>
        ))}
      </div>

      {manage && (
        <div className="card">
          <h2>Create deadlines from the rules</h2>
          <p className="muted">Uses only deadline rules a second person has verified, for this client&apos;s accounting periods, VAT periods and confirmation dates. Running it again creates only what is missing.</p>
          <Form submit="Create deadlines" onSubmit={async () => {
            const r = await api<Generated>(w.path('/compliance/generate'), { body: { through, ...(from ? { from } : {}) }, idempotencyKey: crypto.randomUUID() });
            setResult(r); await list.reload();
            return `${r.created.length} created, ${r.existing} already there.`;
          }}>
            <div className="row">
              <div><label htmlFor="genFrom">From (optional)</label><input id="genFrom" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
              <div><label htmlFor="genThrough">Through</label><input id="genThrough" type="date" required value={through} onChange={(e) => setThrough(e.target.value)} /></div>
            </div>
          </Form>
          {result && (result.skipped.length > 0 || result.notApplicable.length > 0) && (
            <div data-testid="generation-notes">
              {result.skipped.length > 0 && <><h3>Not created</h3><ul>{result.skipped.map((x) => <li key={`${x.kind}-${x.anchor}`}>{KIND_NAMES[x.kind]} for {x.anchor}: {SKIP_REASONS[x.reason] ?? x.reason}</li>)}</ul></>}
              {result.notApplicable.length > 0 && <><h3>Not applicable</h3><ul>{result.notApplicable.map((x) => <li key={x.kind}>{KIND_NAMES[x.kind]}: {x.reason}</li>)}</ul></>}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <h2>Confirmation statement</h2>
        {profile.error && <p className="error" role="alert">{profile.error}</p>}
        {profile.data && <p>Confirmation date: <strong data-testid="confirmation-date">{profile.data.confirmationDate ?? 'not set'}</strong></p>}
        {manage && (
          <Form submit="Set the confirmation date" success="Saved." onSubmit={async () => {
            await api(w.path('/compliance/profile'), { method: 'PUT', body: { confirmationDate: confirmation || null, reason: profileReason } });
            setProfileReason(''); await profile.reload();
          }}>
            <div className="row">
              <div><label htmlFor="confirmationDate">Confirmation date</label><input id="confirmationDate" type="date" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></div>
              <div><label htmlFor="profileReason">Reason</label><input id="profileReason" required value={profileReason} onChange={(e) => setProfileReason(e.target.value)} /></div>
            </div>
          </Form>
        )}
      </div>

      {manage && (
        <div className="card">
          <h2>Enter a deadline by hand</h2>
          <p className="muted">For an internal deadline, a first-accounts date or an extension that no rule produces.</p>
          <Form submit="Add the deadline" success="Added." onSubmit={async () => {
            await api(w.path('/compliance/obligations'), { body: { kind, ...(title.trim() ? { title: title.trim() } : {}), dueDate, reason: manualReason }, idempotencyKey: crypto.randomUUID() });
            setTitle(''); setDueDate(''); setManualReason(''); await list.reload();
          }}>
            <div className="row">
              <div><label htmlFor="manualKind">Kind</label>
                <select id="manualKind" value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(KIND_NAMES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
              <div><label htmlFor="manualTitle">Title</label><input id="manualTitle" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
              <div><label htmlFor="manualDue">Due</label><input id="manualDue" type="date" required value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
            </div>
            <label htmlFor="manualReason">Why it is entered by hand</label>
            <input id="manualReason" required value={manualReason} onChange={(e) => setManualReason(e.target.value)} />
          </Form>
        </div>
      )}
    </>
  );
}

export default function Page() { return <WorkspaceShell need="compliance:read" feature="practice.management"><Deadlines /></WorkspaceShell>; }
