import { z } from 'zod';

const COMMON = new Set(['password', 'password1', 'password123', 'qwerty123', 'letmein123', '123456789012', 'iloveyou123']);

/** NIST 800-63B style: length over composition, block trivially common values. */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((p) => !COMMON.has(p.toLowerCase()), 'Password is too common')
  .refine((p) => new Set(p).size >= 5, 'Password is too repetitive');
