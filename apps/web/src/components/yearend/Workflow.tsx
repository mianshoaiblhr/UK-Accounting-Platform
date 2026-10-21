'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorText } from '@/lib/api';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { Notices, YearBar, useYear } from './year';

/** V2-M7a (DEC-071): the 14-step year-end workflow of a year exactly as `year-end-workflow` returns it (DEC-069, DEC-070). */
interface Step {
  step: number; title: string; dependsOn: number[]; state: 'DONE' | 'LAPSED' | 'BLOCKED' | 'TODO' | 'ATTENTION';
  control: { status: 'READY' | 'ATTENTION' | 'NOT_APPLICABLE' | null; summary: string };
  signOffs: { action: 'SIGN_OFF' | 'REOPEN'; note: string | null; byUserId: string; at: string }[];
}
interface Workflow { year: { start: string; end: string }; locked: boolean; fingerprint: string | null; current: number | null; steps: Step[]; notices: string[] }
/** Steps 12 to 14 are done through their own records on the approval screen (DEC-070). */
const OWN_RECORD = [12, 13, 14];

function StepRow({ s, yearStart, locked, onDone }: { s: Step; yearStart: string; locked: boolean; onDone: () => Promise<void> }) {
  const w = useWorkspace();
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const signedOff = s.state === 'DONE' || s.state === 'LAPSED';   // steps 1 to 11: done or lapsed means signed off (the API's state)
  const canAct = w.can('accounts:prepare') && !locked && !OWN_RECORD.includes(s.step);
  async function run(action: 'sign-off' | 'reopen') {
    setBusy(true); setError('');
    try {
      await api(w.path(`/year-end-workflow/${action}`), { body: { yearStart, step: s.step, ...(note.trim() ? { note: note.trim() } : {}) } });
      setNote(''); await onDone();
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <tr data-step={s.step}>
      <td>{s.step}</td>
      <td>{s.title}{s.dependsOn.length > 0 && <div className="muted">after {s.dependsOn.join(', ')}</div>}</td>
      <td data-testid="step-state"><span className="badge">{s.state}</span></td>
      <td><span data-testid="step-control">{s.control.status ?? '-'}</span>: {s.control.summary}</td>
      <td>{s.signOffs.map((x, i) => <div key={i} className="muted">{x.action === 'SIGN_OFF' ? 'Signed off' : 'Reopened'} {x.at.slice(0, 16).replace('T', ' ')}{x.note ? `: ${x.note}` : ''}</div>)}</td>
      <td>
        {OWN_RECORD.includes(s.step) && <Link href={`${w.base}/year-end/approval${qs({ year: yearStart })}`}>Approval</Link>}
        {canAct && (
          <div className="inline-actions">
            <input aria-label={`Note for step ${s.step}`} placeholder={signedOff ? 'Reason (needed to reopen)' : 'Note (optional)'} value={note} onChange={(e) => setNote(e.target.value)} />
            {signedOff ? <button className="secondary" disabled={busy} onClick={() => run('reopen')}>Reopen</button> : <button disabled={busy} onClick={() => run('sign-off')}>Sign off</button>}
            {error && <p className="error" role="alert">{error}</p>}
          </div>
        )}
      </td>
    </tr>
  );
}

export function WorkflowScreen() {
  const w = useWorkspace();
  const { year } = useYear();
  const { data, error, reload } = useApi<Workflow>(year ? w.path(`/year-end-workflow${qs({ yearStart: year.yearStart })}`) : null);
  return (
    <div className="card">
      <YearBar title="Year end" locked={data?.locked} />
      {error && <p className="error" role="alert">{error}</p>}
      {data && year && (
        <>
          <p data-testid="current-step">{data.current ? `Current step: ${data.current} (${data.steps[data.current - 1]!.title})` : 'Every step is done.'}{data.locked ? ' The client approved the accounts; the year is locked.' : ''}</p>
          <table data-testid="workflow">
            <thead><tr><th>#</th><th>Step</th><th>State</th><th>Control</th><th>Sign-offs</th><th>Actions</th></tr></thead>
            <tbody>{data.steps.map((s) => <StepRow key={s.step} s={s} yearStart={year.yearStart} locked={data.locked} onDone={reload} />)}</tbody>
          </table>
          <Notices notices={data.notices} />
        </>
      )}
    </div>
  );
}
