import type { FieldEncryption } from '@uk/core';
import type { JobDefinition } from '@uk/contracts';

/** Sensitive job payloads are encrypted before they reach Redis or Postgres. */
export function encodePayload(def: JobDefinition, payload: unknown, crypto: FieldEncryption): unknown {
  return def.sensitive ? { __enc: crypto.encrypt(JSON.stringify(payload), def.type) } : payload;
}

export function decodePayload(def: JobDefinition, stored: unknown, crypto: FieldEncryption): unknown {
  if (stored && typeof stored === 'object' && '__enc' in (stored as object)) {
    return JSON.parse(crypto.decrypt((stored as { __enc: string }).__enc, def.type));
  }
  return stored;
}
