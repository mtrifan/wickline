#!/usr/bin/env node
// Administration commands for Wickline Self-Hosted.
//
//   node selfhost/cli.mjs hash-password            prints a WICKLINE_PASSWORD_HASH (reads the password from stdin)
//   node selfhost/cli.mjs totp-setup [label]       prints a new WICKLINE_TOTP_SECRET and its otpauth:// URI
//   node selfhost/cli.mjs token create <label>     creates an API token (shown once)   [needs DATA_DIR]
//   node selfhost/cli.mjs token list | token revoke <id>                             [needs DATA_DIR]
//   node selfhost/cli.mjs sessions revoke-all      signs out every browser            [needs DATA_DIR]
//   node selfhost/cli.mjs backup                   writes a backup to DATA_DIR/backups now
//   node selfhost/cli.mjs restore <file> [--force] replaces the database with a backup  [server stopped]
//
// In Docker: docker exec -it wickline node selfhost/cli.mjs <command>

import path from 'node:path';
import { hashPassword } from './auth/password.mjs';
import { generateSecret, otpauthUri } from './auth/totp.mjs';

async function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = '';
  return new Promise((resolve, reject) => {
    process.stdin.on('data', (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { process.stdin.setRawMode(false); process.stdin.pause(); process.stderr.write('\n'); resolve(value); return; }
        if (ch === '\u0003') { process.stdin.setRawMode(false); reject(new Error('cancelled')); return; }
        if (ch === '\u007f') value = value.slice(0, -1); else value += ch;
      }
    });
  });
}

async function withStore(fn) {
  const { openDatabase } = await import('./storage/db.mjs');
  const { createAuthStore } = await import('./auth/store.mjs');
  const { db } = openDatabase(path.resolve(process.env.DATA_DIR || '/data'));
  try { return fn(createAuthStore(db)); } finally { db.close(); }
}

const [cmd, sub, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'hash-password') {
    const pw = await readSecret('Password (12+ characters): ');
    if (process.stdin.isTTY) {
      const again = await readSecret('Repeat: ');
      if (again !== pw) throw new Error('Passwords do not match');
    }
    process.stdout.write(`${hashPassword(pw)}\n`);
  } else if (cmd === 'totp-setup') {
    const secret = generateSecret();
    process.stdout.write(`WICKLINE_TOTP_SECRET=${secret}\n\nAdd it to your authenticator app with this URI (or type the secret in manually):\n${otpauthUri(secret, sub || 'wickline')}\n\nTip: \`qrencode -t ansiutf8 '<uri>'\` shows it as a QR code.\n`);
  } else if (cmd === 'token' && sub === 'create') {
    await withStore((s) => { const t = s.createToken(rest.join(' ') || 'token'); process.stdout.write(`id: ${t.id}\ntoken (shown once): ${t.token}\n`); });
  } else if (cmd === 'token' && sub === 'list') {
    await withStore((s) => { for (const t of s.listTokens()) process.stdout.write(`${t.id}  ${t.label}  created ${new Date(t.created_at).toISOString()}  last used ${t.last_used_at ? new Date(t.last_used_at).toISOString() : 'never'}\n`); });
  } else if (cmd === 'token' && sub === 'revoke' && rest[0]) {
    await withStore((s) => process.stdout.write(s.deleteToken(rest[0]) ? 'revoked\n' : 'no such token\n'));
  } else if (cmd === 'backup') {
    const { openDatabase } = await import('./storage/db.mjs');
    const { runBackup } = await import('./storage/backup.mjs');
    const dataDir = path.resolve(process.env.DATA_DIR || '/data');
    const { db } = openDatabase(dataDir);
    try {
      const keep = Number(process.env.BACKUP_KEEP) || 14;
      process.stdout.write(`backup written: ${runBackup(db, dataDir, { keep })}\n`);
    } finally { db.close(); }
  } else if (cmd === 'restore' && sub) {
    const { restoreDatabase } = await import('./storage/backup.mjs');
    const dataDir = path.resolve(process.env.DATA_DIR || '/data');
    const r = restoreDatabase(dataDir, sub, { force: rest.includes('--force') });
    process.stdout.write(`restored ${sub} (schema ${r.version})\n`);
    if (r.saved) process.stdout.write(`the previous database was saved as ${r.saved}\n`);
    if (r.liveDamaged) process.stdout.write('the current database was damaged: its raw files were kept, and all API tokens were removed (create new ones with `token create`)\n');
    else process.stdout.write(`${r.tokens} API token(s) ${r.tokensFromLive ? 'carried over from the database being replaced' : 'restored from the backup'}\n`);
    process.stdout.write('every browser must sign in again; with two-factor login, use the next code\n');
    process.stdout.write('Start the container. Open browsers reload into the restored data.\n');
  } else if (cmd === 'sessions' && sub === 'revoke-all') {
    await withStore((s) => { s.deleteAllSessions(); s.audit('sessions.revoke-all', { detail: 'cli' }); process.stdout.write('all sessions revoked\n'); });
  } else {
    process.stderr.write('usage: node selfhost/cli.mjs hash-password | totp-setup [label] | token create <label> | token list | token revoke <id> | sessions revoke-all | backup | restore <file> [--force]\n');
    process.exit(2);
  }
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
}
