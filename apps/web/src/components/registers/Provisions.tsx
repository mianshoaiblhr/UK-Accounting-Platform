'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Form } from '@/components/Form';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { AccountSelect, Card, Input, ReasonAction, RegistersNav, useAccounts } from './common';

/** V2-M7b (DEC-074): provisions (DEC-059) with their movements, and the movements report for a range, as the API returns them. */
interface Movement { id: string; kind: 'MADE' | 'USED' | 'RELEASED'; date: string; amount: string; reason: string; status: 'POSTED' | 'REVERSED'; reversedReason: string | null }
interface Provision { id: string; name: string; accountId: string; expenseAccountId: string; basis: string; balance: string; movements: Movement[] }
interface Report { from: string; to: string; provisions: { provisionId: string; name: string; opening: string; made: string; used: string; released: string; closing: string }[] }

function MovementForm({ p, onDone }: { p: Provision; onDone: () => Promise<void> }) {
  const w = useWorkspace();
  const [v, setV] = useState({ kind: 'MADE', date: '', amount: '', offsetAccountId: '', reason: '' });
  return (
    <Form submit="Record the movement" success="Movement recorded" onSubmit={async () => {
      await api(w.path(`/provisions/${p.id}/movements`), { body: { kind: v.kind, date: v.date, amount: v.amount.trim(), ...(v.kind === 'USED' ? { offsetAccountId: v.offsetAccountId } : {}), reason: v.reason.trim() } });
      setV({ kind: 'MADE', date: '', amount: '', offsetAccountId: '', reason: '' }); await onDone();
    }}>
      <div className="row">
        <div><label htmlFor={`mv-kind-${p.id}`}>Movement</label><select id={`mv-kind-${p.id}`} value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}><option value="MADE">Made</option><option value="USED">Used</option><option value="RELEASED">Released</option></select></div>
        <Input id={`mv-date-${p.id}`} label="Date" type="date" value={v.date} onChange={(x) => setV({ ...v, date: x })} />
        <Input id={`mv-amount-${p.id}`} label="Amount" value={v.amount} onChange={(x) => setV({ ...v, amount: x })} />
        {v.kind === 'USED' && <AccountSelect id={`mv-offset-${p.id}`} label="Where the actual cost went" value={v.offsetAccountId} onChange={(x) => setV({ ...v, offsetAccountId: x })} />}
      </div>
      <Input id={`mv-reason-${p.id}`} label="Reason" value={v.reason} onChange={(x) => setV({ ...v, reason: x })} />
    </Form>
  );
}

export function ProvisionsScreen() {
  const w = useWorkspace();
  const year = new Date().getUTCFullYear();
  const [range, setRange] = useState({ from: `${year}-01-01`, to: `${year}-12-31` });
  const list = useApi<{ items: Provision[] }>(w.path('/provisions'));
  const report = useApi<Report>(w.path(`/provisions/report${qs(range)}`));
  const { label } = useAccounts();
  const [v, setV] = useState({ name: '', accountId: '', expenseAccountId: '', basis: '' });
  const prepare = w.can('accounts:prepare');
  const reload = async () => { await Promise.all([list.reload(), report.reload()]); };
  return (
    <>
      <div className="card">
        <h1>Provisions</h1>
        <RegistersNav />
        {list.error && <p className="error" role="alert">{list.error}</p>}
        {(list.data?.items ?? []).map((p) => (
          <section key={p.id} data-provision={p.name}>
            <h2>{p.name} <span className="muted">balance</span> <span data-testid="provision-balance">{p.balance}</span></h2>
            <p className="muted">{label(p.accountId)}; expense {label(p.expenseAccountId)}. Basis: {p.basis}</p>
            <table><thead><tr><th>Date</th><th>Movement</th><th className="num">Amount</th><th>Reason</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>{p.movements.map((m) => <tr key={m.id}><td>{m.date}</td><td>{m.kind}</td><td className="num">{m.amount}</td><td>{m.reason}</td><td>{m.status}{m.reversedReason ? `: ${m.reversedReason}` : ''}</td>
                <td>{prepare && m.status === 'POSTED' && <ReasonAction label="Reverse" path={`/provision-movements/${m.id}/reverse`} onDone={reload} />}</td></tr>)}</tbody>
            </table>
            {prepare && <MovementForm p={p} onDone={reload} />}
          </section>
        ))}
        {prepare && (
          <>
            <h3>New provision</h3>
            <Form submit="Create the provision" success="Provision created" onSubmit={async () => {
              await api(w.path('/provisions'), { body: { name: v.name.trim(), accountId: v.accountId, expenseAccountId: v.expenseAccountId, basis: v.basis.trim() } });
              setV({ name: '', accountId: '', expenseAccountId: '', basis: '' }); await reload();
            }}>
              <div className="row">
                <Input id="pv-name" label="Name" value={v.name} onChange={(x) => setV({ ...v, name: x })} />
                <AccountSelect id="pv-account" label="Provision account" value={v.accountId} onChange={(x) => setV({ ...v, accountId: x })} filter={(a) => a.type === 'LIABILITY'} />
                <AccountSelect id="pv-expense" label="Expense account" value={v.expenseAccountId} onChange={(x) => setV({ ...v, expenseAccountId: x })} filter={(a) => a.type === 'EXPENSE'} />
              </div>
              <Input id="pv-basis" label="Basis" value={v.basis} onChange={(x) => setV({ ...v, basis: x })} />
            </Form>
          </>
        )}
      </div>
      <Card title="Movements report" testId="provision-report">
        <div className="row"><Input id="pr-from" label="From" type="date" value={range.from} onChange={(x) => setRange({ ...range, from: x })} /><Input id="pr-to" label="To" type="date" value={range.to} onChange={(x) => setRange({ ...range, to: x })} /></div>
        {report.error && <p className="error" role="alert">{report.error}</p>}
        <table><thead><tr><th>Provision</th><th className="num">Opening</th><th className="num">Made</th><th className="num">Used</th><th className="num">Released</th><th className="num">Closing</th></tr></thead>
          <tbody>{(report.data?.provisions ?? []).map((p) => <tr key={p.provisionId}><td>{p.name}</td><td className="num">{p.opening}</td><td className="num">{p.made}</td><td className="num">{p.used}</td><td className="num">{p.released}</td><td className="num">{p.closing}</td></tr>)}</tbody>
        </table>
      </Card>
    </>
  );
}
