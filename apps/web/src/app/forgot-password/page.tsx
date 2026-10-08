'use client';
import { useState } from 'react';
import { Field, Form } from '@/components/Form';
import { api } from '@/lib/api';

export default function Forgot() {
  const [email, setEmail] = useState('');
  return (
    <main className="narrow card">
      <h1>Reset your password</h1>
      <Form submit="Send reset link" success="If an account exists, a reset email is on its way." onSubmit={async () => { await api('/auth/forgot-password', { body: { email } }); }}>
        <Field label="Email" name="email" type="email" value={email} onChange={setEmail} autoComplete="username" />
      </Form>
    </main>
  );
}
