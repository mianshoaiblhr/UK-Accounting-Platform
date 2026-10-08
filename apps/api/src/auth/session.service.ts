import { Inject, Injectable } from '@nestjs/common';
import { generateToken, sha256Hex, type AppConfig } from '@uk/core';
import type { Database } from '@uk/db';
import { CONFIG, DB } from '../common/tokens';

export interface ResolvedSession {
  userId: string; sessionId: string; email: string; displayName: string; mfaVerifiedAt: Date | null;
}

@Injectable()
export class SessionService {
  constructor(@Inject(DB) private readonly db: Database, @Inject(CONFIG) private readonly config: AppConfig) {}

  async create(userId: string, meta: { ip?: string; userAgent?: string; authMethod: string; mfaVerified: boolean }) {
    const token = generateToken(32);
    const now = Date.now();
    const absolute = new Date(now + this.config.SESSION_ABSOLUTE_HOURS * 3600_000);
    const idle = new Date(Math.min(now + this.config.SESSION_IDLE_MINUTES * 60_000, absolute.getTime()));
    const s = await this.db.prisma.session.create({
      data: {
        userId, tokenHash: sha256Hex(token), authMethod: meta.authMethod, ip: meta.ip, userAgent: meta.userAgent,
        mfaVerifiedAt: meta.mfaVerified ? new Date() : null, idleExpiresAt: idle, absoluteExpiresAt: absolute,
      },
    });
    return { token, session: s, expiresAt: absolute };
  }

  async resolve(token: string): Promise<ResolvedSession | null> {
    const s = await this.db.prisma.session.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { user: true } });
    const now = new Date();
    if (!s || s.revokedAt || s.idleExpiresAt <= now || s.absoluteExpiresAt <= now || s.user.status !== 'ACTIVE') return null;
    // Sliding idle window; write at most once a minute.
    if (now.getTime() - s.lastSeenAt.getTime() > 60_000) {
      const idle = new Date(Math.min(now.getTime() + this.config.SESSION_IDLE_MINUTES * 60_000, s.absoluteExpiresAt.getTime()));
      await this.db.prisma.session.update({ where: { id: s.id }, data: { lastSeenAt: now, idleExpiresAt: idle } });
    }
    return { userId: s.userId, sessionId: s.id, email: s.user.email, displayName: s.user.displayName, mfaVerifiedAt: s.mfaVerifiedAt };
  }

  revoke(sessionId: string, userId: string, reason: string) {
    return this.db.prisma.session.updateMany({ where: { id: sessionId, userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: reason } });
  }

  revokeAll(userId: string, reason: string, exceptSessionId?: string) {
    return this.db.prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
  }

  list(userId: string) {
    return this.db.prisma.session.findMany({
      where: { userId, revokedAt: null, absoluteExpiresAt: { gt: new Date() }, idleExpiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, lastSeenAt: true, ip: true, userAgent: true, authMethod: true, mfaVerifiedAt: true },
    });
  }
}
