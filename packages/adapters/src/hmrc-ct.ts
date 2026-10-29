import { createHash } from 'node:crypto';

/**
 * The HMRC Corporation Tax port (V4-M5, DEC-102). The platform has no HMRC connection: the only adapter is `fake`, which answers so the CT return
 * workflow can be exercised end to end. A real adapter (the GovTalk envelope, HMRC's schema, credentials) is a later decision by the owner.
 * Production refuses the fake adapter at start (packages/core/src/config.ts).
 */
export interface CtSubmission { utr: string; periodEnd: string; payloadSha256: string; idempotencyKey: string; package: Record<string, unknown> }
export interface CtSubmitted { submissionId: string; request: Record<string, unknown>; response: Record<string, unknown> }
export interface CtStatus { status: 'PENDING' | 'ACCEPTED' | 'REJECTED'; reference: string | null; reasons: string[]; response: Record<string, unknown> }
export interface HmrcCtPort { readonly name: string; submit(s: CtSubmission): Promise<CtSubmitted>; status(submissionId: string, utr: string): Promise<CtStatus> }

export class FakeHmrcCtAdapter implements HmrcCtPort {
  readonly name = 'fake';
  /** The same idempotency key always gives the same submission. */
  async submit(s: CtSubmission): Promise<CtSubmitted> {
    const submissionId = `FAKE-CT-${createHash('sha256').update(s.idempotencyKey).digest('hex').slice(0, 16).toUpperCase()}`;
    return { submissionId, request: { utr: s.utr, periodEnd: s.periodEnd, payloadSha256: s.payloadSha256, idempotencyKey: s.idempotencyKey }, response: { fake: true, submissionId, received: true } };
  }
  /** Accepts every submission except for a UTR starting 99, which it rejects so rejection can be tested. */
  async status(submissionId: string, utr: string): Promise<CtStatus> {
    if (utr.startsWith('99')) return { status: 'REJECTED', reference: null, reasons: ['FAKE: the UTR is not recognised (test rejection)'], response: { fake: true, submissionId, status: 'REJECTED' } };
    return { status: 'ACCEPTED', reference: `${submissionId}-IRMARK`, reasons: [], response: { fake: true, submissionId, status: 'ACCEPTED' } };
  }
}
