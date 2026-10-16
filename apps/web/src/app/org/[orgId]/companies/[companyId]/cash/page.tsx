'use client';
import { CashPage } from '@/components/bank/CashPage';
import { WorkspaceShell } from '@/lib/workspace';

export default function Page() { return <WorkspaceShell need="cash:read"><CashPage /></WorkspaceShell>; }
