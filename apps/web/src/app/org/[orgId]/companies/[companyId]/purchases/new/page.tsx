'use client';
import { NewDocument } from '@/components/subledger/NewDocument';
import { SIDES } from '@/components/subledger/side';
import { WorkspaceShell } from '@/lib/workspace';

export default function Page() { return <WorkspaceShell need={'purchases:manage'}><NewDocument side={SIDES.purchases} /></WorkspaceShell>; }
