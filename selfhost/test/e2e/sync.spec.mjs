// Cross-device sync in real browsers (PLAN §6, Phase 2). Each browser context is a separate
// device with its own login and localStorage; pages within one context are tabs of one profile.
import { test, expect } from '@playwright/test';
import { SYNC_PORT, PASSWORD } from '../../playwright.config.mjs';

const BASE = `http://127.0.0.1:${SYNC_PORT}`;
const external = /^https?:\/\/(?!127\.0\.0\.1[:/])/;

async function device(browser, { blockEvents = false } = {}) {
  const ctx = await browser.newContext();
  await ctx.route(external, (r) => r.abort()); // hermetic: no market data
  if (blockEvents) await ctx.route('**/api/selfhost/events**', (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto(`${BASE}/selfhost/login`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveTitle(/Wickline$/);
  await waitLeader(page, { connected: !blockEvents });
  return { ctx, page };
}

const sync = (page) => page.evaluate(() => ({ leader: window.wicklineSelfhost.leader, connected: window.wicklineSelfhost.connected, state: window.wicklineSelfhost.state }));
async function waitLeader(page, { connected = true } = {}) {
  await expect.poll(async () => { const s = await sync(page); return s.leader && (!connected || s.connected); }, { timeout: 10_000 }).toBe(true);
}
const getItem = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);
const setItem = (page, key, value) => page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, value]);
const serverState = (page) => page.evaluate(() => fetch('/api/selfhost/state').then((r) => r.json()));
const settled = (page) => expect.poll(async () => (await sync(page)).state, { timeout: 10_000 }).toBe('synced');

test('a live key (alerts) reaches the other device within 5 s, with no reload', async ({ browser }) => {
  const a = await device(browser);
  await settled(a.page); // on a fresh server, the first device's defaults upload before the second boots
  const b = await device(browser);
  await settled(b.page);
  const alerts = JSON.stringify([{ id: `e2e${Date.now()}`, symbol: 'AAPL', condition: 'cross', price: 190, message: '', active: true, created: Date.now() }]);
  await setItem(a.page, 'wickline.alerts', alerts);
  await expect.poll(() => getItem(b.page, 'wickline.alerts'), { timeout: 5_000 }).toBe(alerts);
  await expect(b.page.locator('#wl-sync-banner')).toBeHidden();
  await a.ctx.close(); await b.ctx.close();
});

test('a reload-only key (watchlist) is held back behind a banner until the reload', async ({ browser }) => {
  const a = await device(browser);
  const b = await device(browser);
  const before = await getItem(b.page, 'wickline.watchlist');
  const list = JSON.stringify(['MSFT', `E2E${Date.now()}`]);
  await setItem(a.page, 'wickline.watchlist', list);
  const banner = b.page.locator('#wl-sync-banner');
  await expect(banner).toBeVisible({ timeout: 5_000 });
  await expect(banner).toContainText('Updated on another device');
  expect(await getItem(b.page, 'wickline.watchlist')).toBe(before); // not under the running app
  await banner.getByRole('button', { name: 'Reload' }).click();
  await expect.poll(() => getItem(b.page, 'wickline.watchlist')).toBe(list);
  await a.ctx.close(); await b.ctx.close();
});

test('device-local keys never leave the device', async ({ browser }) => {
  const a = await device(browser);
  const b = await device(browser);
  await setItem(a.page, 'wickline.tdKey', '"secret-key"');
  await setItem(a.page, 'wickline.sideTab', '"news"');
  await setItem(a.page, 'wickline.extHours', 'true'); // a synced key, to know the upload happened
  await settled(a.page);
  const state = await serverState(a.page);
  expect(state.keys.tdKey).toBeUndefined();
  expect(state.keys.sideTab).toBeUndefined();
  expect(state.keys.extHours.v).toBe('true');
  await b.page.reload();
  expect(await getItem(b.page, 'wickline.tdKey')).toBeNull();
  await a.ctx.close(); await b.ctx.close();
});

test('a stale change is replaced by the newer one, with a notice', async ({ browser }) => {
  const a = await device(browser);
  const b = await device(browser, { blockEvents: true }); // B never hears about A's change
  const fromA = JSON.stringify(['A', `T${Date.now()}`]);
  await setItem(a.page, 'wickline.watchlist', fromA);
  await settled(a.page);
  await setItem(b.page, 'wickline.watchlist', JSON.stringify(['B-stale']));
  const banner = b.page.locator('#wl-sync-banner');
  await expect(banner).toContainText('replaced by a newer one', { timeout: 5_000 });
  expect(await getItem(b.page, 'wickline.watchlist')).toBe(fromA);
  expect((await serverState(b.page)).keys.watchlist.v).toBe(fromA);
  await a.ctx.close(); await b.ctx.close();
});

test('no ping-pong: loading the app on two devices settles without further writes', async ({ browser }) => {
  const a = await device(browser);
  const b = await device(browser);
  await a.page.reload(); await b.page.reload();
  await waitLeader(a.page); await waitLeader(b.page);
  await settled(a.page); await settled(b.page);
  await a.page.waitForTimeout(1500);
  const rev = (await serverState(a.page)).rev;
  await a.page.waitForTimeout(3000);
  expect((await serverState(a.page)).rev).toBe(rev);
  await expect(a.page.locator('#wl-sync-banner')).toBeHidden();
  await expect(b.page.locator('#wl-sync-banner')).toBeHidden();
  await a.ctx.close(); await b.ctx.close();
});

test('tabs and pop-outs of one profile share a single event stream', async ({ browser }) => {
  const a = await device(browser);
  const streams = [];
  a.ctx.on('request', (r) => { if (r.url().includes('/api/selfhost/events')) streams.push(r.url()); });
  const popout = await a.ctx.newPage();
  await popout.goto(`${BASE}/?popout=1`);
  await expect.poll(() => popout.evaluate(() => typeof window.wicklineSelfhost)).toBe('object');
  await popout.waitForTimeout(1000);
  const roles = [await sync(a.page), await sync(popout)].map((s) => s.leader);
  expect(roles.filter(Boolean)).toHaveLength(1);
  expect(streams).toHaveLength(0); // the leader's stream predates the listener; the pop-out opened none
  // the pop-out's writes still sync, through the leader
  const value = JSON.stringify({ v: Date.now() });
  await setItem(popout, 'wickline.news', value);
  await expect.poll(async () => (await serverState(popout)).keys.news?.v, { timeout: 5_000 }).toBe(value);
  // closing the leader hands the stream to the pop-out
  await a.page.close();
  await waitLeader(popout);
  await a.ctx.close();
});

test('offline changes are queued and sent when the server is reachable again', async ({ browser }) => {
  const a = await device(browser);
  await a.ctx.setOffline(true);
  const value = JSON.stringify({ offline: Date.now() });
  await setItem(a.page, 'wickline.heatmap', value);
  // the upload fails and is kept for later
  await expect.poll(async () => (await sync(a.page)).state, { timeout: 10_000 }).toBe('offline');
  await expect(a.page.locator('#wl-sync-status')).toHaveAttribute('data-state', 'offline');
  expect(await a.page.evaluate(() => localStorage.getItem('wickline-selfhost.dirty.heatmap'))).not.toBeNull();
  await a.ctx.setOffline(false);
  await expect.poll(async () => { try { return (await serverState(a.page)).keys.heatmap?.v; } catch { return null; } }, { timeout: 20_000 }).toBe(value);
  await settled(a.page);
  await a.ctx.close();
});

test('first run on a profile with older data: the server wins, the old data can be downloaded, new keys upload', async ({ browser }) => {
  const a = await device(browser);
  const serverValue = JSON.stringify({ server: Date.now() });
  await setItem(a.page, 'wickline.screener', serverValue);
  await settled(a.page);

  const ctx = await browser.newContext();
  await ctx.route(external, (r) => r.abort());
  const page = await ctx.newPage();
  await page.goto(`${BASE}/selfhost/login`);
  // same origin, before any sync agent ran: this profile's data predates the self-hosted edition
  await page.evaluate(() => {
    localStorage.setItem('wickline.screener', JSON.stringify({ local: true }));
    localStorage.setItem('wickline.paperQty', '42');
  });
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveTitle(/Wickline$/);
  expect(await getItem(page, 'wickline.screener')).toBe(serverValue);
  const banner = page.locator('#wl-sync-banner');
  await expect(banner).toContainText('differs from the server');
  const [download] = await Promise.all([page.waitForEvent('download'), banner.getByRole('button', { name: 'Download previous data' }).click()]);
  const saved = JSON.parse(await (await download.createReadStream()).toArray().then((c) => Buffer.concat(c).toString('utf8')));
  expect(saved.keys.screener).toBe(JSON.stringify({ local: true }));
  await waitLeader(page);
  await expect.poll(async () => (await serverState(page)).keys.paperQty?.v, { timeout: 5_000 }).toBe('42');
  await ctx.close(); await a.ctx.close();
});

test('a lapsed login sends the page to the sign-in form', async ({ browser }) => {
  const a = await device(browser);
  await a.ctx.clearCookies();
  await setItem(a.page, 'wickline.news', JSON.stringify({ lapsed: Date.now() }));
  await expect(a.page).toHaveURL(/\/selfhost\/login\?next=%2F/, { timeout: 10_000 });
  await a.ctx.close();
});

test('without Web Locks (plain-http LAN), a localStorage lease elects one leader and hands over', async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.route(external, (r) => r.abort());
  await ctx.addInitScript(() => { Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true }); });
  const first = await ctx.newPage();
  await first.goto(`${BASE}/selfhost/login`);
  await first.getByLabel('Password').fill(PASSWORD);
  await first.getByRole('button', { name: 'Sign in' }).click();
  await expect(first).toHaveTitle(/Wickline$/);
  await waitLeader(first);
  const second = await ctx.newPage();
  await second.goto(`${BASE}/`);
  await expect.poll(() => second.evaluate(() => typeof window.wicklineSelfhost)).toBe('object');
  await second.waitForTimeout(3500); // a few lease ticks
  expect([(await sync(first)).leader, (await sync(second)).leader]).toEqual([true, false]);
  await first.close(); // pagehide releases the lease
  await waitLeader(second);
  await ctx.close();
});

test('a hidden tab applies a held-back change when shown, without the s/tf hash', async ({ browser }) => {
  const a = await device(browser);
  const b = await device(browser);
  await b.page.goto(`${BASE}/#s=AAPL&tf=1D`);
  await waitLeader(b.page);
  await settled(b.page); // opening a symbol can write the watchlist; let that upload finish first
  const setHidden = (hidden) => b.page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await setHidden(true);
  const list = JSON.stringify(['HIDDEN', `T${Date.now()}`]);
  await setItem(a.page, 'wickline.watchlist', list);
  await expect(b.page.locator('#wl-sync-banner')).toHaveAttribute('data-kind', 'remote', { timeout: 5_000 });
  await b.page.waitForTimeout(500);
  expect(await getItem(b.page, 'wickline.watchlist')).not.toBe(list); // no reload while hidden
  await Promise.all([b.page.waitForEvent('load'), setHidden(false)]);
  await expect.poll(() => getItem(b.page, 'wickline.watchlist')).toBe(list);
  expect(new URL(b.page.url()).hash).not.toMatch(/(^|[#&])(s|tf)=/);
  await a.ctx.close(); await b.ctx.close();
});
