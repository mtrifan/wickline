// Password hashing with scrypt (node:crypto). Format: scrypt$N$r$p$<salt b64>$<hash b64>.

import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const DEFAULTS = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };
const maxmem = (N, r) => 256 * N * r; // scrypt needs ~128*N*r bytes; leave headroom

export function hashPassword(password, { N = DEFAULTS.N, r = DEFAULTS.r, p = DEFAULTS.p } = {}) {
  if (typeof password !== 'string' || password.length < 12) throw new Error('Password must be at least 12 characters');
  const salt = randomBytes(16);
  const hash = scryptSync(password.normalize('NFKC'), salt, DEFAULTS.keylen, { N, r, p, maxmem: maxmem(N, r) });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(stored || '');
  if (!m || typeof password !== 'string') return false;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (N > 2 ** 20 || r > 32 || p > 16) return false; // refuse absurd parameters (DoS)
  const expected = Buffer.from(m[5], 'base64');
  const actual = scryptSync(password.normalize('NFKC'), Buffer.from(m[4], 'base64'), expected.length, { N, r, p, maxmem: maxmem(N, r) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
