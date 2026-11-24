// Contract: upstream alert semantics. The server evaluator (Phase 3) runs the same fixtures, so
// a change to upstream's crossing rule fails here first, naming the integration point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importUpstream, readUpstream, point } from './helpers.mjs';

const { cases } = JSON.parse(readFileSync(new URL('../fixtures/alert-ticks.json', import.meta.url), 'utf8'));
const { AlertManager } = await importUpstream('public/js/alerts.js');

/** Runs upstream AlertManager.check over a tick list without its DOM-bound constructor. */
function runUpstream(alertSpec, ticks) {
  const alert = { id: 'a1', symbol: 'TEST:X', active: true, created: 0, message: '', ...alertSpec };
  const fired = [];
  const mgr = Object.create(AlertManager.prototype);
  Object.assign(mgr, { items: [alert], last: new Map(), save() {}, onTrigger: () => fired.push(current) });
  let current = -1;
  ticks.forEach((t, i) => { current = i; mgr.check('TEST:X', t === 'NaN' ? NaN : t); });
  return { fired, alert };
}

for (const c of cases) {
  test(`upstream check: ${c.name}`, () => {
    const { fired, alert } = runUpstream(c.alert, c.ticks);
    assert.deepEqual(fired, c.firesAt == null ? [] : [c.firesAt], point('alert-semantics'));
    if (c.firesAt != null) {
      assert.equal(alert.active, false, point('alert-semantics'));
      assert.equal(typeof alert.triggeredAt, 'number', point('alert-semantics'));
      assert.equal(alert.triggerPrice, c.ticks[c.firesAt], point('alert-semantics'));
    }
  });
}

test('alert records keep their field names', () => {
  const src = readUpstream('public/js/alerts.js');
  assert.match(src, /const a = \{ id: uid\(\), symbol, condition, price: Number\(price\), message: message \|\| '', active: true, created: Date\.now\(\) \}/, point('alert-semantics'));
  assert.match(src, /Object\.assign\(a, \{ active: false, triggeredAt: Date\.now\(\), triggerPrice: price \}\)/, point('alert-semantics'));
  assert.match(src, /Object\.assign\(a, \{ active: true, triggeredAt: null, triggerPrice: null \}\)/, `${point('alert-semantics')} re-arm`);
});
