// Notification routes (PLAN §2.6). Authentication, the same-origin check and the
// X-Wickline-Selfhost header (on the POST) are enforced by server.mjs first.
//
//   GET  /api/selfhost/notify/status   providers (configured yes/no, host), pending count, last delivery
//   POST /api/selfhost/notify/test     sends a test message now and reports each provider's exact result

import { sendJson } from './headers.mjs';

const TEST_SPACING_MS = 3_000;

export const testPayload = (publicUrl) => ({
  title: 'Wickline test notification',
  message: 'If you can read this, notifications from Wickline Self-Hosted work.',
  ...(publicUrl ? { url: `${publicUrl}/` } : {}),
});

export function createNotifyRoutes({ outbox, publicUrl, now = Date.now }) {
  let lastTest = 0;
  return async function handleNotify(req, res, url) {
    if (url.pathname === '/api/selfhost/notify/status') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
      return sendJson(res, 200, outbox.status());
    }
    if (url.pathname === '/api/selfhost/notify/test') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
      if (!outbox.status().providers.some((p) => p.configured)) {
        return sendJson(res, 422, { error: 'No notification provider is configured. Set GOTIFY_URL and GOTIFY_TOKEN.' });
      }
      const wait = lastTest + TEST_SPACING_MS - now();
      if (wait > 0) return sendJson(res, 429, { error: 'Wait a moment before sending another test' }, { 'Retry-After': String(Math.ceil(wait / 1000)) });
      lastTest = now();
      const results = await outbox.sendNow(testPayload(publicUrl));
      return sendJson(res, 200, { ok: results.every((r) => r.ok), results });
    }
    return false;
  };
}
