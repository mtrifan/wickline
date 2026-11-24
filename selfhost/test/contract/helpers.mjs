// Shared helpers for the upstream contract tests. These tests pin the upstream behaviour the
// self-hosted edition relies on (see ../../INTEGRATION_POINTS.json). When one fails after an
// upstream merge, the message names the integration point that moved.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Absolute path of the repository root (the upstream app lives there, unmodified). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const upstreamPath = (rel) => path.join(ROOT, rel);
export const readUpstream = (rel) => readFileSync(upstreamPath(rel), 'utf8');
export const importUpstream = (rel) => import(new URL(`file://${upstreamPath(rel)}`).href);

/** Prefix for assertion messages so a failure points at INTEGRATION_POINTS.json. */
export const point = (id) => `[integration point: ${id}]`;

/** Minimal Map-backed localStorage, enough for upstream's store helper. */
export function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    _map: m,
  };
}
