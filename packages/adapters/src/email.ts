import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { Logger } from '@uk/core';

export interface OutboundEmail { to: string; subject: string; text: string }
export interface EmailPort { send(email: OutboundEmail): Promise<void> }

export class SesEmail implements EmailPort {
  private readonly ses: SESv2Client;
  constructor(region: string, private readonly from: string) { this.ses = new SESv2Client({ region }); }
  async send(e: OutboundEmail) {
    await this.ses.send(new SendEmailCommand({
      FromEmailAddress: this.from,
      Destination: { ToAddresses: [e.to] },
      Content: { Simple: { Subject: { Data: e.subject }, Body: { Text: { Data: e.text } } } },
    }));
  }
}

/** Logs only metadata (never the body: it may contain one-time tokens). */
export class ConsoleEmail implements EmailPort {
  constructor(private readonly logger: Logger) {}
  async send(e: OutboundEmail) { this.logger.info({ to: e.to, subject: e.subject }, 'email (console driver)'); }
}

/** Writes JSON files; used by E2E tests and local development. Not allowed in production. */
export class FileEmail implements EmailPort {
  constructor(private readonly dir: string) {}
  async send(e: OutboundEmail) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(e, null, 2));
  }
}

export class MemoryEmail implements EmailPort {
  readonly sent: OutboundEmail[] = [];
  async send(e: OutboundEmail) { this.sent.push(e); }
}
