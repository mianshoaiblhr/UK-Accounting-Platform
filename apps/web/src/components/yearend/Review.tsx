'use client';
import { useState } from 'react';
import { api, errorText } from '@/lib/api';
import { Form } from '@/components/Form';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { Figures, Notices, YearBar, useYear } from './year';

/** V2-M7a (DEC-071): the review checklist (DEC-068) and the firm's review settings, as the API returns them. */
interface Response { action: 'EXPLAIN' | 'SIGN_OFF' | 'REOPEN'; note: string | null; byUserId: string; at: string }
interface Flag { key: string; subject: { type: string; label: string }; figures: Record<string, unknown>; state: 'OPEN' | 'EXPLAINED' | 'SIGNED_OFF'; changedSinceResponse: boolean; responses: Response[] }
interface Control { code: string; title: string; status: string; needs: string[]; counts: { open: number; explained: number; signedOff: number }; flags: Flag[] }
interface Checklist { complete: boolean; controls: Control[]; notices: string[] }
interface SettingsRow { unexplainedAmount: string | null; materialAmount: string | null; materialPercent: string | null; oldItemDays: number | null; evidenceAmount: string | null; reason: string; setAt: string }

function FlagRow({ f, yearStart, onDone }: { f: Flag; yearStart: string; onDone: () => Promise<void> }) {
  const w = useWorkspace();
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // which actions to offer follows the flag's state from the API; the API decides whether each is allowed
  const actions = [
    ...(f.state !== 'SIGNED_OFF' && w.can('accounts:prepare') ? [{ path: 'explain', label: 'Explain' }] : []),
    ...(f.state === 'EXPLAINED' && w.can('accounts:review') ? [{ path: 'sign-off', label: 'Sign off' }] : []),
    ...(f.state !== 'OPEN' && w.can('accounts:review') ? [{ path: 'reopen', label: 'Reopen' }] : []),
  ];
  async function run(path: string) {
    setBusy(true); setError('');
    try { await api(w.path(`/review-flags/${path}`), { body: { yearStart, flagKey: f.key, ...(note.trim() ? { note: note.trim() } : {}) } }); setNote(''); await onDone(); }
    catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <tr data-flag={f.key}>
      <td>{f.subject.label}</td>
      <td><Figures figures={f.figures} /></td>
      <td data-testid="flag-state"><span className="badge">{f.state}</span>{f.changedSinceResponse && <div className="error">The figures changed since the last response</div>}</td>
      <td>{f.responses.map((r, i) => <div key={i} className="muted">{r.action} {r.at.slice(0, 16).replace('T', ' ')}{r.note ? `: ${r.note}` : ''}</div>)}</td>
      <td>
        {actions.length > 0 && (
          <div className="inline-actions">
            <input aria-label={`Note for ${f.subject.label}`} placeholder="Explanation or reason" value={note} onChange={(e) => setNote(e.target.value)} />
            {actions.map((a) => <button key={a.path} className={a.path === 'reopen' ? 'secondary' : undefined} disabled={busy} onClick={() => run(a.path)}>{a.label}</button>)}
            {error && <p className="error" role="alert">{error}</p>}
          </div>
        )}
      </td>
    </tr>
  );
}

const SETTING_FIELDS = [
  { key: 'unexplainedAmount', label: 'Unexplained movement above' },
  { key: 'materialAmount', label: 'Material change above (amount)' },
  { key: 'materialPercent', label: 'Material change above (percentage)' },
  { key: 'oldItemDays', label: 'Old items after (30, 60 or 90 days)' },
  { key: 'evidenceAmount', label: 'Evidence needed above' },
] as const;

function Settings() {
  const w = useWorkspace();
  const { data, error, reload } = useApi<{ current: SettingsRow | null; notice: string }>(w.path('/review-settings'));
  const [v, setV] = useState<Record<string, string>>({});
  return (
    <div className="card" data-testid="review-settings">
      <h2>Review settings</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (
        <>
          <p className="muted">{data.notice}</p>
          <table>
            <tbody>{SETTING_FIELDS.map((f) => <tr key={f.key}><td>{f.label}</td><td className="num">{data.current?.[f.key] ?? 'not set'}</td></tr>)}</tbody>
          </table>
          {w.can('accounts:prepare') && (
            <Form submit="Save settings" success="Settings saved" onSubmit={async () => {
              const body: Record<string, unknown> = { reason: v.reason ?? '' };
              for (const f of SETTING_FIELDS) if (v[f.key]?.trim()) body[f.key] = f.key === 'oldItemDays' ? Number(v[f.key]) : v[f.key]!.trim();
              await api(w.path('/review-settings'), { body }); setV({}); await reload();
            }}>
              <div className="row">{SETTING_FIELDS.map((f) => (
                <div key={f.key}><label htmlFor={`set-${f.key}`}>{f.label}</label><input id={`set-${f.key}`} value={v[f.key] ?? ''} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} /></div>
              ))}</div>
              <label htmlFor="set-reason">Reason</label><input id="set-reason" value={v.reason ?? ''} onChange={(e) => setV({ ...v, reason: e.target.value })} required />
            </Form>
          )}
        </>
      )}
    </div>
  );
}

export function ReviewScreen() {
  const w = useWorkspace();
  const { year } = useYear();
  const { data, error, reload } = useApi<Checklist>(year ? w.path(`/review-checklist${qs({ yearStart: year.yearStart })}`) : null);
  return (
    <>
      <div className="card">
        <YearBar title="Review checklist" />
        {error && <p className="error" role="alert">{error}</p>}
        {data && year && (
          <>
            <p data-testid="checklist-complete">{data.complete ? 'The checklist is complete: every control evaluated and every flag signed off.' : 'The checklist is not complete.'}</p>
            {data.controls.map((c) => (
              <section key={c.code} data-control={c.code}>
                <h2>{c.code} {c.title} <span className="badge" data-testid="control-status">{c.status}</span></h2>
                {c.needs.length > 0 && <p className="muted">{c.needs.join('; ')}</p>}
                {c.flags.length > 0 && (
                  <table>
                    <thead><tr><th>Subject</th><th>Figures</th><th>State</th><th>Responses</th><th>Actions</th></tr></thead>
                    <tbody>{c.flags.map((f) => <FlagRow key={f.key} f={f} yearStart={year.yearStart} onDone={reload} />)}</tbody>
                  </table>
                )}
              </section>
            ))}
            <Notices notices={data.notices} />
          </>
        )}
      </div>
      <Settings />
    </>
  );
}
