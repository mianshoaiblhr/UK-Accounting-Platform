'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Field, Form } from '@/components/Form';
import { api } from '@/lib/api';

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState('');
  const [code, setCode] = useState('');

  return (
    <main className="narrow card">
      <h1>{challenge ? 'Two-step verification' : 'Sign in'}</h1>
      {!challenge ? (
        <Form submit="Sign in" onSubmit={async () => {
          const r = await api<{ mfaRequired: boolean; challengeToken?: string }>('/auth/login', { body: { email, password } });
          if (r.mfaRequired) setChallenge(r.challengeToken!); else router.push('/');
        }}>
          <Field label="Email" name="email" type="email" value={email} onChange={setEmail} autoComplete="username" />
          <Field label="Password" name="password" type="password" value={password} onChange={setPassword} autoComplete="current-password" />
        </Form>
      ) : (
        <Form submit="Verify" onSubmit={async () => {
          await api('/auth/login/mfa', { body: { challengeToken: challenge, code } });
          router.push('/');
        }}>
          <p className="muted">Enter the 6-digit code from your authenticator app, or a recovery code.</p>
          <Field label="Code" name="code" value={code} onChange={setCode} autoComplete="one-time-code" />
        </Form>
      )}
      <p className="muted"><Link href="/forgot-password">Forgot password?</Link> · <Link href="/register">Create an account</Link></p>
    </main>
  );
}
