import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import ts from '../app/node_modules/typescript/lib/typescript.js';

const out = path.resolve('.tmp-webbridge/monitor-page');
fs.mkdirSync(out, { recursive: true });
for (const name of ['chartInstrument', 'monitorData']) {
  const source = fs.readFileSync(`app/src/lib/${name}.ts`, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/from '(\.\/.+?)'/g, "from '$1.mjs'");
  fs.writeFileSync(path.join(out, `${name}.mjs`), js);
}
const {
  hasOpenPosition, openPositions, defaultInstrument,
  positionPnl, positionLineTitle, findProtection, totalUnrealized,
} = await import(pathToFileURL(path.join(out, 'monitorData.mjs')));

const pos = (instrument, quantity, averagePrice, extra = {}) => ({ instrument, quantity, averagePrice, marketPosition: quantity >= 0 ? 'Long' : 'Short', ...extra });
const order = (name, instrument, extra = {}) => ({ orderId: name, instrument, action: 'Sell', orderType: 'Limit', quantity: 2, filled: 0, limitPrice: 0, stopPrice: 0, averageFillPrice: 0, state: 'Working', oco: '', name, time: 1, ...extra });
let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }

test('position pnl follows signed quantity in both directions', () => {
  assert.equal(positionPnl(pos('NQ SEP26', 2, 100), 110, 20), 400);
  assert.equal(positionPnl(pos('NQ SEP26', 2, 100), 95, 20), -200);
  assert.equal(positionPnl(pos('NQ SEP26', -1, 100), 90, 20), 200);
  assert.equal(positionPnl(pos('NQ SEP26', -1, 100), 105, 20), -100);
});
test('position pnl never fabricates on missing inputs', () => {
  const p = pos('NQ SEP26', 1, 100);
  for (const [price, pv] of [[null, 20], [undefined, 20], [NaN, 20], [110, null], [110, 0], [110, -1], [110, Infinity]]) {
    assert.equal(positionPnl(p, price, pv), null);
  }
  assert.equal(positionPnl(pos('NQ SEP26', 1, NaN), 110, 20), null);
});
test('position line title shows quantity and signed pnl like the chart line', () => {
  assert.equal(positionLineTitle(pos('NQ SEP26', 2, 100), 110, 20), '+2 | +400$');
  assert.equal(positionLineTitle(pos('NQ SEP26', -1, 100), 105, 20), '-1 | -100$');
  assert.equal(positionLineTitle(pos('NQ SEP26', 2, 100), null, 20), '+2');
});
test('protection reads working TP/SL orders with limit or stop price and remaining quantity', () => {
  const protection = findProtection([
    order('TP1', 'NQ SEP26', { limitPrice: 110, quantity: 3, filled: 1 }),
    order('SL1', 'NQ SEP26', { stopPrice: 90 }),
    order('SL2', 'NQ SEP26', { limitPrice: 88, orderType: 'StopLimit' }),
    order('ENTRY', 'NQ SEP26', { limitPrice: 101 }),
    order('TP2', 'ES SEP26', { limitPrice: 5000 }),
  ], 'NQ SEP26');
  assert.deepEqual(protection.tp, [{ price: 110, qty: 2 }]);
  assert.deepEqual(protection.sl, [{ price: 90, qty: 2 }, { price: 88, qty: 2 }]);
});
test('protection skips filled or zero-price orders and matches chart aliases case-insensitively', () => {
  const protection = findProtection([
    order('TP1', 'NQ SEP26', { limitPrice: 110, quantity: 2, filled: 2 }),
    order('TP2', 'NQ SEP26', { limitPrice: 0, stopPrice: 0 }),
    order('SL1', '#mnqu6@cme', { stopPrice: 90, chartSymbols: ['#MNQU6@CME'] }),
  ], 'NQ SEP26');
  assert.deepEqual(protection.tp, []);
  assert.deepEqual(protection.sl, []);
  const atas = findProtection([order('TP1', '#MNQU6@CME', { limitPrice: 110 })], '#mnqu6@cme');
  assert.deepEqual(atas.tp, [{ price: 110, qty: 2 }]);
});
test('open position filtering and default instrument pick the largest absolute quantity', () => {
  const positions = [pos('ES SEP26', 0, 100), pos('NQ SEP26', -3, 100), pos('YM SEP26', 1, 100)];
  assert.equal(hasOpenPosition(positions), true);
  assert.equal(hasOpenPosition([pos('ES SEP26', 0, 100)]), false);
  assert.equal(hasOpenPosition([pos('ES SEP26', NaN, 100)]), false);
  assert.deepEqual(openPositions(positions).map(p => p.instrument), ['NQ SEP26', 'YM SEP26']);
  assert.equal(defaultInstrument(positions), 'NQ SEP26');
  assert.equal(defaultInstrument([pos('ES SEP26', 0, 100)]), null);
});
test('total unrealized sums live prices and falls back to the bridge total on gaps', () => {
  const positions = [pos('NQ SEP26', 2, 100), pos('ES SEP26', -1, 50)];
  const prices = new Map([['NQ SEP26', 110], ['ES SEP26', 55]]);
  const pointValues = new Map([['NQ SEP26', 20], ['ES SEP26', 50]]);
  assert.deepEqual(totalUnrealized(positions, prices, pointValues, 999), { value: 150, live: true });
  assert.deepEqual(totalUnrealized(positions, new Map([['NQ SEP26', 110]]), pointValues, 999), { value: 999, live: false });
  assert.deepEqual(totalUnrealized(positions, new Map(), pointValues, undefined), { value: null, live: false });
  assert.deepEqual(totalUnrealized(positions, prices, new Map(), 999), { value: 999, live: false });
  assert.deepEqual(totalUnrealized([], new Map(), new Map(), undefined), { value: 0, live: true });
});
console.log(`Passed ${passed} monitor page scenarios.`);
