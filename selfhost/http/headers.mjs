// Response headers. Upstream answers every API request with `Access-Control-Allow-Origin: *`,
// set through res.writeHead(status, headers) (pinned by the server-cors contract test). Behind a
// login that must not be readable cross-site, so every access-control-* header is removed here,
// whichever form writeHead or setHeader is called with.

const isCors = (name) => /^access-control-/i.test(String(name));

function stripHeaders(headers) {
  if (!headers) return headers;
  if (Array.isArray(headers)) {
    // Either [[k, v], ...] or the flat raw form [k, v, k, v].
    if (headers.length && Array.isArray(headers[0])) return headers.filter(([k]) => !isCors(k));
    const out = [];
    for (let i = 0; i < headers.length; i += 2) if (!isCors(headers[i])) out.push(headers[i], headers[i + 1]);
    return out;
  }
  if (typeof headers === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(headers)) if (!isCors(k)) out[k] = v;
    return out;
  }
  return headers;
}

/** Wraps res so upstream cannot emit CORS headers. */
export function stripCors(res) {
  const writeHead = res.writeHead.bind(res);
  const setHeader = res.setHeader.bind(res);
  res.writeHead = (status, ...rest) => {
    const args = rest.map((a) => (a && typeof a === 'object' ? stripHeaders(a) : a));
    for (const name of res.getHeaderNames()) if (isCors(name)) res.removeHeader(name);
    return writeHead(status, ...args);
  };
  res.setHeader = (name, value) => (isCors(name) ? res : setHeader(name, value));
  return res;
}

export function securityHeaders(res, { hsts = false } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  if (hsts) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  // Report-only for now: upstream needs an inline script and 'unsafe-eval' (its script sandbox).
  // Violations show in the browser console; enforcement comes once upstream allows it.
  res.setHeader('Content-Security-Policy-Report-Only', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https: wss:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}

export function sendJson(res, status, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data), ...extra });
  res.end(data);
}

export function sendHtml(res, status, html, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(html), ...extra });
  res.end(html);
}

export function redirect(res, location, extra = {}) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Content-Length': 0, ...extra });
  res.end();
}
