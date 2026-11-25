// Configuration of the self-hosted server: environment variables only (no config file), with
// `<NAME>_FILE` variants for secrets (Docker/Unraid secrets). Validation collects every problem so
// a misconfigured container reports all of them at once and refuses to start.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { proxyMatcher, DEFAULT_TRUSTED_PROXIES } from './http/request.mjs';

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.problems = problems;
  }
}

const SECRET_KEYS = ['WICKLINE_PASSWORD', 'WICKLINE_PASSWORD_HASH', 'WICKLINE_TOTP_SECRET'];

/** Reads NAME, or the file named by NAME_FILE (trailing newline trimmed). */
function secret(env, name, readFile, problems) {
  const file = env[`${name}_FILE`];
  if (file) {
    try { return readFile(file, 'utf8').replace(/\r?\n$/, ''); } catch (e) { problems.push(`${name}_FILE: cannot read ${file} (${e.code || e.message})`); return ''; }
  }
  return env[name] ?? '';
}

const bool = (v, def = false) => (v == null || v === '' ? def : /^(1|true|yes|on)$/i.test(String(v)));

function int(env, name, def, { min, max }, problems) {
  const raw = env[name];
  if (raw == null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) { problems.push(`${name} must be an integer between ${min} and ${max} (got "${raw}")`); return def; }
  return n;
}

/**
 * TRUST_PROXY: how many reverse proxies in front of the container may set X-Forwarded-*.
 * false/0 = none (default), true = 1, or a number.
 */
function trustProxy(raw, problems) {
  if (raw == null || raw === '' || /^(0|false|no|off)$/i.test(raw)) return 0;
  if (/^(true|yes|on)$/i.test(raw)) return 1;
  const n = Number(raw);
  if (Number.isInteger(n) && n > 0 && n < 10) return n;
  problems.push(`TRUST_PROXY must be false, true or a number of proxies (got "${raw}")`);
  return 0;
}

export function loadConfig(env = process.env, { readFile = readFileSync } = {}) {
  const problems = [];
  const exposure = (env.EXPOSURE || 'private').toLowerCase();
  if (!['private', 'public'].includes(exposure)) problems.push(`EXPOSURE must be "private" or "public" (got "${env.EXPOSURE}")`);
  const authMode = (env.AUTH_MODE || 'password').toLowerCase();
  if (!['password', 'none'].includes(authMode)) problems.push(`AUTH_MODE must be "password" or "none" (got "${env.AUTH_MODE}")`);

  const cookieSecure = (env.COOKIE_SECURE || 'auto').toLowerCase();
  if (!['auto', 'true', 'false'].includes(cookieSecure)) problems.push('COOKIE_SECURE must be auto, true or false');

  const cfg = {
    port: int(env, 'PORT', 5173, { min: 0, max: 65535 }, problems),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || '/data'),
    exposure,
    authMode,
    password: secret(env, 'WICKLINE_PASSWORD', readFile, problems),
    passwordHash: secret(env, 'WICKLINE_PASSWORD_HASH', readFile, problems),
    totpSecret: secret(env, 'WICKLINE_TOTP_SECRET', readFile, problems).replace(/[\s-]/g, '').toUpperCase(),
    trustProxy: trustProxy(env.TRUST_PROXY, problems),
    trustedProxyIps: (env.TRUSTED_PROXY_IPS ? env.TRUSTED_PROXY_IPS.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_TRUSTED_PROXIES),
    cookieSecure,
    sessionDays: int(env, 'SESSION_DAYS', 30, { min: 1, max: 365 }, problems),
    allowApiTokens: exposure === 'public' ? bool(env.ALLOW_API_TOKENS_PUBLIC) : bool(env.ALLOW_API_TOKENS, true),
    shutdownTimeoutMs: int(env, 'SHUTDOWN_TIMEOUT_MS', 10000, { min: 1000, max: 120000 }, problems),
    logLevel: (env.LOG_LEVEL || 'info').toLowerCase(),
    testMode: bool(env.SELFHOST_TEST_MODE),
    syncWorkspace: bool(env.SYNC_WORKSPACE, true),
  };

  if (!['debug', 'info', 'warn', 'error'].includes(cfg.logLevel)) problems.push('LOG_LEVEL must be debug, info, warn or error');
  const hm = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.exec(cfg.passwordHash);
  if (cfg.passwordHash && !hm) problems.push('WICKLINE_PASSWORD_HASH is not a hash produced by `node selfhost/cli.mjs hash-password`');
  else if (hm) {
    const [N, r, p] = [Number(hm[1]), Number(hm[2]), Number(hm[3])];
    // Bounds keep a hostile hash from exhausting memory or CPU on every login.
    if (N < 2 ** 14 || N > 2 ** 17 || (N & (N - 1)) !== 0 || r < 1 || r > 16 || p < 1 || p > 4) {
      problems.push('WICKLINE_PASSWORD_HASH has unsupported scrypt parameters (N must be a power of two from 2^14 to 2^17, r 1-16, p 1-4); create it with `node selfhost/cli.mjs hash-password`');
    }
  }
  try { cfg.isTrustedProxy = proxyMatcher(cfg.trustedProxyIps); } catch (e) { problems.push(`TRUSTED_PROXY_IPS: ${e.message}`); }
  if (cfg.totpSecret && !/^[A-Z2-7]{16,}=*$/.test(cfg.totpSecret)) problems.push('WICKLINE_TOTP_SECRET must be base32 (16+ characters), e.g. from `node selfhost/cli.mjs totp-setup`');
  if (cfg.password && cfg.password.length < 12) problems.push('WICKLINE_PASSWORD must be at least 12 characters');

  if (authMode === 'password' && !cfg.password && !cfg.passwordHash) {
    problems.push('Set WICKLINE_PASSWORD_HASH (recommended) or WICKLINE_PASSWORD. Generate a hash with: node selfhost/cli.mjs hash-password');
  }
  if (authMode === 'none' && !bool(env.I_UNDERSTAND_NO_AUTH)) {
    problems.push('AUTH_MODE=none disables login; set I_UNDERSTAND_NO_AUTH=true to confirm (private networks only)');
  }

  if (exposure === 'public') {
    if (authMode === 'none') problems.push('EXPOSURE=public requires AUTH_MODE=password');
    if (!cfg.passwordHash) problems.push('EXPOSURE=public requires WICKLINE_PASSWORD_HASH (a plain-text WICKLINE_PASSWORD is not accepted)');
    if (cfg.password) problems.push('EXPOSURE=public does not accept WICKLINE_PASSWORD; use WICKLINE_PASSWORD_HASH');
    if (!cfg.totpSecret) problems.push('EXPOSURE=public requires a second factor: set WICKLINE_TOTP_SECRET (node selfhost/cli.mjs totp-setup)');
    if (!cfg.trustProxy) problems.push('EXPOSURE=public requires TRUST_PROXY (HTTPS must terminate at a reverse proxy or tunnel)');
    if (cookieSecure === 'false') problems.push('EXPOSURE=public requires secure cookies (COOKIE_SECURE cannot be false)');
  }

  if (cfg.testMode && env.NODE_ENV === 'production' && !bool(env.SELFHOST_ALLOW_TEST_MODE)) {
    problems.push('SELFHOST_TEST_MODE is not allowed when NODE_ENV=production');
  }

  if (problems.length) throw new ConfigError(problems);
  return cfg;
}

/** The configuration with secrets replaced, for logs and diagnostics. */
export function redacted(cfg) {
  const out = { ...cfg };
  for (const k of ['password', 'passwordHash', 'totpSecret']) out[k] = cfg[k] ? '[set]' : '';
  return out;
}

export const secretEnvNames = () => SECRET_KEYS.flatMap((k) => [k, `${k}_FILE`]);
