// Backup download and portable export/import (PLAN §2.4). Authentication, the same-origin check
// and the X-Wickline-Selfhost header (on the import) are enforced by server.mjs first.
//
//   GET  /api/selfhost/backup   the whole database as a .db file (consistent copy)
//   GET  /api/selfhost/export   synced state as portable JSON
//   POST /api/selfhost/import   replaces all synced state with an export; starts a new epoch

import { createReadStream, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { backupTo } from '../storage/db.mjs';
import { backupDir } from '../storage/backup.mjs';
import { readBody, HttpError } from './request.mjs';
import { sendJson } from './headers.mjs';
import { SyncError, MAX_TOTAL_CHARS } from '../sync/state.mjs';

export const EXPORT_FORMAT = { app: 'wickline-selfhost', format: 1 };
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');

export function createAdminRoutes({ state, db, dataDir, version, log }) {
  let downloading = false; // one at a time: each holds a full copy of the database on disk

  function backup(req, res) {
    if (downloading) return sendJson(res, 429, { error: 'A backup download is already in progress' }, { 'Retry-After': '10' });
    downloading = true;
    const file = path.join(backupDir(dataDir), `.download-${randomBytes(6).toString('hex')}.db`);
    try { backupTo(db, file); } catch (e) { downloading = false; rmSync(file, { force: true }); throw e; }
    const cleanup = () => { downloading = false; rmSync(file, { force: true }); };
    res.writeHead(200, {
      'Content-Type': 'application/vnd.sqlite3',
      'Content-Disposition': `attachment; filename="wickline-${stamp()}.db"`,
      'Cache-Control': 'no-store',
    });
    const stream = createReadStream(file);
    stream.on('error', (e) => { log?.error('backup download failed', { error: e }); res.destroy(); cleanup(); });
    res.on('close', cleanup);
    stream.pipe(res);
  }

  function exportState(req, res) {
    const body = { ...EXPORT_FORMAT, exportedAt: new Date().toISOString(), version, keys: state.exportKeys() };
    return sendJson(res, 200, body, { 'Content-Disposition': `attachment; filename="wickline-export-${stamp()}.json"` });
  }

  async function importState(req, res) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415, 'Expected application/json');
    let body;
    try { body = JSON.parse((await readBody(req, MAX_TOTAL_CHARS * 6 + 65_536)).toString('utf8')); } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, 'Invalid JSON body');
    }
    if (!body || body.app !== EXPORT_FORMAT.app || body.format !== EXPORT_FORMAT.format) {
      return sendJson(res, 422, { error: 'Not a Wickline Self-Hosted export (expected app "wickline-selfhost", format 1)' });
    }
    try {
      const r = state.replaceAll(body.keys);
      log?.info('synced state imported', { keys: r.keys });
      return sendJson(res, 200, r);
    } catch (e) {
      if (e instanceof SyncError) return sendJson(res, e.status, e.body);
      throw e;
    }
  }

  /** Handles the request if it is one of these routes; returns false otherwise. */
  return async function handleAdmin(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/selfhost/backup') return backup(req, res);
    if (route === 'GET /api/selfhost/export') return exportState(req, res);
    if (route === 'POST /api/selfhost/import') return importState(req, res);
    if (['/api/selfhost/backup', '/api/selfhost/export', '/api/selfhost/import'].includes(url.pathname)) {
      return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: url.pathname.endsWith('import') ? 'POST' : 'GET' });
    }
    return false;
  };
}
