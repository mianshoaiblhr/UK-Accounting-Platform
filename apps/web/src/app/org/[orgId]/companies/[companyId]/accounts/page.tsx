'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Field, Form } from '@/components/Form';
import { api } from '@/lib/api';
import { WorkspaceShell, qs, useApi, useWorkspace } from '@/lib/workspace';

interface Account { id: string; code: string; name: string; type: string; subtype: string; isControl: boolean; controlKind: string | null; reportingMapping: string; activeTo: string | null; isSystem: boolean }

function Accounts() {
  const w = useWorkspace();
  const { data, error, reload } = useApi<{ items: Account[] }>(w.path('/accounts'));
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [like, setLike] = useState('');
  const items = data?.items ?? [];
  return (
    <>
      <div className="card">
        <h1>Chart of accounts</h1>
        {error && <p className="error" role="alert">{error}</p>}
        {data && items.length === 0 && (
          <>
            <p className="muted">This company has no chart of accounts yet.</p>
            {w.can('account:manage') && <Form submit="Create the standard chart" success="Chart created." onSubmit={async () => { await api(w.path('/accounts/initialise'), { method: 'POST' }); await reload(); }}><span /></Form>}
          </>
        )}
        {items.length > 0 && (
          <table data-testid="accounts">
            <thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Reporting line</th><th>Control</th></tr></thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td>{w.can('ledger:read') ? <Link href={`${w.base}/ledger${qs({ accountId: a.id })}`}>{a.code}</Link> : a.code}</td>
                  <td>{a.name}{a.activeTo ? <span className="muted"> (inactive from {a.activeTo})</span> : null}</td>
                  <td>{a.type.toLowerCase()} / {a.subtype.toLowerCase().replace(/_/g, ' ')}</td>
                  <td><code>{a.reportingMapping}</code></td>
                  <td>{a.isControl ? a.controlKind : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {items.length > 0 && w.can('account:manage') && (
        <div className="card" data-testid="new-account">
          <h2>Add an account</h2>
          <p className="muted">The new account takes its type, subtype and reporting line from an existing account you choose.</p>
          <Form submit="Add account" success="Account added." onSubmit={async () => {
            const t = items.find((a) => a.id === like);
            if (!t) throw new Error('Choose the account it is like');
            await api(w.path('/accounts'), { body: { code, name, type: t.type, subtype: t.subtype, reportingMapping: t.reportingMapping }, idempotencyKey: crypto.randomUUID() });
            setCode(''); setName(''); await reload();
          }}>
            <Field label="Code" name="accountCode" value={code} onChange={setCode} />
            <Field label="Name" name="accountName" value={name} onChange={setName} />
            <label htmlFor="like">Same kind as</label>
            <select id="like" value={like} onChange={(e) => setLike(e.target.value)} required>
              <option value="">Choose an account…</option>
              {items.filter((a) => !a.isControl).map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
            </select>
          </Form>
        </div>
      )}
    </>
  );
}

export default function Page() { return <WorkspaceShell need="account:read"><Accounts /></WorkspaceShell>; }
