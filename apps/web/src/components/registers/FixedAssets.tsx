'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Form } from '@/components/Form';
import { qs, useApi, useWorkspace } from '@/lib/workspace';
import { AccountSelect, Card, Input, Reconciliation, RegistersNav, today, useAccounts } from './common';

/** V2-M7b (DEC-074): the fixed-asset register (DEC-058), its classes and assets, as the API returns them. */
interface AssetClass { id: string; code: string; name: string; method: string; lifeMonths: number | null; ratePercent: string | null; residualPercent: string; convention: string; costAccountId: string; depreciationAccountId: string }
interface Asset { id: string; number: number; description: string; classId: string; acquiredOn: string; cost: string; additionKind: string; status: string }
interface Register {
  currency: string; asAt: string; reconciled: boolean;
  classes: { classId: string; code: string; name: string; cost: string; accumulatedDepreciation: string; carryingAmount: string; assets: { id: string; number: number; description: string; status: string; cost: string; accumulatedDepreciation: string; carryingAmount: string }[] }[];
  reconciliation: { code: string; kind: string; register: string; ledger: string; difference: string; reconciled: boolean }[];
}

function ClassForm({ onDone }: { onDone: () => Promise<void> }) {
  const w = useWorkspace();
  const [v, setV] = useState({ code: '', name: '', costAccountId: '', depreciationAccountId: '', expenseAccountId: '', disposalAccountId: '', method: 'STRAIGHT_LINE', life: '', rate: '', residualPercent: '0', convention: 'MONTHLY' });
  const set = (k: string) => (x: string) => setV({ ...v, [k]: x });
  return (
    <Form submit="Create class" success="Class created" onSubmit={async () => {
      await api(w.path('/fixed-asset-classes'), { body: { code: v.code.trim(), name: v.name.trim(), costAccountId: v.costAccountId, depreciationAccountId: v.depreciationAccountId, expenseAccountId: v.expenseAccountId,
        disposalAccountId: v.disposalAccountId, method: v.method, ...(v.method === 'STRAIGHT_LINE' ? { lifeMonths: Number(v.life) } : { ratePercent: v.rate.trim() }), residualPercent: v.residualPercent.trim() || '0', convention: v.convention } });
      await onDone();
    }}>
      <div className="row">
        <Input id="cls-code" label="Code" value={v.code} onChange={set('code')} placeholder="OFFICE" />
        <Input id="cls-name" label="Name" value={v.name} onChange={set('name')} />
      </div>
      <div className="row">
        <AccountSelect id="cls-cost" label="Cost account" value={v.costAccountId} onChange={set('costAccountId')} filter={(a) => a.type === 'ASSET'} />
        <AccountSelect id="cls-dep" label="Accumulated depreciation account" value={v.depreciationAccountId} onChange={set('depreciationAccountId')} filter={(a) => a.type === 'ASSET'} />
        <AccountSelect id="cls-exp" label="Depreciation expense account" value={v.expenseAccountId} onChange={set('expenseAccountId')} filter={(a) => a.type === 'EXPENSE'} />
        <AccountSelect id="cls-disp" label="Disposal account" value={v.disposalAccountId} onChange={set('disposalAccountId')} />
      </div>
      <div className="row">
        <div><label htmlFor="cls-method">Method</label><select id="cls-method" value={v.method} onChange={(e) => set('method')(e.target.value)}><option value="STRAIGHT_LINE">Straight line</option><option value="REDUCING_BALANCE">Reducing balance</option></select></div>
        {v.method === 'STRAIGHT_LINE' ? <Input id="cls-life" label="Life (months)" value={v.life} onChange={set('life')} /> : <Input id="cls-rate" label="Rate (% a year)" value={v.rate} onChange={set('rate')} />}
        <Input id="cls-residual" label="Residual (% of cost)" value={v.residualPercent} onChange={set('residualPercent')} />
        <div><label htmlFor="cls-conv">Convention</label><select id="cls-conv" value={v.convention} onChange={(e) => set('convention')(e.target.value)}><option value="MONTHLY">Monthly</option><option value="DAILY">Daily</option></select></div>
      </div>
    </Form>
  );
}

function AssetForm({ classes, onDone }: { classes: AssetClass[]; onDone: () => Promise<void> }) {
  const w = useWorkspace();
  const [v, setV] = useState({ classId: '', description: '', acquiredOn: '', cost: '', kind: 'LINKED', journalId: '', offsetAccountId: '', takeOnDate: '', accumulated: '' });
  const set = (k: string) => (x: string) => setV({ ...v, [k]: x });
  // the journals that put cost on the chosen class's cost account: the person picks one to link, the API checks it
  const cls = classes.find((c) => c.id === v.classId);
  const { data: postings } = useApi<{ items: { journalId: string; journalNumber: number; journalDate: string; description: string | null; debit: string }[] }>(cls && v.kind !== 'POSTED' ? w.path(`/ledger${qs({ accountId: cls.costAccountId, limit: '200' })}`) : null);
  return (
    <Form submit="Add asset" success="Asset added" onSubmit={async () => {
      const addition = v.kind === 'POSTED' ? { kind: 'POSTED', offsetAccountId: v.offsetAccountId } : v.kind === 'LINKED' ? { kind: 'LINKED', journalId: v.journalId }
        : { kind: 'TAKE_ON', takeOnDate: v.takeOnDate, accumulatedDepreciation: v.accumulated.trim(), ...(v.journalId ? { journalId: v.journalId } : {}) };
      await api(w.path('/fixed-assets'), { body: { classId: v.classId, description: v.description.trim(), acquiredOn: v.acquiredOn, cost: v.cost.trim(), addition } });
      await onDone();
    }}>
      <div className="row">
        <div><label htmlFor="as-class">Class</label><select id="as-class" value={v.classId} onChange={(e) => set('classId')(e.target.value)} required><option value="">Choose a class</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.code} {c.name}</option>)}</select></div>
        <Input id="as-desc" label="Description" value={v.description} onChange={set('description')} />
        <Input id="as-acq" label="Acquired on" type="date" value={v.acquiredOn} onChange={set('acquiredOn')} />
        <Input id="as-cost" label="Cost" value={v.cost} onChange={set('cost')} />
      </div>
      <div className="row">
        <div><label htmlFor="as-kind">How the cost reaches the ledger</label>
          <select id="as-kind" value={v.kind} onChange={(e) => set('kind')(e.target.value)}>
            <option value="LINKED">Already posted (link the posting)</option><option value="POSTED">Post it now against an account</option><option value="TAKE_ON">Taken on with accumulated depreciation</option>
          </select></div>
        {v.kind === 'POSTED' && <AccountSelect id="as-offset" label="Credit account" value={v.offsetAccountId} onChange={set('offsetAccountId')} filter={(a) => !a.isControl} />}
        {v.kind !== 'POSTED' && (
          <div><label htmlFor="as-journal">Posting on the cost account</label>
            <select id="as-journal" value={v.journalId} onChange={(e) => set('journalId')(e.target.value)} required={v.kind === 'LINKED'}>
              <option value="">{v.kind === 'LINKED' ? 'Choose the posting' : 'None'}</option>
              {(postings?.items ?? []).filter((p) => Number(p.debit) > 0).map((p) => <option key={p.journalId} value={p.journalId}>#{p.journalNumber} {p.journalDate} {p.description ?? ''} {p.debit}</option>)}
            </select></div>
        )}
        {v.kind === 'TAKE_ON' && <><Input id="as-takeon" label="Take-on date" type="date" value={v.takeOnDate} onChange={set('takeOnDate')} /><Input id="as-accum" label="Accumulated depreciation" value={v.accumulated} onChange={set('accumulated')} /></>}
      </div>
    </Form>
  );
}

export function FixedAssetsScreen() {
  const w = useWorkspace();
  const [asAt, setAsAt] = useState(today());
  const register = useApi<Register>(w.path(`/fixed-asset-register${qs({ asAt })}`));
  const classes = useApi<{ items: AssetClass[] }>(w.path('/fixed-asset-classes'));
  const assets = useApi<{ items: Asset[] }>(w.path('/fixed-assets'));
  const { label } = useAccounts();
  const reload = async () => { await Promise.all([register.reload(), classes.reload(), assets.reload()]); };
  const manage = w.can('assets:manage');
  const r = register.data;
  return (
    <>
      <div className="card">
        <h1>Fixed assets</h1>
        <RegistersNav />
        <div className="row"><Input id="fa-asat" label="Register as at" type="date" value={asAt} onChange={setAsAt} /></div>
        {register.error && <p className="error" role="alert">{register.error}</p>}
        {r && (
          <div data-testid="fa-register">
            {r.classes.length === 0 ? <p className="muted">No assets in the register at this date.</p> : (
              <table>
                <thead><tr><th>Class / asset</th><th className="num">Cost</th><th className="num">Accumulated depreciation</th><th className="num">Carrying amount</th></tr></thead>
                <tbody>{r.classes.flatMap((c) => [
                  <tr key={c.classId} className="total"><td>{c.code} {c.name}</td><td className="num">{c.cost}</td><td className="num">{c.accumulatedDepreciation}</td><td className="num">{c.carryingAmount}</td></tr>,
                  ...c.assets.map((a) => <tr key={a.id}><td className="indent"><Link href={`${w.base}/registers/assets/${a.id}`}>#{a.number} {a.description}</Link> {a.status === 'DISPOSED' ? '(disposed)' : ''}</td><td className="num">{a.cost}</td><td className="num">{a.accumulatedDepreciation}</td><td className="num">{a.carryingAmount}</td></tr>),
                ])}</tbody>
              </table>
            )}
            <Reconciliation rows={r.reconciliation} reconciled={r.reconciled} />
          </div>
        )}
      </div>
      <Card title="Classes" testId="fa-classes">
        {classes.error && <p className="error" role="alert">{classes.error}</p>}
        <table><thead><tr><th>Code</th><th>Name</th><th>Method</th><th>Cost account</th><th>Depreciation account</th></tr></thead>
          <tbody>{(classes.data?.items ?? []).map((c) => <tr key={c.id} data-class={c.code}><td>{c.code}</td><td>{c.name}</td><td>{c.method === 'STRAIGHT_LINE' ? `Straight line, ${c.lifeMonths} months` : `Reducing balance, ${c.ratePercent}%`}; {c.convention.toLowerCase()}; residual {c.residualPercent}%</td><td>{label(c.costAccountId)}</td><td>{label(c.depreciationAccountId)}</td></tr>)}</tbody>
        </table>
        {manage && <><h3>New class</h3><ClassForm onDone={reload} /></>}
      </Card>
      <Card title="Assets" testId="fa-assets">
        {assets.error && <p className="error" role="alert">{assets.error}</p>}
        <table><thead><tr><th>#</th><th>Description</th><th>Acquired</th><th className="num">Cost</th><th>Added</th><th>Status</th></tr></thead>
          <tbody>{(assets.data?.items ?? []).map((a) => <tr key={a.id} data-asset={a.number}><td>{a.number}</td><td><Link href={`${w.base}/registers/assets/${a.id}`}>{a.description}</Link></td><td>{a.acquiredOn}</td><td className="num">{a.cost}</td><td>{a.additionKind}</td><td>{a.status}</td></tr>)}</tbody>
        </table>
        {manage && (classes.data?.items.length ? <><h3>Add an asset</h3><AssetForm classes={classes.data.items} onDone={reload} /></> : <p className="muted">Create a class first.</p>)}
      </Card>
    </>
  );
}
