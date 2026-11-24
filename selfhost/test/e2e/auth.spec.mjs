import { test, expect } from '@playwright/test';
import { SELFHOST_PORT, UPSTREAM_PORT, TOTP_PORT, TOTP_SECRET, PASSWORD } from '../../playwright.config.mjs';
import { totp } from '../../auth/totp.mjs';

const SELFHOST = `http://127.0.0.1:${SELFHOST_PORT}`;
const UPSTREAM = `http://127.0.0.1:${UPSTREAM_PORT}`;

// Hermetic: the app would otherwise reach Yahoo, Binance and others from the browser.
test.beforeEach(async ({ context }) => {
  await context.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
});

test('signing in opens the app at the requested chart', async ({ page }) => {
  await page.goto(`${SELFHOST}/#s=AAPL&tf=1D`);
  await expect(page).toHaveURL(/\/selfhost\/login\?next=%2F/);
  await expect(page.getByLabel('Password')).toBeFocused();

  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong password');

  await page.waitForTimeout(1100); // per-client delay after a failed attempt
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveTitle(/Wickline$/);
  await expect(page).toHaveURL(new RegExp(`^${SELFHOST}/(#.*)?$`));

  const session = await page.evaluate(() => fetch('/api/selfhost/session').then((r) => r.json()));
  expect(session.authenticated).toBe(true);
});

test('another browser context has its own login', async ({ browser }) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    for (const ctx of [a, b]) await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort());
    const pa = await a.newPage();
    await pa.goto(`${SELFHOST}/selfhost/login`);
    await pa.getByLabel('Password').fill(PASSWORD);
    await pa.getByRole('button', { name: 'Sign in' }).click();
    await expect(pa).toHaveTitle(/Wickline$/);

    const pb = await b.newPage();
    await pb.goto(`${SELFHOST}/`);
    await expect(pb).toHaveURL(/\/selfhost\/login/);
    const api = await pb.evaluate(() => fetch('/api/health').then((r) => r.status));
    expect(api).toBe(401);
  } finally {
    await a.close(); await b.close();
  }
});

test('upstream mode is unchanged: no login, no self-hosting code', async ({ page }) => {
  const selfhostRequests = [];
  page.on('request', (r) => { if (r.url().includes('/selfhost/')) selfhostRequests.push(r.url()); });
  await page.goto(`${UPSTREAM}/`);
  await expect(page).toHaveTitle(/Wickline$/);
  await page.waitForLoadState('domcontentloaded');
  expect(selfhostRequests).toEqual([]);
  const health = await page.evaluate(() => fetch('/api/health').then((r) => r.json()));
  expect(health.app).toBe('wickline');
  // Upstream keeps its open CORS and localStorage-only behaviour.
  const stored = await page.evaluate(() => { localStorage.setItem('wickline.e2e', '1'); return localStorage.getItem('wickline.e2e'); });
  expect(stored).toBe('1');
});

test('two-factor login: the code is required, then accepted', async ({ page }, testInfo) => {
  const base = `http://127.0.0.1:${TOTP_PORT}`;
  await page.goto(`${base}/`);
  await expect(page.getByLabel('Authenticator code')).toBeVisible();
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Authenticator code').fill('000000');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong password or code');

  await page.waitForTimeout(1100);
  // A used code cannot be replayed, and both browser projects share this server: wait for a
  // fresh 30-second step for the second project.
  if (testInfo.project.name !== 'chromium') await page.waitForTimeout(31_000 - (Date.now() % 30_000));
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Authenticator code').fill(totp(TOTP_SECRET));
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveTitle(/Wickline$/);
});
