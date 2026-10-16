'use client';
import { MoneyPage } from '@/components/subledger/MoneyPage';
import { SIDES } from '@/components/subledger/side';
import { WorkspaceShell } from '@/lib/workspace';

export default function Page() { return <WorkspaceShell need={'purchases:read'}><MoneyPage side={SIDES.purchases} /></WorkspaceShell>; }
