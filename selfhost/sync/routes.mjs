// HTTP routes for synced state. Authentication, the same-origin check and the
// X-Wickline-Selfhost header (on writes) are enforced by server.mjs before these run.
//
//   GET    /api/selfhost/state          snapshot { epoch, rev, keys: { key: { v, ver, deleted } } }
//   PUT    /api/selfhost/state/:key     { value, baseVersion, epoch, clientId } → { version, rev, value? }
//   DELETE /api/selfhost/state/:key     { baseVersion, epoch, clientId }        → { version, rev }
//   GET    /api/selfhost/events         event stream (see events.mjs)
//
// 409 { error: 'conflict', version, value, deleted }: the key changed elsewhere (compare-and-swap).
// 409 { error: 'epoch', epoch }: the database was restored or imported; re-hydrate everything.

import { readBody, HttpError } from '../http/request.mjs';
import { sendJson } from '../http/headers.mjs';
import { SyncError, MAX_VALUE_CHARS } from './state.mjs';

const PREFIX = '/api/selfhost/state/';
/** JSON escaping can make a value up to six times longer (\uXXXX). */
const MAX_BODY = MAX_VALUE_CHARS * 6 + 4096;
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

async function readJson(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Expected application/json');
  let v;
  try { v = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8')); } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'Invalid JSON body');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Invalid JSON body');
  return v;
}

function parseWrite(body, method) {
  const { value, baseVersion, epoch, clientId } = body;
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) throw new HttpError(400, 'baseVersion must be a non-negative integer');
  if (typeof epoch !== 'string' || !/^[0-9a-f]{1,64}$/.test(epoch)) throw new HttpError(400, 'epoch is required');
  if (clientId !== undefined && (typeof clientId !== 'string' || !CLIENT_ID.test(clientId))) throw new HttpError(400, 'Invalid clientId');
  if (method === 'PUT') {
    if (typeof value !== 'string') throw new HttpError(400, 'value must be a string');
    if (value.length > MAX_VALUE_CHARS) throw new HttpError(413, 'Value too large');
  }
  return { value: method === 'PUT' ? value : null, baseVersion, epoch, clientId: clientId ?? null };
}

/**
 * `isValid(auth)` returns a function telling whether that login is still valid; open event streams
 * call it on every heartbeat.
 */
export function createSyncRoutes({ state, hub, isValid = () => () => true }) {
  /** Handles the request if it is a sync route; returns false otherwise. */
  return async function handleSync(req, res, url, auth) {
    const { pathname } = url;
    if (pathname === '/api/selfhost/state') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
      return sendJson(res, 200, state.snapshot());
    }
    if (pathname === '/api/selfhost/events') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
      return hub.handle(req, res, url, { session: auth?.kind === 'session' ? auth.token : null, isValid: isValid(auth) });
    }
    if (!pathname.startsWith(PREFIX)) return false;

    if (req.method !== 'PUT' && req.method !== 'DELETE') return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'PUT, DELETE' });
    let key;
    try { key = decodeURIComponent(pathname.slice(PREFIX.length)); } catch { return sendJson(res, 400, { error: 'Invalid key' }); }
    const policy = state.policyFor(key);
    if (policy === null || policy === 'local') return sendJson(res, 422, { error: 'This key is not synced' });

    const write = parseWrite(await readJson(req), req.method);
    try {
      const r = state.write(key, write);
      const out = { version: r.version, rev: r.rev, deleted: r.deleted };
      if ('value' in r) out.value = r.value;
      return sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof SyncError) return sendJson(res, e.status, e.body);
      throw e;
    }
  };
}
