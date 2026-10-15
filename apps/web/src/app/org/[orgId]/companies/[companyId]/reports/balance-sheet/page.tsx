'use client';
import { useState } from 'react';
import { Statement, type ReportLine } from '@/components/Statement';
import { WorkspaceShell, qs, useApi, useWorkspace } from '@/lib/workspace';

interface Proof { netAssets: string; capitalAndReserves: string; difference: string; balanced: boolean; trialBalance: { debit: string; credit: string; balanced: boolean } }
interface BalanceSheet { currency: string; asOf: string; compareAsOf: string | null; financialYearStart: string | null; lines: ReportLine[]; netAssets: string; reconciliation: Proof; notice: string }

function BalanceSheetPage() {
  const w = useWorkspace();
  const [asOf, setAsOf] = useState(`${new Date().getUTCFullYear()}-12-31`);
  const [compareAsOf, setCompareAsOf] = useState('');
  const { data, error } = useApi<BalanceSheet>(asOf ? w.path(`/reports/balance-sheet${qs({ asOf, compareAsOf })}`) : null);
  return (
    <div className="card">
      <h1>Balance sheet</h1>
      <div className="row">
        <div><label htmlFor="asOf">As at</label><input id="asOf" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></div>
        <div><label htmlFor="compareAsOf">Compare with</label><input id="compareAsOf" type="date" value={compareAsOf} onChange={(e) => setCompareAsOf(e.target.value)} /></div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (
        <>
          <Statement lines={data.lines} base={w.base} currency={data.currency} label={data.asOf} compareLabel={data.compareAsOf} />
          <p className={data.reconciliation.balanced ? 'ok' : 'error'} role="status" data-testid="reconciliation">
            Net assets {data.reconciliation.netAssets}; capital and reserves {data.reconciliation.capitalAndReserves}; difference {data.reconciliation.difference}
            {data.reconciliation.balanced ? ' (balanced' : ' (NOT balanced'}; trial balance {data.reconciliation.trialBalance.balanced ? 'balanced)' : 'NOT balanced)'}
          </p>
          <p className="muted">{data.financialYearStart ? `Financial year from ${data.financialYearStart}. ` : ''}{data.notice}</p>
        </>
      )}
    </div>
  );
}

export default function Page() { return <WorkspaceShell need="ledger:read"><BalanceSheetPage /></WorkspaceShell>; }
