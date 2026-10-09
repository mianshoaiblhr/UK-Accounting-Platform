import { createHash } from 'node:crypto';
import type { AppConfig } from '@uk/core';

/**
 * OCR provider port (specification §10: AIProvider -> OCRProvider -> Embedding/Search). The document pipeline depends on this interface
 * only; a real engine (e.g. a cloud OCR service in an approved UK region) is added behind it with no change to business code.
 * Output is DATA about a document version. It never posts, files or approves anything.
 */
export interface OcrInput { data: Buffer; contentType: string; filename: string }
export interface OcrResult { text: string; pages: number; confidence: number | null; language?: string; engineVersion: string }
export interface OcrProvider {
  readonly name: string;
  supports(contentType: string): boolean;
  extract(input: OcrInput): Promise<OcrResult>;
}

/** Content types an OCR engine is asked to read. */
export const OCR_CONTENT_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff'] as const;

/**
 * Deterministic engine for development and tests (never registered in production): returns the printable ASCII runs of the file and a
 * page count, so pipeline behaviour (flag, retries, visibility, final results) is testable without a network or a real engine.
 */
export class FakeOcrProvider implements OcrProvider {
  readonly name = 'fake';
  /** Number of upcoming calls that fail (tests use this to exercise retries). */
  failTimes = 0;
  supports(contentType: string) { return (OCR_CONTENT_TYPES as readonly string[]).includes(contentType); }
  async extract(input: OcrInput): Promise<OcrResult> {
    if (this.failTimes > 0) { this.failTimes--; throw new Error('fake OCR engine unavailable'); }
    const text = (input.data.toString('latin1').match(/[\x20-\x7e]{4,}/g) ?? []).join('\n');
    const pages = Math.max(1, (input.data.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length);
    return { text, pages, confidence: 0.5, language: 'en', engineVersion: `fake-1:${createHash('sha256').update(input.data).digest('hex').slice(0, 8)}` };
  }
}

/** The only place an engine is chosen. `none` means the pipeline stops after scanning. */
export const createOcrProvider = (c: AppConfig): OcrProvider | undefined => (c.OCR_PROVIDER === 'fake' && !c.isProduction ? new FakeOcrProvider() : undefined);
