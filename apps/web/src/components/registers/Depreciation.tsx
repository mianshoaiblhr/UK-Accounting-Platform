'use client';
import { useState } from 'react';
import { api, errorText } from '@/lib/api';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { Card, Input, ReasonAction, RegistersNav, today } from './common';

/** V2-M7b (DEC-074): depreciation runs (DEC-058) - the preview the API computes as at a date, posting it, the runs and their reversal. */
interface Preview { asAt: string; total: string; lines: { assetId: string; number: number; description: string; classCode: string; amount: string; accumulatedAfter: string; carryingAfter: string }[] }
interface Run { id: string; asAt: string; status: 'POSTED' | 'REVERSED'; total: string; reversedReason: string | null; createdAt: string }

export function DepreciationScreen() {
  const w = useWorkspace();
  const [asAt, setAsAt] = useState(today());
  const preview = useApi<Preview>(w.path(`/depreciation-runs/preview${qs({ asAt })}`));
  const runs = useApi<{ items: Run[] }>(w.path('/depreciation-runs'));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const manage = w.can('assets:manage');
  const reload = async () => { await Promise.all([preview.reload(), runs.reload()]); };
  const p = preview.data;
  return (
    <>
      <div className="card">
        <h1>Depreciation</h1>
        <RegistersNav />
        <div className="row"><Input id="dep-asat" label="Depreciate to" type="date" value={asAt} onChange={setAsAt} /></div>
        {preview.error && <p className="error" role="alert">{preview.error}</p>}
        {p && (
          <div data-testid="dep-preview">
            <p>Charge to {p.asAt}: <strong data-testid="dep-total">{p.total}</strong></p>
            <table><thead><tr><th>#</th><th>Asset</th><th>Class</th><th className="num">Charge</th><th className="num">Accumulated after</th><th className="num">Carrying after</th></tr></thead>
              <tbody>{p.lines.map((l) => <tr key={l.assetId}><td>{l.number}</td><td>{l.description}</td><td>{l.classCode}</td><td className="num">{l.amount}</td><td className="num">{l.accumulatedAfter}</td><td className="num">{l.carryingAfter}</td></tr>)}</tbody>
            </table>
            {manage && p.lines.length > 0 && <button disabled={busy} onClick={async () => {
              setBusy(true); setError('');
              try { await api(w.path('/depreciation-runs'), { body: { asAt: p.asAt } }); await reload(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
            }}>Post the run</button>}
            {error && <p className="error" role="alert">{error}</p>}
          </div>
        )}
      </div>
      <Card title="Runs" testId="dep-runs">
        {runs.error && <p className="error" role="alert">{runs.error}</p>}
        <table><thead><tr><th>As at</th><th className="num">Total</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{(runs.data?.items ?? []).map((r) => (
            <tr key={r.id} data-run={r.asAt}><td>{r.asAt}</td><td className="num">{r.total}</td><td data-testid="run-status">{r.status}{r.reversedReason ? `: ${r.reversedReason}` : ''}</td>
              <td>{manage && r.status === 'POSTED' && <ReasonAction label="Reverse" path={`/depreciation-runs/${r.id}/reverse`} onDone={reload} />}</td></tr>
          ))}</tbody>
        </table>
      </Card>
    </>
  );
}
