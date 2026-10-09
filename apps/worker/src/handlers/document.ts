import { createHash } from 'node:crypto';
import { Events, JobTypes } from '@uk/contracts';
import { auditRow, publishEvent, type FeatureFlagService, type OcrProvider } from '@uk/platform';
import { sniffMatches, type AntivirusPort, type StoragePort } from '@uk/adapters';
import type { Database } from '@uk/db';
import { UnrecoverableError, type JobProducer, type JobRuntime } from '@uk/jobs';

/**
 * document.process: integrity hash -> content-type sniff -> antivirus -> AVAILABLE | QUARANTINED -> (optional) document.ocr.
 * document.ocr runs only for organisations that switched the `documents.ocr` flag on, only on AVAILABLE (clean) versions, and
 * its output is data attached to the version - never a decision. Neither job runs in an HTTP request.
 */
const MAX_TEXT = 1_000_000;
export function registerDocument(rt: JobRuntime, deps: { db: Database; storage: StoragePort; av: AntivirusPort; features: FeatureFlagService; jobs: JobProducer; ocr?: OcrProvider }): void {
  /** Idempotent (stable key): safe to call again when the process job is retried or re-run. */
  const queueOcr = async (v: { id: string; contentType: string }, organisationId: string, userId: string | null) => {
    if (!deps.ocr || !deps.ocr.supports(v.contentType)) return;
    if (!(await deps.features.isEnabled('documents.ocr', organisationId))) return;
    await deps.jobs.enqueue(JobTypes.documentOcr, { documentVersionId: v.id }, { organisationId, userId: userId ?? undefined, idempotencyKey: `ocr:${v.id}` });
  };

  rt.register(JobTypes.documentProcess, async ({ payload, organisationId, userId, progress, log }) => {
    if (!organisationId) throw new UnrecoverableError('document.process requires an organisation');
    const ctx = { organisationId, userId: userId ?? undefined };
    const v = await deps.db.tenant(ctx, (tx) => tx.documentVersion.findUnique({ where: { id: payload.documentVersionId } }));
    if (!v) throw new UnrecoverableError('document version not found');
    if (v.status === 'AVAILABLE' || v.status === 'QUARANTINED') {
      if (v.status === 'AVAILABLE') await queueOcr(v, organisationId, userId); // the previous attempt may have stopped before queueing
      return { status: v.status, skipped: true }; // idempotent
    }
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
    if (verdict.ok) await queueOcr(v, organisationId, userId);
    log.info({ versionId: v.id, status }, 'document processed');
    await progress(100, status);
    return { status, sha256 };
  });

  rt.register(JobTypes.documentOcr, async ({ payload, organisationId, userId, progress, log }) => {
    if (!organisationId) throw new UnrecoverableError('document.ocr requires an organisation');
    if (!deps.ocr) throw new UnrecoverableError('no OCR provider is configured');
    // Re-checked at execution time: switching the flag off also stops work that was queued earlier.
    if (!(await deps.features.isEnabled('documents.ocr', organisationId))) throw new UnrecoverableError('feature documents.ocr is disabled for this organisation');
    const ctx = { organisationId, userId: userId ?? undefined };
    const v = await deps.db.tenant(ctx, (tx) => tx.documentVersion.findUnique({ where: { id: payload.documentVersionId }, include: { document: { select: { name: true, companyId: true } } } }));
    if (!v) throw new UnrecoverableError('document version not found');
    if (v.status !== 'AVAILABLE') throw new UnrecoverableError(`document version is ${v.status}; OCR only reads scanned, AVAILABLE versions`);
    const provider = deps.ocr.name;
    const claimed = await deps.db.tenant(ctx, async (tx) => {
      const existing = await tx.documentExtraction.findUnique({ where: { documentVersionId_provider: { documentVersionId: v.id, provider } } });
      if (existing?.status === 'SUCCEEDED') return null; // idempotent
      if (!deps.ocr!.supports(v.contentType)) {
        await tx.documentExtraction.upsert({ where: { documentVersionId_provider: { documentVersionId: v.id, provider } }, create: { organisationId, documentId: v.documentId, documentVersionId: v.id, provider, status: 'SKIPPED', completedAt: new Date(), error: 'content type not supported' }, update: { status: 'SKIPPED', completedAt: new Date(), error: 'content type not supported' } });
        return null;
      }
      return tx.documentExtraction.upsert({ where: { documentVersionId_provider: { documentVersionId: v.id, provider } },
        create: { organisationId, documentId: v.documentId, documentVersionId: v.id, provider, status: 'RUNNING', startedAt: new Date(), requestedByUserId: userId },
        update: { status: 'RUNNING', startedAt: new Date(), error: null } });
    });
    if (!claimed) return { skipped: true };
    await progress(30, 'reading');
    try {
      const data = await deps.storage.getObject(v.storageKey);
      await progress(50, 'extracting');
      const out = await deps.ocr.extract({ data, contentType: v.contentType, filename: v.document.name });
      const truncated = out.text.length > MAX_TEXT;
      const text = truncated ? out.text.slice(0, MAX_TEXT) : out.text;
      await deps.db.tenant(ctx, async (tx) => {
        await tx.documentExtraction.update({ where: { id: claimed.id }, data: { status: 'SUCCEEDED', text, charCount: text.length, pageCount: out.pages, confidence: out.confidence, language: out.language, truncated, engineVersion: out.engineVersion, completedAt: new Date(), error: null } });
        await tx.auditEvent.createMany({ data: [auditRow({ action: 'document.extracted', organisationId, companyId: v.document.companyId, actorUserId: userId, entityType: 'document_version', entityId: v.id,
          metadata: { provider, pages: out.pages, characters: text.length, truncated } })] }); // the extracted text itself is never written to the audit trail or the logs
        await publishEvent(tx, Events.documentExtracted, { aggregateId: v.id, organisationId, actorUserId: userId ?? undefined,
          payload: { documentId: v.documentId, versionId: v.id, extractionId: claimed.id, provider, pageCount: out.pages, charCount: text.length } });
      });
      log.info({ versionId: v.id, pages: out.pages }, 'document extracted');
      await progress(100, 'SUCCEEDED');
      return { status: 'SUCCEEDED', pages: out.pages, characters: text.length };
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await deps.db.tenant(ctx, (tx) => tx.documentExtraction.update({ where: { id: claimed.id }, data: { status: 'FAILED', error: message, completedAt: new Date() } }));
      throw err; // the job retries with backoff; the next attempt flips the row back to RUNNING
    }
  });
}
