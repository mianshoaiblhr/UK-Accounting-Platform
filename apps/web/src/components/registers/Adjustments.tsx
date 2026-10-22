'use client';
import { useState } from 'react';
import { api, errorText } from '@/lib/api';
import { Form } from '@/components/Form';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { AccountSelect, Card, Input, ReasonAction, Reconciliation, RegistersNav, today, useAccounts } from './common';

/**
 * V2-M7b (DEC-074): year-end adjustments (DEC-059) - accruals, accrued income, prepayments, deferred income - their release runs and the
 * year-end register, as the API returns them.
 */
interface Item { id: string; kind: string; description: string; amount: string; date: string; periodStart: string | null; periodEnd: string | null; status: 'ACTIVE' | 'CANCELLED'; plAccountId: string; balanceAccountId: string; released?: string; unreleased?: string }
interface Preview { asAt: string; total: string; lines: { itemId: string; kind: string; description: string; amount: string; releasedAfter: string; unreleasedAfter: string }[] }
interface Run { id: string; asAt: string; status: 'POSTED' | 'REVERSED'; total: string; reversedReason: string | null }
interface Register { asAt: string; reconciled: boolean; items: { id: string; kind: string; description: string; balance: string }[]; provisions: { id: string; name: string; balance: string }[];
  reconciliation: { code: string; register: string; ledger: string; difference: string; reconciled: boolean }[] }
const KINDS = [
  { kind: 'ACCRUAL', label: 'Accrual (expense not yet invoiced)' }, { kind: 'ACCRUED_INCOME', label: 'Accrued income' },
  { kind: 'PREPAYMENT', label: 'Prepayment (released over a period)' }, { kind: 'DEFERRED_INCOME', label: 'Deferred income (released over a period)' },
];

function ItemForm({ onDone }: { onDone: () => Promise<void> }) {
  const w = useWorkspace();
  const [v, setV] = useState({ kind: 'ACCRUAL', description: '', amount: '', date: '', plAccountId: '', balanceAccountId: '', periodStart: '', periodEnd: '', convention: 'MONTHLY', basis: '' });
  const set = (k: string) => (x: string) => setV({ ...v, [k]: x });
  const overPeriod = v.kind === 'PREPAYMENT' || v.kind === 'DEFERRED_INCOME';
  return (
    <Form submit="Create the item" success="Item created" onSubmit={async () => {
      await api(w.path('/year-end-items'), { body: { kind: v.kind, description: v.description.trim(), amount: v.amount.trim(), date: v.date, plAccountId: v.plAccountId, balanceAccountId: v.balanceAccountId,
        ...(v.basis.trim() ? { basis: v.basis.trim() } : {}), ...(overPeriod ? { periodStart: v.periodStart, periodEnd: v.periodEnd, convention: v.convention, setup: { kind: 'POSTED' } } : {}) } });
      await onDone();
    }}>
      <div className="row">
        <div><label htmlFor="ye-kind">Kind</label><select id="ye-kind" value={v.kind} onChange={(e) => set('kind')(e.target.value)}>{KINDS.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select></div>
        <Input id="ye-desc" label="Description" value={v.description} onChange={set('description')} />
        <Input id="ye-amount" label="Amount" value={v.amount} onChange={set('amount')} />
        <Input id="ye-date" label="Date" type="date" value={v.date} onChange={set('date')} />
      </div>
      <div className="row">
        <AccountSelect id="ye-pl" label="Profit and loss account" value={v.plAccountId} onChange={set('plAccountId')} filter={(a) => a.type === 'EXPENSE' || a.type === 'INCOME'} />
        <AccountSelect id="ye-bal" label="Balance sheet account" value={v.balanceAccountId} onChange={set('balanceAccountId')} filter={(a) => a.type === 'ASSET' || a.type === 'LIABILITY'} />
      </div>
      {overPeriod && (
        <div className="row">
          <Input id="ye-from" label="Period from" type="date" value={v.periodStart} onChange={set('periodStart')} />
          <Input id="ye-to" label="Period to" type="date" value={v.periodEnd} onChange={set('periodEnd')} />
          <div><label htmlFor="ye-conv">Released</label><select id="ye-conv" value={v.convention} onChange={(e) => set('convention')(e.target.value)}><option value="MONTHLY">Monthly</option><option value="DAILY">Daily</option></select></div>
        </div>
      )}
      <Input id="ye-basis" label="Basis (optional)" value={v.basis} onChange={set('basis')} required={false} />
    </Form>
  );
}

export function AdjustmentsScreen() {
  const w = useWorkspace();
  const [asAt, setAsAt] = useState(today());
  const items = useApi<{ items: Item[] }>(w.path('/year-end-items'));
  const preview = useApi<Preview>(w.path(`/release-runs/preview${qs({ asAt })}`));
  const runs = useApi<{ items: Run[] }>(w.path('/release-runs'));
  const register = useApi<Register>(w.path(`/year-end-register${qs({ asAt })}`));
  const { label } = useAccounts();
  const [error, setError] = useState('');
  const prepare = w.can('accounts:prepare');
  const reload = async () => { await Promise.all([items.reload(), preview.reload(), runs.reload(), register.reload()]); };
  return (
    <>
      <div className="card">
        <h1>Year-end adjustments</h1>
        <RegistersNav />
        {items.error && <p className="error" role="alert">{items.error}</p>}
        <table data-testid="ye-items"><thead><tr><th>Kind</th><th>Description</th><th>Date / period</th><th className="num">Amount</th><th className="num">Released</th><th>Accounts</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{(items.data?.items ?? []).map((i) => (
            <tr key={i.id} data-item={i.description}><td>{i.kind}</td><td>{i.description}</td><td>{i.date}{i.periodStart ? ` (${i.periodStart} to ${i.periodEnd})` : ''}</td><td className="num">{i.amount}</td><td className="num">{i.released ?? ''}</td>
              <td>{label(i.plAccountId)} / {label(i.balanceAccountId)}</td><td>{i.status}</td>
              <td>{prepare && i.status === 'ACTIVE' && <ReasonAction label="Cancel" path={`/year-end-items/${i.id}/cancel`} onDone={reload} />}</td></tr>
          ))}</tbody>
        </table>
        {prepare && <><h3>New item</h3><ItemForm onDone={reload} /></>}
      </div>
      <Card title="Release runs" testId="release">
        <div className="row"><Input id="rel-asat" label="Release to" type="date" value={asAt} onChange={setAsAt} /></div>
        {preview.error && <p className="error" role="alert">{preview.error}</p>}
        {preview.data && (
          <>
            <p>To release to {preview.data.asAt}: <strong data-testid="release-total">{preview.data.total}</strong></p>
            <table><thead><tr><th>Item</th><th className="num">This run</th><th className="num">Released after</th><th className="num">Unreleased after</th></tr></thead>
              <tbody>{preview.data.lines.map((l) => <tr key={l.itemId}><td>{l.description}</td><td className="num">{l.amount}</td><td className="num">{l.releasedAfter}</td><td className="num">{l.unreleasedAfter}</td></tr>)}</tbody>
            </table>
            {prepare && preview.data.lines.length > 0 && <button onClick={async () => { setError(''); try { await api(w.path('/release-runs'), { body: { asAt: preview.data!.asAt } }); await reload(); } catch (e) { setError(errorText(e)); } }}>Post the release run</button>}
            {error && <p className="error" role="alert">{error}</p>}
          </>
        )}
        <table data-testid="release-runs"><thead><tr><th>As at</th><th className="num">Total</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{(runs.data?.items ?? []).map((r) => <tr key={r.id} data-run={r.asAt}><td>{r.asAt}</td><td className="num">{r.total}</td><td>{r.status}{r.reversedReason ? `: ${r.reversedReason}` : ''}</td>
            <td>{prepare && r.status === 'POSTED' && <ReasonAction label="Reverse" path={`/release-runs/${r.id}/reverse`} onDone={reload} />}</td></tr>)}</tbody>
        </table>
      </Card>
      <Card title="Year-end register" testId="ye-register">
        {register.error && <p className="error" role="alert">{register.error}</p>}
        {register.data && (
          <>
            <table><thead><tr><th>Item or provision</th><th className="num">Balance at {register.data.asAt}</th></tr></thead>
              <tbody>
                {register.data.items.map((i) => <tr key={i.id}><td>{i.kind}: {i.description}</td><td className="num">{i.balance}</td></tr>)}
                {register.data.provisions.map((p) => <tr key={p.id}><td>Provision: {p.name}</td><td className="num">{p.balance}</td></tr>)}
              </tbody>
            </table>
            <Reconciliation rows={register.data.reconciliation} reconciled={register.data.reconciled} />
          </>
        )}
      </Card>
    </>
  );
}
