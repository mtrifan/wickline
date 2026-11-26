// The point editor (public/js/point-editor.js, issue #6): which fields each drawing has, the date box,
// typed prices and the patches it applies. Run: node test/point-editor.test.mjs
import assert from 'node:assert/strict';
import { editablePoints, timeToInput, inputToTime, parsePrice, pointPatch, LABEL_TOOLS } from '../public/js/point-editor.js';

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ok ${name}`); };
const fields = (type) => editablePoints({ type }).map((p) => `${p.key}:${p.price ? 'P' : ''}${p.time ? 'T' : ''}`).join(' ');

ok('each drawing shows the parts of its points that mean something', () => {
  assert.equal(fields('trend'), 'p1:PT p2:PT');
  assert.equal(fields('hline'), 'p1:P', 'a horizontal line has only a price');
  assert.equal(fields('vline'), 'p1:T', 'a vertical line has only a time');
  assert.equal(fields('avwap'), 'p1:T', 'an anchored VWAP only its start');
  assert.equal(fields('channel'), 'p1:PT p2:PT p3:PT');
  assert.equal(fields('long'), 'p1:PT p2:PT p3:P', 'the stop shares the entry\'s time');
  assert.equal(fields('arrowUp'), 'p1:PT');
  assert.equal(fields('fib'), 'p1:PT p2:PT');
  assert.deepEqual(editablePoints(null), []);
  assert.ok(LABEL_TOOLS.has('trend') && LABEL_TOOLS.has('hline') && !LABEL_TOOLS.has('text') && !LABEL_TOOLS.has('fib'));
});

ok('the date box: a date on daily charts, date and time otherwise, and back', () => {
  const t = Date.UTC(2026, 10, 20, 14, 35) / 1000; // chart times are wall-clock times stored as UTC
  assert.equal(timeToInput(t, false), '2026-11-20T14:35');
  assert.equal(timeToInput(Date.UTC(2026, 10, 20) / 1000, true), '2026-11-20');
  assert.equal(inputToTime('2026-11-20T14:35', false), t);
  assert.equal(inputToTime('2026-11-20', true), Date.UTC(2026, 10, 20) / 1000);
  assert.equal(inputToTime('2026-11-20', false), null, 'intraday needs a time');
  assert.equal(inputToTime('', true), null);
  assert.equal(inputToTime('20/11/2026', true), null);
});

ok('typed prices: either decimal mark, thousands as the language writes them', () => {
  assert.equal(parsePrice('1234.5'), 1234.5);
  assert.equal(parsePrice('1,234.5'), 1234.5);
  assert.equal(parsePrice('1.234,5'), 1234.5);
  assert.equal(parsePrice('1234,5'), 1234.5);
  assert.equal(parsePrice('1,234'), 1234, 'English: a thousands comma');
  assert.equal(parsePrice('1,234', true), 1.234, 'German: a decimal comma');
  assert.equal(parsePrice('1.234', true), 1234, 'German: a thousands dot');
  assert.equal(parsePrice('123,456', true), 123.456, 'what the editor shows in German reads back the same');
  assert.equal(parsePrice('0.00001234'), 0.00001234);
  assert.equal(parsePrice(' 59 930,5 ', true), 59930.5);
  assert.equal(parsePrice('abc'), null);
  assert.equal(parsePrice(''), null);
});

ok('an edit is a patch for one point; a position\'s stop follows the entry\'s time', () => {
  const d = { type: 'trend', p1: { time: 10, price: 1 }, p2: { time: 20, price: 2 } };
  assert.deepEqual(pointPatch(d, 'p2', 'price', 5), { p2: { time: 20, price: 5 } });
  const pos = { type: 'long', p1: { time: 10, price: 100 }, p2: { time: 30, price: 110 }, p3: { time: 10, price: 90 } };
  assert.deepEqual(pointPatch(pos, 'p1', 'time', 15), { p1: { time: 15, price: 100 }, p3: { time: 15, price: 90 } });
  assert.deepEqual(pointPatch(pos, 'p3', 'price', 95), { p3: { time: 10, price: 95 } });
});

console.log(`point-editor: ${n} checks passed`);
