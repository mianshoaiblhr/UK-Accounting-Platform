'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Field, Form } from '@/components/Form';
import { api } from '@/lib/api';

function Inner() {
  const token = useSearchParams().get('token') ?? '';
  const [pw, setPw] = useState('');
  return (
    <main className="narrow card">
      <h1>Choose a new password</h1>
      <Form submit="Reset password" success="Password updated. You can now sign in." onSubmit={async () => { await api('/auth/reset-password', { body: { token, newPassword: pw } }); }}>
        <Field label="New password (12+ characters)" name="newPassword" type="password" value={pw} onChange={setPw} autoComplete="new-password" />
      </Form>
      <p className="muted"><Link href="/login">Back to sign in</Link></p>
    </main>
  );
}
export default function Page() { return <Suspense><Inner /></Suspense>; }
