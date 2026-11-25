// Notifications: the Gotify provider against a fake Gotify, and the outbox's retries, dedup,
// permanence rules and persistence.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getGlobalDispatcher, setGlobalDispatcher, ProxyAgent } from 'undici';
import { openDatabase } from '../../storage/db.mjs';
import { createGotify } from '../../notify/gotify.mjs';
import { createOutbox, backoffMs } from '../../notify/outbox.mjs';

const servers = [];
const dirs = [];
after(async () => { for (const s of servers) await new Promise((r) => s.close(r)); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A fake Gotify: answers with the next status in `statuses` (the last one repeats), records requests. */
async function fakeGotify(statuses = [200], { headers = {}, body } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, key: req.headers['x-gotify-key'], body: raw ? JSON.parse(raw) : null });
      const status = statuses[Math.min(requests.length - 1, statuses.length - 1)];
      if (status === 'hang') return; // never answers
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(body ?? (status < 300 ? '{"id":1}' : JSON.stringify({ error: 'Unauthorized', errorCode: status, errorDescription: 'you need to provide a valid access token' })));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}`, requests, server };
}

const db = () => { const d = mkdtempSync(path.join(tmpdir(), 'wl-notify-')); dirs.push(d); return { dir: d, db: openDatabase(d).db }; };
const quietLog = () => { const lines = []; const rec = (level) => (msg, data) => lines.push({ level, msg, ...data }); return { lines, info: rec('info'), warn: rec('warn'), error: rec('error'), debug() {} }; };

test('backoff grows from 5 s to 30 min with 50-100 % jitter', () => {
  assert.equal(backoffMs(1, () => 1), 5_000);
  assert.equal(backoffMs(1, () => 0), 2_500);
  assert.equal(backoffMs(3, () => 1), 20_000);
  assert.equal(backoffMs(20, () => 1), 30 * 60_000);
});

test('Gotify: the request carries the token header, title, message, priority and click URL', async () => {
  const g = await fakeGotify([200]);
  const gotify = createGotify({ url: g.url, token: 'AbC.token', priority: 7 });
  const r = await gotify.send({ title: 'AAPL crossing 190', message: 'Price 190.12', url: 'https://wl.example/#s=AAPL', tags: ['alert'] });
  assert.deepEqual(r, { ok: true, retryable: false, status: 200 });
  const [req] = g.requests;
  assert.deepEqual([req.method, req.url, req.key], ['POST', '/message', 'AbC.token']);
  assert.deepEqual(req.body, {
    title: 'AAPL crossing 190', message: 'Price 190.12\n#alert', priority: 7,
    extras: { 'client::display': { contentType: 'text/plain' }, 'client::notification': { click: { url: 'https://wl.example/#s=AAPL' } } },
  });
  assert.equal(gotify.target, new URL(g.url).host);
});

test('Gotify: 5xx, 408, 429 and network errors are retryable; other 4xx are permanent with the reason', async () => {
  const send = async (statuses, opts) => createGotify({ url: (await fakeGotify(statuses, opts)).url, token: 't' }).send({ title: 'x', message: 'y' });
  assert.equal((await send([500])).retryable, true);
  assert.equal((await send([408])).retryable, true);
  const limited = await send([429], { headers: { 'Retry-After': '42' } });
  assert.deepEqual([limited.retryable, limited.retryAfterSec], [true, 42]);
  const unauthorized = await send([401]);
  assert.equal(unauthorized.retryable, false);
  assert.match(unauthorized.error, /^Gotify answered 401 \(Unauthorized: you need to provide a valid access token\)$/);
  const down = await createGotify({ url: 'http://127.0.0.1:1', token: 't' }).send({ title: 'x' });
  assert.equal(down.retryable, true);
  assert.match(down.error, /^Could not reach Gotify at 127\.0\.0\.1:1: /);
  const hung = await createGotify({ url: (await fakeGotify(['hang'])).url, token: 't', timeoutMs: 300 }).send({ title: 'x' });
  assert.deepEqual([hung.retryable, /no answer within 0\.3 s/.test(hung.error)], [true, true]);
});

test('Gotify never follows a redirect, so the token is not replayed to another host', async () => {
  const other = await fakeGotify([200]);
  const redirecting = await fakeGotify([302], { headers: { Location: `${other.url}/message` } });
  const r = await createGotify({ url: redirecting.url, token: 'secret' }).send({ title: 'x' });
  assert.equal(r.ok, false);
  assert.equal(other.requests.length, 0);
});

test('Gotify bypasses the market-data proxy (WICKLINE_PROXY)', async () => {
  const g = await fakeGotify([200]);
  const previous = getGlobalDispatcher();
  setGlobalDispatcher(new ProxyAgent('http://127.0.0.1:1')); // what setServerProxy() does; a dead proxy here
  try {
    assert.equal((await createGotify({ url: g.url, token: 't' }).send({ title: 'x' })).ok, true);
  } finally { setGlobalDispatcher(previous); }
});

test('outbox: Gotify answering 500, 500, 500 then 200 delivers exactly one message, every attempt logged', async () => {
  const g = await fakeGotify([500, 500, 500, 200]);
  const { db: d } = db();
  let clock = 1_000_000;
  const log = quietLog();
  const outbox = createOutbox(d, { providers: [createGotify({ url: g.url, token: 't' })], log, now: () => clock, random: () => 1 });
  assert.equal(outbox.enqueue('alert:a1:123', { title: 'AAPL', message: 'crossed' }), 1);
  for (let i = 0; i < 6; i++) { await outbox.processDue(); clock += 31 * 60_000; }
  assert.equal(g.requests.length, 4);
  assert.equal(g.requests.filter((r) => r.body.title === 'AAPL').length, 4);
  assert.deepEqual(log.lines.map((l) => [l.msg, l.attempt]), [
    ['notification failed; will retry', 1], ['notification failed; will retry', 2], ['notification failed; will retry', 3], ['notification sent', 4],
  ]);
  const row = d.prepare('SELECT status, attempts, last_error FROM notification_outbox').get();
  assert.deepEqual({ ...row }, { status: 'sent', attempts: 4, last_error: null });
  d.close();
});

test('outbox: retries wait for their backoff, honour Retry-After, and stop at NOTIFY_MAX_ATTEMPTS', async () => {
  const g = await fakeGotify([429], { headers: { 'Retry-After': '120' } });
  const { db: d } = db();
  let clock = 0;
  const outbox = createOutbox(d, { providers: [createGotify({ url: g.url, token: 't' })], maxAttempts: 3, log: quietLog(), now: () => clock, random: () => 1 });
  outbox.enqueue('k', { title: 'x' });
  await outbox.processDue();
  await outbox.processDue(); // not due yet
  assert.equal(g.requests.length, 1);
  assert.equal(d.prepare('SELECT next_attempt_at FROM notification_outbox').get().next_attempt_at, 120_000, 'Retry-After beats the 5 s backoff');
  clock = 120_000; await outbox.processDue();
  clock = 1e9; await outbox.processDue();
  clock = 2e9; await outbox.processDue();
  assert.equal(g.requests.length, 3);
  assert.equal(d.prepare('SELECT status FROM notification_outbox').get().status, 'failed');
  d.close();
});

test('outbox: a permanent error fails at once; the same key is queued once; nothing is queued without a provider', async () => {
  const g = await fakeGotify([401]);
  const { db: d } = db();
  const outbox = createOutbox(d, { providers: [createGotify({ url: g.url, token: 't' })], log: quietLog() });
  assert.equal(outbox.enqueue('alert:x:1', { title: 'x' }), 1);
  assert.equal(outbox.enqueue('alert:x:1', { title: 'x' }), 0);
  await outbox.processDue();
  assert.equal(g.requests.length, 1);
  assert.deepEqual({ ...d.prepare('SELECT status, attempts FROM notification_outbox').get() }, { status: 'failed', attempts: 1 });
  const none = createOutbox(d, { providers: [createGotify({})] });
  assert.equal(none.enqueue('alert:y:1', { title: 'y' }), 0);
  d.close();
});

test('outbox: pending notifications are delivered after a restart, and status never shows the token', async () => {
  const g = await fakeGotify([200]);
  const { dir, db: d } = db();
  createOutbox(d, { providers: [createGotify({ url: 'http://127.0.0.1:1', token: 'tok' })] }).enqueue('k1', { title: 'queued before the restart' });
  d.close();
  const d2 = openDatabase(dir).db;
  const outbox = createOutbox(d2, { providers: [createGotify({ url: g.url, token: 'super-secret-token' })], log: quietLog() });
  outbox.start();
  for (let i = 0; i < 50 && !g.requests.length; i++) await new Promise((r) => setTimeout(r, 20));
  outbox.stop();
  assert.equal(g.requests[0]?.body.title, 'queued before the restart');
  const status = outbox.status();
  assert.doesNotMatch(JSON.stringify(status), /super-secret-token/);
  assert.equal(status.providers[0].configured, true);
  assert.equal(status.last.status, 'sent');
  d2.close();
});
