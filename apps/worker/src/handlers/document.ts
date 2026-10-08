import { createHash } from 'node:crypto';
import { JobTypes } from '@uk/contracts';
import { sniffMatches, type AntivirusPort, type StoragePort } from '@uk/adapters';
import type { Database } from '@uk/db';
import { UnrecoverableError, type JobRuntime } from '@uk/jobs';

/**
 * document.process: integrity hash -> content-type sniff -> antivirus -> AVAILABLE | QUARANTINED.
 * (OCR / extraction jobs attach here in later versions; they never run in HTTP requests.)
 */
export function registerDocument(rt: JobRuntime, deps: { db: Database; storage: StoragePort; av: AntivirusPort }): void {
  rt.register(JobTypes.documentProcess, async ({ payload, organisationId, userId, progress, log }) => {
    if (!organisationId) throw new UnrecoverableError('document.process requires an organisation');
    const ctx = { organisationId, userId: userId ?? undefined };
    const v = await deps.db.tenant(ctx, (tx) => tx.documentVersion.findUnique({ where: { id: payload.documentVersionId } }));
    if (!v) throw new UnrecoverableError('document version not found');
    if (v.status === 'AVAILABLE' || v.status === 'QUARANTINED') return { status: v.status, skipped: true }; // idempotent
    await deps.db.tenant(ctx, (tx) => tx.documentVersion.update({ where: { id: v.id }, data: { status: 'SCANNING' } }));
    await progress(20, 'reading');

    const data = await deps.storage.getObject(v.storageKey);
    const sha256 = createHash('sha256').update(data).digest('hex');
    await progress(50, 'scanning');

    let verdict: { ok: boolean; reason?: string } = { ok: true };
    if (data.length !== v.sizeBytes) verdict = { ok: false, reason: 'size_mismatch' };
    else if (sniffMatches(v.contentType, data) === false) verdict = { ok: false, reason: 'content_type_mismatch' };
    else {
      const scan = await deps.av.scan(data); // transient AV outage throws => job retries with backoff
      if (!scan.clean) verdict = { ok: false, reason: `malware:${scan.signature ?? 'unknown'}` };
    }

    const status = verdict.ok ? 'AVAILABLE' : 'QUARANTINED';
    await deps.db.tenant(ctx, async (tx) => {
      await tx.documentVersion.update({
        where: { id: v.id },
        data: { status, sha256, scanResult: verdict.ok ? 'clean' : verdict.reason, processedAt: new Date() },
      });
      await tx.auditEvent.create({
        data: {
          organisationId, actorUserId: userId, action: verdict.ok ? 'document.available' : 'document.quarantined',
          outcome: verdict.ok ? 'SUCCESS' : 'DENIED', entityType: 'document_version', entityId: v.id,
          metadata: { sha256, reason: verdict.reason ?? null },
        },
      });
    });
    log.info({ versionId: v.id, status }, 'document processed');
    await progress(100, status);
    return { status, sha256 };
  });
}
