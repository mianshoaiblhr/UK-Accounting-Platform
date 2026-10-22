'use client';
import { useState } from 'react';
import { api, errorText } from '@/lib/api';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { Card, Input, ReasonAction, RegistersNav } from './common';

/** V2-M7b (DEC-074): the year-end closing journal (DEC-060) - the API's preview for a year, posting it, the closes and their reversal. */
interface Preview { yearStart: string; yearEnd: string; journalDate: string; profit: string; lines: { accountId: string; code: string; name: string; debit: string; credit: string }[];
  warnings: string[]; canPost: boolean; blockers: { code: string; message: string }[]; notice: string }
interface Close { id: string; yearStart: string; yearEnd: string; status: 'POSTED' | 'REVERSED'; profit: string; reversedReason: string | null }

export function CloseScreen() {
  const w = useWorkspace();
  const { data: frameworks } = useApi<{ items: { yearStart: string; yearEnd: string }[] }>(w.path('/reporting-frameworks'));
  const [year, setYear] = useState({ yearStart: '', yearEnd: '' });
  const chosen = year.yearStart ? year : frameworks?.items.at(-1) ?? null;
  const preview = useApi<Preview>(chosen?.yearStart && chosen.yearEnd ? w.path(`/year-end-closes/preview${qs({ yearStart: chosen.yearStart, yearEnd: chosen.yearEnd })}`) : null);
  const closes = useApi<{ items: Close[] }>(w.path('/year-end-closes'));
  const [error, setError] = useState('');
  const prepare = w.can('accounts:prepare');
  const reload = async () => { await Promise.all([preview.reload(), closes.reload()]); };
  const p = preview.data;
  return (
    <>
      <div className="card">
        <h1>Closing journal</h1>
        <RegistersNav />
        <div className="row">
          <Input id="cl-start" label="Year start" type="date" value={chosen?.yearStart ?? ''} onChange={(x) => setYear({ yearStart: x, yearEnd: chosen?.yearEnd ?? '' })} />
          <Input id="cl-end" label="Year end" type="date" value={chosen?.yearEnd ?? ''} onChange={(x) => setYear({ yearStart: chosen?.yearStart ?? '', yearEnd: x })} />
        </div>
        {preview.error && <p className="error" role="alert">{preview.error}</p>}
        {p && (
          <div data-testid="close-preview">
            <p>Profit for the year transferred to retained earnings on {p.journalDate}: <strong data-testid="close-profit">{p.profit}</strong></p>
            <table><thead><tr><th>Account</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
              <tbody>{p.lines.map((l) => <tr key={l.accountId}><td>{l.code} {l.name}</td><td className="num">{l.debit}</td><td className="num">{l.credit}</td></tr>)}</tbody>
            </table>
            {p.warnings.map((x) => <p key={x} className="muted">Warning: {x.replace(/_/g, ' ')}</p>)}
            {p.blockers.map((b) => <p key={b.code} className="error" data-testid="close-blocker">{b.message}</p>)}
            <p className="muted">{p.notice}</p>
            {prepare && p.canPost && <button onClick={async () => { setError(''); try { await api(w.path('/year-end-closes'), { body: { yearStart: p.yearStart, yearEnd: p.yearEnd } }); await reload(); } catch (e) { setError(errorText(e)); } }}>Post the closing journal</button>}
            {error && <p className="error" role="alert">{error}</p>}
          </div>
        )}
      </div>
      <Card title="Closes" testId="closes">
        {closes.error && <p className="error" role="alert">{closes.error}</p>}
        <table><thead><tr><th>Year</th><th className="num">Profit</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{(closes.data?.items ?? []).map((c) => <tr key={c.id} data-close={c.yearStart}><td>{c.yearStart} to {c.yearEnd}</td><td className="num">{c.profit}</td><td data-testid="close-status">{c.status}{c.reversedReason ? `: ${c.reversedReason}` : ''}</td>
            <td>{prepare && c.status === 'POSTED' && <ReasonAction label="Reverse" path={`/year-end-closes/${c.id}/reverse`} onDone={reload} />}</td></tr>)}</tbody>
        </table>
      </Card>
    </>
  );
}
