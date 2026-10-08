import { Inject, Injectable } from '@nestjs/common';
import type IORedis from 'ioredis';
import { sha256Hex, tooManyRequests, type AppConfig, type Logger } from '@uk/core';
import type { Database } from '@uk/db';
import { AuditService } from '../audit/audit.service';
import { CONFIG, DB, LOGGER, REDIS } from '../common/tokens';

/**
 * Layered sign-in protection. Goals: stop brute force / password spraying WITHOUT letting an attacker
 * lock the real owner out (account-lockout DoS), and never reveal whether an email address exists.
 *
 *  1. IP + account pair : progressive delay after N failures, temporary block after M. Only the attacker's
 *                         own (IP, email) combination is penalised; the owner on another IP is unaffected.
 *  2. Per IP            : volume of failures and number of DISTINCT accounts tried (password spraying).
 *  3. Per account       : distributed-attack detector (many failures from several IPs). It never blocks the
 *                         owner's usual locations: only sign-ins from IPs that have not previously succeeded
 *                         for that account are refused (generically).
 *
 * Counters are keyed on hashed email regardless of whether the account exists, so every layer behaves
 * identically for real and unknown addresses. State transitions are audited and every throttle decision is
 * logged in structured form.
 */
@Injectable()
export class LoginThrottle {
  constructor(
    @Inject(REDIS) private readonly redis: IORedis,
    @Inject(CONFIG) private readonly c: AppConfig,
    @Inject(DB) private readonly db: Database,
    @Inject(LOGGER) private readonly logger: Logger,
    private readonly audit: AuditService,
  ) {}

  private ipH = (ip: string) => sha256Hex(ip || 'unknown').slice(0, 16);
  private acctH = (email: string) => sha256Hex(email.trim().toLowerCase()).slice(0, 32);
  private pairKey = (ip: string, email: string) => `lt:pair:${this.ipH(ip)}:${this.acctH(email)}`;

  /** Call BEFORE verifying credentials. Throws 429 (same shape for real and unknown accounts). */
  async check(ip: string, email: string): Promise<void> {
    const now = Date.now();
    const [ipBlock, pair] = await Promise.all([this.redis.pttl(`lt:ipblock:${this.ipH(ip)}`), this.redis.hmget(this.pairKey(ip, email), 'blockedUntil', 'nextAt')]);
    if (ipBlock > 0) return this.reject('ip_blocked', ip, email, Math.ceil(ipBlock / 1000));
    const blockedUntil = Number(pair[0] ?? 0), nextAt = Number(pair[1] ?? 0);
    if (blockedUntil > now) return this.reject('pair_blocked', ip, email, Math.ceil((blockedUntil - now) / 1000));
    if (nextAt > now) return this.reject('progressive_delay', ip, email, Math.ceil((nextAt - now) / 1000));
  }

  private reject(reason: string, ip: string, email: string, retryAfter: number): never {
    this.logger.warn({ event: 'auth.login_throttled', reason, ipHash: this.ipH(ip), accountHash: this.acctH(email), retryAfter }, 'login throttled');
    throw tooManyRequests(Math.max(1, retryAfter));
  }

  /** True while a distributed attack on this account is in progress. */
  accountUnderPressure(email: string): Promise<boolean> {
    return this.redis.exists(`lt:acctlock:${this.acctH(email)}`).then((n) => n === 1);
  }

  async isTrustedIp(userId: string, ip: string): Promise<boolean> {
    return !!(await this.db.prisma.loginTrustedIp.findUnique({ where: { userId_ipHash: { userId, ipHash: this.ipH(ip) } } }));
  }

  async recordFailure(ip: string, email: string, actorUserId?: string): Promise<void> {
    const c = this.c, ipH = this.ipH(ip), acct = this.acctH(email);
    const ctx = { ipHash: ipH, accountHash: acct };

    // 1. pair
    const pk = this.pairKey(ip, email);
    const fails = await this.redis.hincrby(pk, 'fails', 1);
    await this.redis.expire(pk, 3600);
    if (c.LOGIN_DELAY_BASE_SECONDS > 0 && fails >= c.LOGIN_DELAY_START) {
      const delay = Math.min(c.LOGIN_DELAY_BASE_SECONDS * 2 ** (fails - c.LOGIN_DELAY_START), 900);
      await this.redis.hset(pk, 'nextAt', Date.now() + delay * 1000);
    }
    if (fails >= c.LOGIN_PAIR_BLOCK_AT) {
      await this.redis.hset(pk, { blockedUntil: Date.now() + c.LOGIN_PAIR_BLOCK_MINUTES * 60_000, fails: 0, nextAt: 0 });
      this.logger.warn({ event: 'auth.pair_blocked', ...ctx, fails }, 'ip+account pair temporarily blocked');
      await this.audit.record({ action: 'auth.pair_blocked', outcome: 'DENIED', actorUserId, metadata: { fails, minutes: c.LOGIN_PAIR_BLOCK_MINUTES } });
    }

    // 2. IP: volume + spraying (distinct accounts)
    const ipFails = await this.redis.incr(`lt:ip:${ipH}`);
    await this.redis.expire(`lt:ip:${ipH}`, 900);
    await this.redis.sadd(`lt:ipacct:${ipH}`, acct);
    await this.redis.expire(`lt:ipacct:${ipH}`, 900);
    const distinct = await this.redis.scard(`lt:ipacct:${ipH}`);
    if ((ipFails >= c.LOGIN_IP_BLOCK_AT || distinct >= c.LOGIN_IP_DISTINCT_ACCOUNTS) && !(await this.redis.exists(`lt:ipblock:${ipH}`))) {
      await this.redis.set(`lt:ipblock:${ipH}`, '1', 'EX', c.LOGIN_IP_BLOCK_MINUTES * 60);
      this.logger.warn({ event: 'auth.ip_blocked', ipHash: ipH, ipFails, distinct }, 'ip temporarily blocked (brute force / spraying)');
      await this.audit.record({ action: 'auth.ip_blocked', outcome: 'DENIED', metadata: { ipFails, distinctAccounts: distinct } });
    }

    // 3. account: distributed attack detector
    const acctFails = await this.redis.incr(`lt:acct:${acct}`);
    await this.redis.expire(`lt:acct:${acct}`, 3600);
    await this.redis.sadd(`lt:acctips:${acct}`, ipH);
    await this.redis.expire(`lt:acctips:${acct}`, 3600);
    const ips = await this.redis.scard(`lt:acctips:${acct}`);
    if (acctFails >= c.LOGIN_ACCOUNT_PRESSURE_AT && ips >= 3 && !(await this.redis.exists(`lt:acctlock:${acct}`))) {
      await this.redis.set(`lt:acctlock:${acct}`, '1', 'EX', c.LOGIN_ACCOUNT_PRESSURE_MINUTES * 60);
      this.logger.warn({ event: 'auth.account_under_attack', accountHash: acct, acctFails, distinctIps: ips }, 'distributed attack on account');
      await this.audit.record({ action: 'auth.account_under_attack', outcome: 'DENIED', actorUserId, metadata: { acctFails, distinctIps: ips, minutes: c.LOGIN_ACCOUNT_PRESSURE_MINUTES } });
    }
    this.logger.info({ event: 'auth.login_failure_recorded', ...ctx, pairFails: fails }, 'login failure recorded');
  }

  async recordSuccess(ip: string, email: string, userId: string): Promise<void> {
    await this.redis.del(this.pairKey(ip, email));
    await this.db.prisma.loginTrustedIp.upsert({
      where: { userId_ipHash: { userId, ipHash: this.ipH(ip) } },
      create: { userId, ipHash: this.ipH(ip) }, update: { lastSuccessAt: new Date() },
    });
  }
}
