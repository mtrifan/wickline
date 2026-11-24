import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../../auth/password.mjs';
import { base32Encode, base32Decode, hotp, totp, verifyTotp, counterAt, generateSecret, otpauthUri } from '../../auth/totp.mjs';
import { createLoginLimiter } from '../../auth/rate-limit.mjs';

test('scrypt hashes verify, reject wrong passwords and absurd parameters', () => {
  const h = hashPassword('correct horse battery', { N: 1024 });
  assert.match(h, /^scrypt\$1024\$8\$1\$/);
  assert.ok(verifyPassword('correct horse battery', h));
  assert.ok(!verifyPassword('correct horse batterY', h));
  assert.ok(!verifyPassword('correct horse battery', 'plain'));
  assert.ok(!verifyPassword('x', h.replace('$1024$', '$9999999$')), 'refuses huge N');
  assert.equal(verifyPassword('x', h.replace('$1024$', '$1000$')), false, 'invalid N (not a power of two) is a failed attempt, not an exception');
  assert.throws(() => hashPassword('short'));
  assert.notEqual(hashPassword('correct horse battery', { N: 1024 }), h, 'salted');
});

// RFC 6238 appendix B (SHA-1): ASCII secret "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
test('TOTP matches the RFC 6238 SHA-1 test vectors', () => {
  const vectors = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [t, code] of vectors) assert.equal(hotp(base32Decode(RFC_SECRET), counterAt(t * 1000), 8), code, `t=${t}`);
  assert.equal(totp(RFC_SECRET, 59_000), '287082');
});

test('TOTP verification: window, replay protection, format', () => {
  const s = generateSecret();
  const t = 1_700_000_000_000;
  const code = totp(s, t);
  const c = verifyTotp(s, code, { timeMs: t });
  assert.equal(c, counterAt(t));
  assert.equal(verifyTotp(s, code, { timeMs: t + 30_000 }), c, 'one step of clock drift is accepted');
  assert.equal(verifyTotp(s, code, { timeMs: t + 90_000 }), null, 'old codes expire');
  assert.equal(verifyTotp(s, code, { timeMs: t, lastCounter: c }), null, 'a used code cannot be replayed');
  assert.equal(verifyTotp(s, '12345', { timeMs: t }), null);
  assert.equal(verifyTotp(s, 'abcdef', { timeMs: t }), null);
  assert.deepEqual(base32Decode(base32Encode(Buffer.from('hello world'))), Buffer.from('hello world'));
  assert.match(otpauthUri(s, 'me'), /^otpauth:\/\/totp\/Wickline%20Self-Hosted:me\?secret=[A-Z2-7]+&/);
});

test('login limiter: growing per-client delay, no lockout, optional global spacing', () => {
  let now = 0;
  const l = createLoginLimiter({ baseMs: 1000, maxMs: 8000, now: () => now });
  assert.equal(l.retryAfter('a'), 0);
  l.fail('a'); assert.equal(l.retryAfter('a'), 1000);
  now += 1000; l.fail('a'); assert.equal(l.retryAfter('a'), 2000);
  for (let i = 0; i < 10; i++) { now += 10_000; l.fail('a'); }
  assert.equal(l.retryAfter('a'), 8000, 'capped, never a lockout');
  assert.equal(l.retryAfter('b'), 0, 'other clients unaffected');
  l.succeed('a'); assert.equal(l.retryAfter('a'), 0);

  const g = createLoginLimiter({ globalSpacingMs: 1000, now: () => now });
  g.fail('x');
  assert.equal(g.retryAfter('y'), 1000, 'public mode slows everyone briefly after a failure');
});
