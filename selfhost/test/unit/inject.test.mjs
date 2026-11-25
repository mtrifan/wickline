// index.html injection: inert JSON, anchor handling, and which paths are the index.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptSafeJson, injectBoot, isIndexPath } from '../../http/inject.mjs';
import { clientKeyConfig } from '../../sync/key-policy.mjs';

const extractJson = (html) => JSON.parse(/<script type="application\/json" id="wl-snapshot">([\s\S]*?)<\/script>/.exec(html)[1]);

test('scriptSafeJson escapes everything that could end or alter a script element', () => {
  const nasty = { v: '</script><script>alert(1)</script><!-- & \u2028\u2029 >' };
  const out = scriptSafeJson(nasty);
  assert.doesNotMatch(out, /[<>&\u2028\u2029]/);
  assert.deepEqual(JSON.parse(out), nasty);
});

test('injectBoot places the snapshot and boot.js right after the single <head>', () => {
  const html = '<!doctype html><html><head><title>x</title></head><body></body></html>';
  const payload = { epoch: 'e', rev: 1, keys: { watchlist: { v: '</script><!--', ver: 1, deleted: false } } };
  const out = injectBoot(html, payload);
  assert.ok(out.startsWith('<!doctype html><html><head>\n<script type="application/json" id="wl-snapshot">'));
  assert.match(out, /<\/script>\n<script src="\/selfhost\/boot\.js"><\/script><title>/);
  assert.equal(out.match(/<\/script>/g).length, 2, 'the payload cannot close the element');
  assert.deepEqual(extractJson(out), payload);
});

test('a missing or repeated <head> anchor serves the page with a visible error banner', () => {
  for (const html of ['<html><body class="a"><p>x</p></body></html>', '<head></head><head></head><body></body>']) {
    const out = injectBoot(html, {});
    assert.doesNotMatch(out, /boot\.js/);
    assert.match(out, /role="alert"[^>]*>Wickline Self-Hosted could not attach its sync agent/);
  }
  assert.match(injectBoot('<p>no body</p>', {}), /^<div role="alert"/);
});

test('isIndexPath matches every spelling upstream answers with index.html', () => {
  for (const p of ['/', '/index.html', '/%69ndex.html', '/./index.html', '//index.html', '/x/../index.html']) assert.equal(isIndexPath(p), true, p);
  for (const p of ['/index.htm', '/js/app.js', '/index.html/x', '/%E0%A4%A', '/selfhost/boot.js', '/x/..', '/%2E%2E/index.html', '/%2F', '/x/../../index.html']) assert.equal(isIndexPath(p), false, p);
});

test('clientKeyConfig lists synced keys and prefixes only, and honours SYNC_WORKSPACE', () => {
  const on = clientKeyConfig();
  assert.ok(on.exact.includes('watchlist') && on.exact.includes('workspace') && on.exact.includes('theme'));
  assert.ok(!on.exact.includes('tdKey') && !on.exact.includes('paint'));
  assert.deepEqual(on.prefixes, ['drawings.']);
  assert.deepEqual(on.live, ['alerts', 'paper', 'scripts', 'lang']);
  assert.ok(!clientKeyConfig({ syncWorkspace: false }).exact.includes('workspace'));
});
