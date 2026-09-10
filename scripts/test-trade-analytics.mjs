import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import ts from '../app/node_modules/typescript/lib/typescript.js';

const out = path.resolve('.tmp-webbridge/trade-analytics');
fs.mkdirSync(out, { recursive: true });
const source = fs.readFileSync('app/src/lib/tradeAnalytics.ts', 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
fs.writeFileSync(path.join(out, 'tradeAnalytics.mjs'), js);
const { analyzeTrades, compareExecutions, executionKey, normalizeCurrency, formatMoney } = await import(pathToFileURL(path.join(out, 'tradeAnalytics.mjs')));
const make = (id, side, qty, price, extra = {}) => ({ executionId: id, orderId: id, account: 'A', instrument: 'NQ SEP26', time: 100 + Number(id.replace(/\D/g, '') || 0), side, qty, price, pointValue: 20, commission: qty, currency: 'UsDollar', ...extra });
let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }

test('currency normalization keeps USD explicit', () => {
  assert.equal(normalizeCurrency('UsDollar'), 'USD');
  assert.equal(formatMoney(1234.5, 'UsDollar'), '1,234.50 USD');
  assert.equal(formatMoney(null), '—');
});
test('separate accounts and contracts never pair', () => {
  const data = analyzeTrades([make('1', 'Buy', 1, 100), make('2', 'Sell', 1, 101, { account: 'B' }), make('3', 'Sell', 1, 102, { instrument: 'ES SEP26' })]);
  assert.equal(data.trades.length, 0); assert.equal(data.openLots.length, 3);
});
test('FIFO partial exits allocate both entry and exit fees', () => {
  const data = analyzeTrades([make('1', 'Buy', 3, 100, { commission: 6 }), make('2', 'Sell', 1, 110, { commission: 3 }), make('3', 'Sell', 2, 105, { commission: 6 })]);
  assert.deepEqual(data.trades.map(t => [t.qty, t.gross, t.commission, t.net]), [[1, 200, 5, 195], [2, 200, 10, 190]]);
  assert.equal(data.summaries[0].net, 385); assert.equal(data.openLots.length, 0);
});
test('reversal keeps remaining short lot and allocates fees once', () => {
  const data = analyzeTrades([make('1', 'Buy', 1, 100), make('2', 'Sell', 3, 110), make('3', 'Buy', 2, 105)]);
  assert.deepEqual(data.trades.map(t => [t.qty, t.gross, t.commission]), [[1, 200, 2], [2, 200, 4]]);
  assert.equal(data.summaries[0].net, 394);
});
test('same-second millisecond order precedes lexical execution ID', () => {
  const rows = [make('a', 'Sell', 1, 110, { time: 100, timeMs: 100900 }), make('z', 'Buy', 1, 100, { time: 100, timeMs: 100100 })];
  assert.equal([...rows].sort(compareExecutions)[0].executionId, 'z');
  assert.equal(analyzeTrades(rows).trades[0].entry.executionId, 'z');
  assert.equal(analyzeTrades(rows).summaries[0].net, 198);
});
test('same replay cursor respects fill sequence before order ID', () => {
  const rows = [make('a', 'Sell', 1, 110, { time: 100, timeMs: 100000, sequence: 2 }), make('z', 'Buy', 1, 100, { time: 100, timeMs: 100000, sequence: 1 })];
  assert.equal([...rows].sort(compareExecutions)[0].executionId, 'z');
  assert.equal(analyzeTrades(rows).trades[0].entry.executionId, 'z');
  assert.equal(analyzeTrades(rows).summaries[0].net, 198);
});
test('null point value or fee does not become a fabricated zero', () => {
  for (const extra of [{ pointValue: null }, { pointValue: undefined }, { commission: null }, { commission: undefined }]) {
    const data = analyzeTrades([make('1', 'Buy', 1, 100, extra), make('2', 'Sell', 1, 110)]);
    assert.equal(data.trades[0].net, undefined); assert.equal(data.summaries[0].missing, 1);
  }
});
test('different or invalid point values are excluded from PnL', () => {
  for (const pointValue of [0, Infinity, -1, 10]) {
    const data = analyzeTrades([make('1', 'Buy', 1, 100, { pointValue }), make('2', 'Sell', 1, 110)]);
    assert.equal(data.trades[0].gross, undefined);
  }
});
test('drawdown uses net realized equity and preserves currencies', () => {
  const data = analyzeTrades([make('1', 'Buy', 1, 100), make('2', 'Sell', 1, 110), make('3', 'Buy', 1, 110), make('4', 'Sell', 1, 100), make('5', 'Buy', 1, 100, { currency: 'EUR' }), make('6', 'Sell', 1, 102, { currency: 'EUR' })]);
  const usd = data.summaries.find(s => s.currency === 'USD');
  assert.equal(usd.maxDrawdown, 202); assert.equal(usd.net, -4); assert.equal(usd.winRate, 0.5);
  assert.equal(data.summaries.find(s => s.currency === 'EUR').net, 38);
});
test('incomplete rows are excluded and invalid quantity cannot loop', () => {
  const data = analyzeTrades([make('1', 'Buy', Infinity, 100), make('2', 'Sell', 1, 101, { account: undefined }), make('3', 'Unknown', 1, 100)]);
  assert.equal(data.invalid, 3); assert.equal(data.trades.length, 0);
});
test('identity preserves partial fills and separates reused IDs', () => {
  assert.notEqual(executionKey(make('1', 'Buy', 1, 100)), executionKey(make('1', 'Buy', 1, 100, { account: 'B' })));
  assert.notEqual(executionKey(make('1', 'Buy', 1, 100, { executionId: undefined })), executionKey(make('1', 'Buy', 2, 100, { executionId: undefined })));
  assert.equal(executionKey(make('1', 'Buy', 1, 100)), executionKey(make('1', 'Buy', 1, 100, { commission: 9 })));
});
console.log(`Passed ${passed} trade analytics scenarios.`);
