// Request helpers: client address/protocol/host behind trusted proxies, cookies, bodies, and the
// same-origin check used as CSRF protection for every state-changing request.

/** Last `n` values of a comma-separated forwarded header, nearest proxy last. */
const forwarded = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * { ip, proto, host } for a request. X-Forwarded-* headers are honoured only for the configured
 * number of trusted proxies (TRUST_PROXY); otherwise the socket is the truth.
 */
export function clientInfo(req, trustProxy = 0) {
  const socketIp = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  const base = { ip: socketIp, proto: req.socket?.encrypted ? 'https' : 'http', host: String(req.headers.host || '') };
  if (!trustProxy) return base;
  const xff = forwarded(req.headers['x-forwarded-for']);
  // With N trusted proxies, the client is the N-th entry from the right (each proxy appends one).
  const ip = xff.length >= trustProxy ? xff[xff.length - trustProxy] : (xff[0] || socketIp);
  const proto = forwarded(req.headers['x-forwarded-proto']).at(-1)?.toLowerCase();
  const host = forwarded(req.headers['x-forwarded-host']).at(-1);
  return { ip: ip.replace(/^::ffff:/, ''), proto: proto === 'https' || proto === 'http' ? proto : base.proto, host: host || base.host };
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) { try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip malformed */ } }
  }
  return out;
}

export function serializeCookie(name, value, { maxAgeSec, secure, httpOnly = true, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAgeSec != null) c += `; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  return c;
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Reads the request body up to `limit` bytes (413 beyond). */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) { reject(new HttpError(413, 'Request body too large')); req.resume(); return; }
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parses a JSON or urlencoded body into a plain object. */
export async function readForm(req, limit) {
  const raw = (await readBody(req, limit)).toString('utf8');
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json') {
    try { const v = JSON.parse(raw || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* fall through */ }
    throw new HttpError(400, 'Invalid JSON body');
  }
  if (type === 'application/x-www-form-urlencoded' || type === '') return Object.fromEntries(new URLSearchParams(raw));
  throw new HttpError(415, 'Unsupported content type');
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Same-origin check for state-changing requests: Origin (or, failing that, Referer) must name the
 * host the request was sent to. Combined with SameSite cookies this blocks cross-site requests.
 */
export function sameOrigin(req, info) {
  if (SAFE.has(req.method)) return true;
  const source = req.headers.origin || req.headers.referer;
  if (!source || source === 'null') return false;
  try {
    const u = new URL(source);
    return u.host.toLowerCase() === info.host.toLowerCase() && u.protocol === `${info.proto}:`;
  } catch {
    return false;
  }
}

/** A post-login redirect target limited to this site (no open redirects). */
export function safeNext(next) {
  const s = String(next || '/');
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || /[\r\n]/.test(s)) return '/';
  if (s.startsWith('/selfhost/login')) return '/';
  return s.slice(0, 2000);
}
