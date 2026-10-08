'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Field, Form } from '@/components/Form';
import { Nav } from '@/components/Nav';
import { ApiError, api, type Me } from '@/lib/api';

interface SessionRow { id: string; createdAt: string; ip: string | null; userAgent: string | null; current: boolean }
interface HistoryRow { id: string; occurredAt: string; action: string; outcome: string; ip: string | null }

export default function Security() {
  const router = useRouter();
  const [me, setMe] = useState<Me>();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [enrol, setEnrol] = useState<{ secret: string; otpauthUrl: string }>();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[]>([]);

  const load = async () => {
    setMe(await api<Me>('/auth/me'));
    setSessions((await api<{ items: SessionRow[] }>('/auth/sessions')).items);
    setHistory((await api<{ items: HistoryRow[] }>('/auth/login-history')).items);
  };
  useEffect(() => { load().catch((e) => { if (e instanceof ApiError && e.status === 401) router.push('/login'); }); }, []);

  if (!me) return <main><p>Loading…</p></main>;
  return (
    <>
      <Nav me={me} />
      <main>
        <div className="card">
          <h2>Two-step verification (authenticator app)</h2>
          {me.mfa.enabled ? <p className="ok">Enabled · {me.mfa.recoveryCodesRemaining} recovery codes left</p> : !enrol ? (
            <button onClick={async () => setEnrol(await api('/auth/mfa/enroll', { method: 'POST' }))}>Set up</button>
          ) : (
            <Form submit="Confirm" onSubmit={async () => { const r = await api<{ recoveryCodes: string[] }>('/auth/mfa/confirm', { body: { code } }); setRecovery(r.recoveryCodes); setEnrol(undefined); await load(); }}>
              <p>Add this key to your authenticator app, then enter the 6-digit code:</p>
              <p><code data-testid="mfa-secret">{enrol.secret}</code></p>
              <Field label="Code" name="code" value={code} onChange={setCode} autoComplete="one-time-code" />
            </Form>
          )}
          {recovery.length > 0 && (
            <div role="status"><p className="error">Save these recovery codes now — they will not be shown again:</p><pre>{recovery.join('\n')}</pre></div>
          )}
        </div>
        <div className="card">
          <h2>Active sessions</h2>
          <table><tbody>{sessions.map((s) => (
            <tr key={s.id}><td>{new Date(s.createdAt).toLocaleString('en-GB')}</td><td>{s.ip}</td><td>{s.current ? 'this session' : (
              <button className="secondary" style={{ marginTop: 0 }} onClick={async () => { await api(`/auth/sessions/${s.id}`, { method: 'DELETE' }); await load(); }}>Revoke</button>
            )}</td></tr>
          ))}</tbody></table>
        </div>
        <div className="card">
          <h2>Recent sign-in activity</h2>
          <table><tbody>{history.slice(0, 15).map((h) => (
            <tr key={h.id}><td>{new Date(h.occurredAt).toLocaleString('en-GB')}</td><td>{h.action}</td><td>{h.outcome}</td><td>{h.ip}</td></tr>
          ))}</tbody></table>
        </div>
      </main>
    </>
  );
}
