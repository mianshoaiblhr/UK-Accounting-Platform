'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Field, Form } from '@/components/Form';
import { api } from '@/lib/api';

export default function Register() {
  const [f, setF] = useState({ displayName: '', email: '', password: '', organisationName: '', organisationType: 'PRACTICE' });
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  return (
    <main className="narrow card">
      <h1>Create your account</h1>
      <Form submit="Register" success="Check your inbox for a verification link." onSubmit={async () => { await api('/auth/register', { body: f }); }}>
        <label htmlFor="organisationType">I am registering…</label>
        <select id="organisationType" name="organisationType" value={f.organisationType} onChange={(e) => set('organisationType')(e.target.value)}>
          <option value="PRACTICE">an accountancy practice (managing client companies)</option>
          <option value="BUSINESS">a business (managing my own company)</option>
        </select>
        <Field label={f.organisationType === 'PRACTICE' ? 'Practice name' : 'Business name'} name="organisationName" value={f.organisationName} onChange={set('organisationName')} />
        <Field label="Your name" name="displayName" value={f.displayName} onChange={set('displayName')} autoComplete="name" />
        <Field label="Email" name="email" type="email" value={f.email} onChange={set('email')} autoComplete="username" />
        <Field label="Password (12+ characters)" name="password" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" />
      </Form>
      <p className="muted">Already registered? <Link href="/login">Sign in</Link></p>
    </main>
  );
}
