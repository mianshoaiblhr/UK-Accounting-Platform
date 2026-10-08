'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Form } from '@/components/Form';
import { api } from '@/lib/api';

function Inner() {
  const token = useSearchParams().get('token') ?? '';
  return (
    <main className="narrow card">
      <h1>Accept invitation</h1>
      <p className="muted">You must be signed in with the invited email address.</p>
      <Form submit="Accept" success="You have joined the organisation." onSubmit={async () => { await api('/invitations/accept', { body: { token } }); }}>
        <span />
      </Form>
      <p className="muted"><Link href="/">Go to dashboard</Link></p>
    </main>
  );
}
export default function Page() { return <Suspense><Inner /></Suspense>; }
