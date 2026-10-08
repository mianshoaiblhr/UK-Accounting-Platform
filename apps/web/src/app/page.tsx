'use client';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Field, Form } from '@/components/Form';
import { Nav } from '@/components/Nav';
import { ApiError, api, type Company, type Me } from '@/lib/api';

export default function Dashboard() {
  const router = useRouter();
  const [me, setMe] = useState<Me>();
  const [orgId, setOrgId] = useState('');
  const [companies, setCompanies] = useState<Company[]>([]);
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');

  useEffect(() => {
    api<Me>('/auth/me').then((m) => { setMe(m); setOrgId(m.organisations[0]?.id ?? ''); })
      .catch((e) => { if (e instanceof ApiError && e.status === 401) router.push('/login'); });
  }, [router]);

  const load = useCallback(async () => {
    if (!orgId) return;
    const r = await api<{ items: Company[] }>(`/organisations/${orgId}/companies?limit=100`);
    setCompanies(r.items);
  }, [orgId]);
  useEffect(() => { void load(); }, [load]);

  if (!me) return <main><p>Loading…</p></main>;
  const org = me.organisations.find((o) => o.id === orgId);
  return (
    <>
      <Nav me={me} />
      <main>
        <div className="card">
          <h1>Welcome, {me.user.displayName}</h1>
          <label htmlFor="org">Organisation</label>
          <select id="org" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            {me.organisations.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.type === 'PRACTICE' ? 'practice' : 'business'}, {o.roleName})</option>)}
          </select>
        </div>
        <div className="card">
          <h2>{org?.type === 'PRACTICE' ? 'Client companies' : 'Companies'}</h2>
          {companies.length === 0 ? <p className="muted">No companies yet.</p> : (
            <table data-testid="companies">
              <thead><tr><th>Name</th><th>Number</th><th>Type</th></tr></thead>
              <tbody>{companies.map((c) => <tr key={c.id}><td>{c.name}</td><td>{c.companyNumber ?? '—'}</td><td>{c.legalForm}</td></tr>)}</tbody>
            </table>
          )}
        </div>
        <div className="card">
          <h2>Add a company</h2>
          <Form submit="Add company" success="Company added." onSubmit={async () => {
            await api(`/organisations/${orgId}/companies`, { body: { name, ...(number ? { companyNumber: number } : {}) }, idempotencyKey: crypto.randomUUID() });
            setName(''); setNumber(''); await load();
          }}>
            <Field label="Company name" name="companyName" value={name} onChange={setName} />
            <label htmlFor="companyNumber">Company number (optional, 8 characters)</label>
            <input id="companyNumber" name="companyNumber" value={number} onChange={(e) => setNumber(e.target.value)} />
          </Form>
        </div>
      </main>
    </>
  );
}
