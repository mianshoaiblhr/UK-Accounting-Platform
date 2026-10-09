import { Prisma } from '@uk/db';

/** Exact decimal arithmetic for money (never JS numbers). Amounts cross the API as decimal strings. */
export type Money = Prisma.Decimal;
export const money = (v: string | number | Money): Money => new Prisma.Decimal(v);
export const ZERO: Money = money(0);
/** Rendered at the currency's minor units (stored values are already rounded to them by the database guard). */
export const fmt = (v: Money, minorUnits: number): string => v.toFixed(minorUnits);
export const decimalPlaces = (v: Money): number => v.decimalPlaces();
