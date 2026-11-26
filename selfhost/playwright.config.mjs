// Browser tests: the self-hosted server and, for comparison, plain upstream (`node server.mjs`),
// each on its own port with a throwaway data directory. Chromium and WebKit (Safari engine).
import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const SELFHOST_PORT = 5185;
export const UPSTREAM_PORT = 5186;
export const PASSWORD = 'correct horse battery staple';
export const TOTP_PORT = 5187;
export const TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // test-only
export const SYNC_PORT = 5188;
const dataDir = process.env.E2E_DATA_DIR || mkdtempSync(path.join(tmpdir(), 'wl-e2e-'));
process.env.E2E_DATA_DIR = dataDir; // shared with worker processes
const totpDir = process.env.E2E_TOTP_DIR || mkdtempSync(path.join(tmpdir(), 'wl-e2e-totp-'));
process.env.E2E_TOTP_DIR = totpDir;
const syncDir = process.env.E2E_SYNC_DIR || mkdtempSync(path.join(tmpdir(), 'wl-e2e-sync-'));
process.env.E2E_SYNC_DIR = syncDir;

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: /.*\.spec\.mjs$/,
  timeout: 60_000,
  // One worker: every test signs in from 127.0.0.1, and the per-client login delay after a
  // deliberate failure would otherwise race with other tests' sign-ins.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    // Firefox runs nightly (selfhost-nightly), not on every PR.
    ...(process.env.E2E_FIREFOX ? [{ name: 'firefox', use: { ...devices['Desktop Firefox'] } }] : []),
  ],
  webServer: [
    {
      command: 'node --disable-warning=ExperimentalWarning server.mjs',
      url: `http://127.0.0.1:${SELFHOST_PORT}/api/health/ready`,
      env: { PORT: String(SELFHOST_PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, WICKLINE_PASSWORD: PASSWORD, LOG_LEVEL: 'warn', ALERTS_SERVER: 'false' },
      reuseExistingServer: false,
    },
    {
      command: 'node --disable-warning=ExperimentalWarning server.mjs',
      url: `http://127.0.0.1:${TOTP_PORT}/api/health/ready`,
      env: { PORT: String(TOTP_PORT), HOST: '127.0.0.1', DATA_DIR: totpDir, WICKLINE_PASSWORD: PASSWORD, WICKLINE_TOTP_SECRET: TOTP_SECRET, LOG_LEVEL: 'warn', ALERTS_SERVER: 'false' },
      reuseExistingServer: false,
    },
    {
      command: 'node --disable-warning=ExperimentalWarning server.mjs',
      url: `http://127.0.0.1:${SYNC_PORT}/api/health/ready`,
      env: { PORT: String(SYNC_PORT), HOST: '127.0.0.1', DATA_DIR: syncDir, WICKLINE_PASSWORD: PASSWORD, LOG_LEVEL: 'warn', ALERTS_SERVER: 'false' },
      reuseExistingServer: false,
    },
    {
      command: 'node ../server.mjs',
      url: `http://127.0.0.1:${UPSTREAM_PORT}/api/health`,
      env: { PORT: String(UPSTREAM_PORT), HOST: '127.0.0.1' },
      reuseExistingServer: false,
    },
  ],
});
