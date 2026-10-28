import { createHash } from 'node:crypto';

/**
 * The Companies House port (V3-M3, DEC-095). The platform has no Companies House connection: the only adapter is `fake`, which answers so the
 * filing workflow can be exercised end to end. A real adapter (the software filing interface, presenter credentials) is a later decision.
 * Production refuses the fake adapter at start (packages/core/src/config.ts).
 */
export interface ChSubmission { companyNumber: string; documentSha256: string; content: string; idempotencyKey: string }
export interface ChSubmitted { submissionId: string; request: Record<string, unknown>; response: Record<string, unknown> }
export interface ChStatus { status: 'PENDING' | 'ACCEPTED' | 'REJECTED'; reference: string | null; reasons: string[]; response: Record<string, unknown> }
export interface CompaniesHousePort { readonly name: string; submit(s: ChSubmission): Promise<ChSubmitted>; status(submissionId: string, companyNumber: string): Promise<ChStatus> }

export class FakeCompaniesHouseAdapter implements CompaniesHousePort {
  readonly name = 'fake';
  /** The same idempotency key always gives the same submission. */
  async submit(s: ChSubmission): Promise<ChSubmitted> {
    const submissionId = `FAKE-${createHash('sha256').update(s.idempotencyKey).digest('hex').slice(0, 16).toUpperCase()}`;
    return { submissionId, request: { companyNumber: s.companyNumber, documentSha256: s.documentSha256, bytes: Buffer.byteLength(s.content), idempotencyKey: s.idempotencyKey },
      response: { fake: true, submissionId, received: true } };
  }
  /** Accepts every submission except for a company number starting 99, which it rejects so rejection can be tested. */
  async status(submissionId: string, companyNumber: string): Promise<ChStatus> {
    if (companyNumber.startsWith('99')) return { status: 'REJECTED', reference: null, reasons: ['FAKE: the company number is not on the register (test rejection)'], response: { fake: true, submissionId, status: 'REJECTED' } };
    return { status: 'ACCEPTED', reference: `${submissionId}-ACC`, reasons: [], response: { fake: true, submissionId, status: 'ACCEPTED' } };
  }
}
