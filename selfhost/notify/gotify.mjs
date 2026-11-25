// Gotify notification provider (PLAN §2.6).
//
//   POST {GOTIFY_URL}/message   X-Gotify-Key: <application token>
//   { title, message, priority, extras: { client::notification: { click: { url } }, client::display: ... } }
//
// Requests go straight to Gotify through their own connection pool, never through WICKLINE_PROXY
// (that proxy is for market data; Gotify usually lives on the LAN). The token is sent only in the
// header and never logged or returned.

import { Agent, fetch as undiciFetch } from 'undici';

const TIMEOUT_MS = 10_000;

/** Short, safe error text from a Gotify error response ({ error, errorCode, errorDescription }). */
async function describe(res) {
  let text = '';
  try { text = await res.text(); } catch { /* none */ }
  let detail = text;
  try { const j = JSON.parse(text); detail = [j.error, j.errorDescription].filter(Boolean).join(': '); } catch { /* not JSON */ }
  return `Gotify answered ${res.status}${detail ? ` (${String(detail).replace(/\s+/g, ' ').slice(0, 200)})` : ''}`;
}

/** Seconds from a Retry-After header (delta form only), or null. */
const retryAfter = (res) => {
  const h = res.headers.get('retry-after');
  if (h == null || h.trim() === '') return null;
  const n = Number(h);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * createGotify({ url, token, priority }) -> provider
 * provider.send({ title, message, priority?, url?, tags? }) -> { ok, retryable, status?, error?, retryAfterSec? }
 */
export function createGotify({ url, token, priority = 8, fetch = undiciFetch, timeoutMs = TIMEOUT_MS } = {}) {
  const agent = fetch === undiciFetch ? new Agent({ connect: { timeout: timeoutMs } }) : undefined;
  return {
    id: 'gotify',
    isConfigured: () => !!(url && token),
    target: url ? new URL(url).host : null,
    async send({ title, message, priority: p, url: click, tags } = {}) {
      if (!url || !token) return { ok: false, retryable: false, error: 'Gotify is not configured' };
      const extras = { 'client::display': { contentType: 'text/plain' } };
      if (click) extras['client::notification'] = { click: { url: click } };
      const body = JSON.stringify({
        title: String(title ?? '').slice(0, 250),
        message: String(message ?? '').slice(0, 4000) + (tags?.length ? `\n${tags.map((t) => `#${t}`).join(' ')}` : ''),
        priority: Number.isInteger(p) ? p : priority,
        extras,
      });
      let res;
      try {
        res = await fetch(`${url}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Gotify-Key': token },
          body,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error', // never replay the token to another host
          ...(agent ? { dispatcher: agent } : {}),
        });
      } catch (e) {
        if (e?.cause?.message === 'unexpected redirect') {
          // A redirect is a setup problem (http -> https, a wrong path behind a proxy), not an outage.
          return { ok: false, retryable: false, error: 'Gotify answered with a redirect; set GOTIFY_URL to the final address (for example https:// instead of http://)' };
        }
        const reason = e?.name === 'TimeoutError' ? `no answer within ${timeoutMs / 1000} s` : (e?.cause?.code || e?.code || e?.message || 'network error');
        return { ok: false, retryable: true, error: `Could not reach Gotify at ${new URL(url).host}: ${reason}` };
      }
      if (res.ok) { try { await res.arrayBuffer(); } catch { /* ignore */ } return { ok: true, retryable: false, status: res.status }; }
      const error = await describe(res);
      // 4xx is permanent (a bad token, a bad request) except timeouts and rate limits.
      const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
      return { ok: false, retryable, status: res.status, error, retryAfterSec: retryAfter(res) };
    },
  };
}
