// Time-based one-time passwords (RFC 6238, HMAC-SHA1, 30 s steps, 6 digits), compatible with
// common authenticator apps. No dependencies.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const generateSecret = () => base32Encode(randomBytes(20));

/** The code for a given counter (RFC 4226 HOTP). */
export function hotp(key, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const counterAt = (timeMs, step = 30) => Math.floor(timeMs / 1000 / step);
export const totp = (secret, timeMs = Date.now(), digits = 6) => hotp(base32Decode(secret), counterAt(timeMs), digits);

/**
 * Checks a code within ±window steps. Returns the matched counter, or null. A counter at or below
 * `lastCounter` is rejected, so an observed code cannot be replayed.
 */
export function verifyTotp(secret, code, { timeMs = Date.now(), window = 1, lastCounter = -1 } = {}) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const key = base32Decode(secret);
  const now = counterAt(timeMs);
  for (let c = now - window; c <= now + window; c++) {
    if (c <= lastCounter) continue;
    const expected = Buffer.from(hotp(key, c));
    if (timingSafeEqual(expected, Buffer.from(String(code)))) return c;
  }
  return null;
}

export const otpauthUri = (secret, label = 'wickline', issuer = 'Wickline Self-Hosted') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
