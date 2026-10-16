'use client';
import { BankAccounts } from '@/components/bank/BankAccounts';
import { WorkspaceShell } from '@/lib/workspace';

export default function Page() { return <WorkspaceShell need="bank:read"><BankAccounts /></WorkspaceShell>; }
