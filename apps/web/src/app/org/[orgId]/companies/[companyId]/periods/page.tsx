'use client';
import { useState } from 'react';
import { ApiError, api, errorText } from '@/lib/api';
import { WorkspaceShell, useApi, useWorkspace } from '@/lib/workspace';

interface Period { id: string; startDate: string; endDate: string; status: 'OPEN' | 'CLOSED' | 'LOCKED'; statusReason?: string | null }
type Action = 'close' | 'reopen' | 'lock' | 'unlock';
const ACTIONS: { action: Action; from: Period['status']; permission: string; label: string; reason: boolean }[] = [
  { action: 'close', from: 'OPEN', permission: 'period:manage', label: 'Close', reason: false },
  { action: 'reopen', from: 'CLOSED', permission: 'period:manage', label: 'Reopen', reason: true },
  { action: 'lock', from: 'CLOSED', permission: 'period:lock', label: 'Lock', reason: true },
  { action: 'unlock', from: 'LOCKED', permission: 'period:lock', label: 'Unlock', reason: true },
];
/** The controls the API applies when closing or locking, and the acknowledgement each one accepts (M3, M5a, M8). */
const ACKS: Record<string, { field: string; label: string }> = {
  unposted_documents: { field: 'acknowledgeDraftDocuments', label: 'Close with the draft documents left unapproved' },
  unreconciled_bank_items: { field: 'acknowledgeUnreconciledBank', label: 'Close with the bank statement lines left unreconciled' },
  fx_unrevalued_balances: { field: 'acknowledgeUnrevaluedFx', label: 'Close without revaluing the foreign-currency balances' },
  suspense_balance: { field: 'acknowledgeSuspenseBalance', label: 'Lock with the suspense balance' },
};

function PeriodRow({ p: raw, onDone }: { p: Period; onDone: () => Promise<void> }) {
  const w = useWorkspace();
  // the period list returns timestamps at midnight UTC; the period is its calendar dates
  const p = { ...raw, startDate: raw.startDate.slice(0, 10), endDate: raw.endDate.slice(0, 10) };
  const [reason, setReason] = useState('');
  const [acks, setAcks] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<{ code: string; message: string }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const actions = ACTIONS.filter((a) => a.from === p.status && w.can(a.permission));
  async function run(a: (typeof ACTIONS)[number]) {
    setBusy(true); setError('');
    try {
      await api(w.path(`/periods/${p.id}/${a.action}`), { body: { ...(reason.trim() ? { reason: reason.trim() } : {}), ...acks } });
      setPending([]); setAcks({}); setReason(''); await onDone();
    } catch (e) {
      if (e instanceof ApiError && ACKS[e.code]) setPending((x) => [...x.filter((y) => y.code !== e.code), { code: e.code, message: e.message }]);
      else setError(errorText(e));
    } finally { setBusy(false); }
  }
  return (
    <tr data-period={p.startDate}>
      <td>{p.startDate} to {p.endDate}</td>
      <td data-testid="period-status">{p.status}</td>
      <td>
        {actions.length > 0 && (
          <div className="inline-actions">
            <input aria-label={`Reason for ${p.startDate}`} placeholder="Reason (needed to reopen, lock or unlock)" value={reason} onChange={(e) => setReason(e.target.value)} style={{ marginBottom: 6 }} />
            {pending.map((x) => (
              <div key={x.code} role="alert">
                <p className="error">{x.message}</p>
                <label style={{ fontWeight: 400 }}><input type="checkbox" style={{ width: 'auto' }} checked={!!acks[ACKS[x.code]!.field]} onChange={(e) => setAcks({ ...acks, [ACKS[x.code]!.field]: e.target.checked })} /> {ACKS[x.code]!.label}</label>
              </div>
            ))}
            {actions.map((a) => <button key={a.action} disabled={busy} onClick={() => run(a)}>{a.label}</button>)}
            {error && <p className="error" role="alert">{error}</p>}
          </div>
        )}
      </td>
    </tr>
  );
}

function Periods() {
  const w = useWorkspace();
  const { data, error, reload } = useApi<{ items: Period[] }>(w.path('/periods'));
  return (
    <div className="card">
      <h1>Accounting periods</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {data && (data.items.length === 0 ? <p className="muted">No periods yet.</p> : (
        <table data-testid="periods">
          <thead><tr><th>Period</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>{data.items.map((p) => <PeriodRow key={p.id} p={p} onDone={reload} />)}</tbody>
        </table>
      ))}
    </div>
  );
}

export default function Page() { return <WorkspaceShell need="period:read"><Periods /></WorkspaceShell>; }
