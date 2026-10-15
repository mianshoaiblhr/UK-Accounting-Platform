'use client';
import { useState } from 'react';
import { Statement, type ReportLine } from '@/components/Statement';
import { WorkspaceShell, qs, useApi, useWorkspace } from '@/lib/workspace';

interface ProfitAndLoss { currency: string; from: string; to: string; comparative: { from: string; to: string } | null; lines: ReportLine[]; profitForPeriod: string;
  reconciliation: { incomeLessExpensesFromLedger: string; difference: string; reconciled: boolean }; notice: string }

function ProfitAndLossPage() {
  const w = useWorkspace();
  const year = new Date().getUTCFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);
  const [compareFrom, setCompareFrom] = useState('');
  const [compareTo, setCompareTo] = useState('');
  const both = !!compareFrom && !!compareTo;
  const { data, error } = useApi<ProfitAndLoss>(from && to ? w.path(`/reports/profit-and-loss${qs({ from, to, compareFrom: both ? compareFrom : undefined, compareTo: both ? compareTo : undefined })}`) : null);
  return (
    <div className="card">
      <h1>Profit and loss</h1>
      <div className="row">
        <div><label htmlFor="from">From</label><input id="from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div><label htmlFor="to">To</label><input id="to" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <div><label htmlFor="compareFrom">Compare from</label><input id="compareFrom" type="date" value={compareFrom} onChange={(e) => setCompareFrom(e.target.value)} /></div>
        <div><label htmlFor="compareTo">Compare to</label><input id="compareTo" type="date" value={compareTo} onChange={(e) => setCompareTo(e.target.value)} /></div>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (
        <>
          <Statement lines={data.lines} base={w.base} currency={data.currency} label={`${data.from} to ${data.to}`} compareLabel={data.comparative ? `${data.comparative.from} to ${data.comparative.to}` : null} />
          <p className={data.reconciliation.reconciled ? 'ok' : 'error'} role="status" data-testid="reconciliation">
            Profit for the period {data.profitForPeriod}; income less expenses in the ledger {data.reconciliation.incomeLessExpensesFromLedger}; difference {data.reconciliation.difference}
            {data.reconciliation.reconciled ? ' (reconciled)' : ' (NOT reconciled)'}
          </p>
          <p className="muted">{data.notice}</p>
        </>
      )}
    </div>
  );
}

export default function Page() { return <WorkspaceShell need="ledger:read"><ProfitAndLossPage /></WorkspaceShell>; }
