import { CallHandler, ExecutionContext, Inject, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, from, of } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { conflict, sha256Hex, unprocessable } from '@uk/core';
import type { Database } from '@uk/db';
import { IDEMPOTENT } from './decorators';
import { DB } from './tokens';
import type { AppRequest } from './types';

/**
 * Opt-in via @Idempotent(). With an `Idempotency-Key` header, a retried request replays the stored
 * response instead of repeating the side effect. Same key + different payload => 422.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector, @Inject(DB) private readonly db: Database) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.reflector.getAllAndOverride<boolean>(IDEMPOTENT, [ctx.getHandler(), ctx.getClass()])) return next.handle();
    const http = ctx.switchToHttp();
    const req = http.getRequest<AppRequest & { body: unknown }>();
    const res = http.getResponse<{ statusCode: number; setHeader(k: string, v: string): void }>();
    const key = req.header('idempotency-key');
    if (!key || !req.org) return next.handle();
    if (key.length > 200) throw unprocessable('Idempotency-Key too long', 'invalid_idempotency_key');

    const organisationId = req.org.organisationId;
    const userId = req.org.userId;
    const requestHash = sha256Hex(`${req.method}|${req.path}|${JSON.stringify(req.body ?? null)}`);

    return from((async () => {
      const existing = await this.db.tenant({ organisationId, userId }, (tx) => tx.idempotencyRecord.findUnique({ where: { organisationId_key: { organisationId, key } } }));
      if (existing) {
        if (existing.requestHash !== requestHash) throw unprocessable('Idempotency-Key was already used with a different request', 'idempotency_key_reused');
        if (existing.status === 'IN_PROGRESS') throw conflict('A request with this Idempotency-Key is still in progress', 'idempotency_in_progress');
        return { replay: existing };
      }
      try {
        await this.db.tenant({ organisationId, userId }, (tx) => tx.idempotencyRecord.create({
          data: { organisationId, key, requestHash, expiresAt: new Date(Date.now() + 24 * 3600_000) } }));
      } catch {
        throw conflict('A request with this Idempotency-Key is still in progress', 'idempotency_in_progress');
      }
      return { replay: null };
    })()).pipe(
      mergeMap(({ replay }) => {
        if (replay) {
          res.statusCode = replay.responseStatus ?? 200;
          res.setHeader('Idempotent-Replayed', 'true');
          return of(replay.responseBody);
        }
        return next.handle().pipe(
          mergeMap((body) => from((async () => {
            await this.db.tenant({ organisationId, userId }, (tx) => tx.idempotencyRecord.update({
              where: { organisationId_key: { organisationId, key } },
              data: { status: 'COMPLETED', responseStatus: res.statusCode, responseBody: (body ?? null) as never } }));
            return body;
          })())),
          catchError((err) => from((async () => {
            // Failed requests are not cached: the client may retry with the same key.
            await this.db.tenant({ organisationId, userId }, (tx) => tx.idempotencyRecord.deleteMany({ where: { organisationId, key } })).catch(() => undefined);
            throw err;
          })())),
        );
      }),
    );
  }
}
