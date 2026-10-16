'use client';
import { BankAccountPage } from '@/components/bank/BankAccountPage';
import { WorkspaceShell } from '@/lib/workspace';

export default function Page() { return <WorkspaceShell need="bank:read"><BankAccountPage /></WorkspaceShell>; }
