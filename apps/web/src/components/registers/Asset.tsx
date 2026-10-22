'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Form } from '@/components/Form';
import { useApi, useWorkspace } from '@/lib/workspace';
import { AccountSelect, Card, Input, ReasonAction, RegistersNav } from './common';

/** V2-M7b (DEC-074): one fixed asset - its cost, bases, charges and events - with the changes the API allows (DEC-058). */
interface Detail {
  id: string; number: number; description: string; classCode: string; acquiredOn: string; inUseFrom: string; cost: string; additionKind: string; status: 'ACTIVE' | 'DISPOSED' | 'VOID';
  accumulatedDepreciation: string; carryingAmount: string; lastChargedOn: string | null; disposedOn: string | null; proceeds: string | null; gainOrLoss: string | null;
  tax: { category: string; cost: string | null };
  bases: { id: string; effectiveFrom: string; carryingAmount: string; method: string; lifeMonths: number | null; ratePercent: string | null; residual: string; convention: string; reason: string }[];
  charges: { runId: string; asAt: string; amount: string }[];
}
const TAX = ['AIA', 'MAIN_POOL', 'SPECIAL_RATE_POOL', 'SINGLE_ASSET_POOL', 'NOT_QUALIFYING', 'UNDECIDED'];

export function AssetScreen() {
  const w = useWorkspace();
  const { assetId } = useParams<{ assetId: string }>();
  const { data: a, error, reload } = useApi<Detail>(w.path(`/fixed-assets/${assetId}`));
  const manage = w.can('assets:manage');
  const [est, setEst] = useState({ lifeMonths: '', ratePercent: '', residual: '', reason: '' });
  const [disp, setDisp] = useState({ disposedOn: '', proceeds: '', proceedsAccountId: '', reason: '' });
  const [tax, setTax] = useState({ category: '', cost: '', reason: '' });
  return (
    <>
      <div className="card">
        <h1>{a ? `Asset #${a.number}: ${a.description}` : 'Asset'}</h1>
        <RegistersNav />
        <p><Link href={`${w.base}/registers`}>Back to the register</Link></p>
        {error && <p className="error" role="alert">{error}</p>}
        {a && (
          <table data-testid="asset-summary"><tbody>
            <tr><td>Class</td><td>{a.classCode}</td></tr>
            <tr><td>Acquired / in use from</td><td>{a.acquiredOn} / {a.inUseFrom}</td></tr>
            <tr><td>Added</td><td>{a.additionKind}</td></tr>
            <tr><td>Status</td><td data-testid="asset-status">{a.status}{a.disposedOn ? ` on ${a.disposedOn}` : ''}</td></tr>
            <tr><td>Cost</td><td className="num">{a.cost}</td></tr>
            <tr><td>Accumulated depreciation</td><td className="num">{a.accumulatedDepreciation}</td></tr>
            <tr><td>Carrying amount</td><td className="num" data-testid="carrying-amount">{a.carryingAmount}</td></tr>
            <tr><td>Last charged</td><td>{a.lastChargedOn ?? 'never'}</td></tr>
            {a.status === 'DISPOSED' && <tr><td>Proceeds / gain or loss</td><td className="num">{a.proceeds} / {a.gainOrLoss}</td></tr>}
            <tr><td>Tax (kept for capital allowances, V4; never read by depreciation)</td><td>{a.tax.category}{a.tax.cost ? `, ${a.tax.cost}` : ''}</td></tr>
          </tbody></table>
        )}
      </div>
      {a && (
        <>
          <Card title="Depreciation bases and charges">
            <table><thead><tr><th>From</th><th>Basis</th><th className="num">Carrying amount</th><th>Reason</th></tr></thead>
              <tbody>{a.bases.map((b) => <tr key={b.id}><td>{b.effectiveFrom}</td><td>{b.method === 'STRAIGHT_LINE' ? `Straight line, ${b.lifeMonths} months` : `Reducing balance, ${b.ratePercent}%`}; residual {b.residual}; {b.convention.toLowerCase()}</td><td className="num">{b.carryingAmount}</td><td>{b.reason}</td></tr>)}</tbody>
            </table>
            <table data-testid="charges"><thead><tr><th>Run as at</th><th className="num">Charge</th></tr></thead>
              <tbody>{a.charges.map((c) => <tr key={c.runId}><td>{c.asAt}</td><td className="num">{c.amount}</td></tr>)}</tbody>
            </table>
          </Card>
          {manage && a.status === 'ACTIVE' && (
            <>
              <Card title="Change of estimate">
                <Form submit="Change the estimate" success="Estimate changed" onSubmit={async () => {
                  await api(w.path(`/fixed-assets/${a.id}/estimate`), { body: { ...(est.lifeMonths ? { lifeMonths: Number(est.lifeMonths) } : {}), ...(est.ratePercent ? { ratePercent: est.ratePercent.trim() } : {}), ...(est.residual ? { residual: est.residual.trim() } : {}), reason: est.reason.trim() } });
                  setEst({ lifeMonths: '', ratePercent: '', residual: '', reason: '' }); await reload();
                }}>
                  <div className="row">
                    <Input id="est-life" label="Remaining life (months)" value={est.lifeMonths} onChange={(x) => setEst({ ...est, lifeMonths: x })} required={false} />
                    <Input id="est-rate" label="Rate (%)" value={est.ratePercent} onChange={(x) => setEst({ ...est, ratePercent: x })} required={false} />
                    <Input id="est-residual" label="Residual" value={est.residual} onChange={(x) => setEst({ ...est, residual: x })} required={false} />
                  </div>
                  <Input id="est-reason" label="Reason" value={est.reason} onChange={(x) => setEst({ ...est, reason: x })} />
                </Form>
              </Card>
              <Card title="Dispose" testId="dispose">
                <Form submit="Dispose of the asset" success="Disposed" onSubmit={async () => {
                  await api(w.path(`/fixed-assets/${a.id}/dispose`), { body: { disposedOn: disp.disposedOn, proceeds: disp.proceeds.trim() || '0', ...(disp.proceedsAccountId ? { proceedsAccountId: disp.proceedsAccountId } : {}), reason: disp.reason.trim() } });
                  await reload();
                }}>
                  <div className="row">
                    <Input id="disp-date" label="Disposed on" type="date" value={disp.disposedOn} onChange={(x) => setDisp({ ...disp, disposedOn: x })} />
                    <Input id="disp-proceeds" label="Proceeds" value={disp.proceeds} onChange={(x) => setDisp({ ...disp, proceeds: x })} required={false} placeholder="0" />
                    <AccountSelect id="disp-account" label="Proceeds account (if posted now)" value={disp.proceedsAccountId} onChange={(x) => setDisp({ ...disp, proceedsAccountId: x })} filter={(x) => !x.isControl} required={false} />
                  </div>
                  <Input id="disp-reason" label="Reason" value={disp.reason} onChange={(x) => setDisp({ ...disp, reason: x })} />
                </Form>
              </Card>
              <Card title="Reverse the addition"><ReasonAction label="Reverse the addition" path={`/fixed-assets/${a.id}/reverse-addition`} onDone={reload} /></Card>
            </>
          )}
          {manage && a.status === 'DISPOSED' && <Card title="Reverse the disposal"><ReasonAction label="Reverse the disposal" path={`/fixed-assets/${a.id}/reverse-disposal`} onDone={reload} /></Card>}
          {manage && a.status !== 'VOID' && (
            <Card title="Tax fields">
              <Form submit="Change the tax fields" success="Tax fields changed" onSubmit={async () => {
                await api(w.path(`/fixed-assets/${a.id}/tax`), { body: { category: tax.category, ...(tax.cost.trim() ? { cost: tax.cost.trim() } : {}), reason: tax.reason.trim() } }); await reload();
              }}>
                <div className="row">
                  <div><label htmlFor="tax-cat">Category</label><select id="tax-cat" value={tax.category} onChange={(e) => setTax({ ...tax, category: e.target.value })} required><option value="">Choose</option>{TAX.map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
                  <Input id="tax-cost" label="Tax cost (if different)" value={tax.cost} onChange={(x) => setTax({ ...tax, cost: x })} required={false} />
                </div>
                <Input id="tax-reason" label="Reason" value={tax.reason} onChange={(x) => setTax({ ...tax, reason: x })} />
              </Form>
            </Card>
          )}
        </>
      )}
    </>
  );
}
