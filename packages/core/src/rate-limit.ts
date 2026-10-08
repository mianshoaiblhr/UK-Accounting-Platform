import type { Redis } from 'ioredis';
import { tooManyRequests } from './errors';

export interface RateLimitResult { allowed: boolean; remaining: number; retryAfterSeconds: number }

/** Fixed-window limiter on Redis. Shared across API instances. */
export class RateLimiter {
  constructor(private readonly redis: Redis, private readonly prefix = 'rl') {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const k = `${this.prefix}:${key}`;
    const count = await this.redis.incr(k);
    if (count === 1) await this.redis.expire(k, windowSeconds);
    let ttl = await this.redis.ttl(k);
    if (ttl < 0) { await this.redis.expire(k, windowSeconds); ttl = windowSeconds; }
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSeconds: ttl };
  }

  async enforce(key: string, limit: number, windowSeconds: number): Promise<void> {
    const r = await this.hit(key, limit, windowSeconds);
    if (!r.allowed) throw tooManyRequests(r.retryAfterSeconds);
  }
}
