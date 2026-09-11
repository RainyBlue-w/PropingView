import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import ts from '../app/node_modules/typescript/lib/typescript.js';

const out = path.resolve('.tmp-webbridge/unit');
fs.mkdirSync(out, { recursive: true });
for (const name of ['config', 'bridgeAccounts', 'nt8Trading', 'nt8Bridge', 'simTrading', 'symbolSearch', 'tvDatafeed', 'replaySession']) {
  const source = fs.readFileSync(`app/src/lib/${name}.ts`, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  fs.writeFileSync(path.join(out, `${name}.mjs`), js.replace(/from '(.\/.+?)'/g, "from '$1.mjs'"));
}
globalThis.window = {};
globalThis.localStorage = { getItem: () => null };
const { SimTrading, SIM_ACCOUNT } = await import(pathToFileURL(path.join(out, 'simTrading.mjs')));
const { TvDatafeed } = await import(pathToFileURL(path.join(out, 'tvDatafeed.mjs')));
const { createNt8Adapter } = await import(pathToFileURL(path.join(out, 'nt8Bridge.mjs')));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`PASS ${name}`); }
const makeSim = () => new SimTrading({ getLastPrice: () => 100, pointValueOf: () => 10, getCursorTime: () => 1700000000 });
const order = (action, quantity, extra = {}) => ({ account: SIM_ACCOUNT, symbol: 'TEST', action, quantity, orderType: 'MARKET', ...extra });
const bars = (from, count) => Array.from({ length: count }, (_, i) => ({ time: from + i * 60, open: 100, high: 101, low: 99, close: 100, volume: 1 }));

await test('long and short: add/reduce keep prices, flat cancels old protection', async () => {
  for (const [entry, exit] of [['BUY', 'SELL'], ['SELL', 'BUY']]) {
    const sim = makeSim();
    await sim.placeOrder(order(entry, 2, { tp: entry === 'BUY' ? 110 : 90, sl: entry === 'BUY' ? 90 : 110 }));
    const before = (await sim.getOrders()).orders;
    await sim.placeOrder(order(entry, 3));
    let orders = (await sim.getOrders()).orders;
    assert.deepEqual(orders.map(o => o.quantity), [5, 5]);
    assert.deepEqual(orders.map(o => [o.limitPrice, o.stopPrice, o.orderId]), before.map(o => [o.limitPrice, o.stopPrice, o.orderId]));
    await sim.placeOrder(order(exit, 4));
    assert.deepEqual((await sim.getOrders()).orders.map(o => o.quantity), [1, 1]);
    await sim.placeOrder(order(exit, 1));
    assert.equal((await sim.getOrders()).orders.length, 0);
    assert.equal((await sim.getPositions()).positions.length, 0);
  }
});
await test('addition with another bracket preset keeps existing protection without duplicating', async () => {
  const sim = makeSim();
  await sim.placeOrder(order('BUY', 1, { tp: 110, sl: 90 }));
  await sim.placeOrder(order('BUY', 2, { tp: 120, sl: 80 }));
  assert.deepEqual((await sim.getOrders()).orders.map(o => [o.quantity, o.limitPrice, o.stopPrice]), [[3, 110, 0], [3, 0, 90]]);
});
await test('reversal cancels old direction and protects only the new net position', async () => {
  const sim = makeSim();
  await sim.placeOrder(order('BUY', 2, { tp: 110, sl: 90 }));
  await sim.placeOrder(order('SELL', 5, { tp: 80, sl: 120 }));
  assert.deepEqual((await sim.getOrders()).orders.map(o => [o.action, o.quantity]), [['Buy', 3], ['Buy', 3]]);
});
await test('unfilled limit/stop bracket preview disappears on fill/cancel', async () => {
  const sim = makeSim();
  const limit = await sim.placeOrder(order('BUY', 2, { orderType: 'LIMIT', limitPrice: 95, tp: 110, sl: 90 }));
  const stop = await sim.placeOrder(order('BUY', 1, { orderType: 'STOPMARKET', stopPrice: 105, tp: 115, sl: 98 }));
  assert.equal((await sim.getBrackets()).brackets.length, 2);
  await sim.cancelOrder('', stop.orderId);
  sim.onBar('TEST', { time: 1700000060, open: 100, high: 102, low: 94, close: 96, volume: 1 });
  assert.equal((await sim.getBrackets()).brackets.length, 0);
  assert.equal((await sim.getExecutions('', 'TEST')).executions[0].orderId, limit.orderId);
});
await test('OCO: both prices touched in one bar still produces only one exit', async () => {
  const sim = makeSim();
  await sim.placeOrder(order('BUY', 2, { tp: 110, sl: 90 }));
  sim.onBar('TEST', { time: 1700000060, open: 100, high: 120, low: 80, close: 100, volume: 1 });
  assert.equal((await sim.getPositions()).positions.length, 0);
  assert.equal((await sim.getExecutions('', 'TEST')).executions.length, 2);
});
await test('execution pagination preserves >200 trades including same-second fills', async () => {
  const sim = makeSim();
  for (let i = 0; i < 231; i++) await sim.placeOrder(order(i % 2 ? 'SELL' : 'BUY', 1));
  const a = await sim.getExecutionPage('', '', 1699999999, 1700000001, 0);
  const b = await sim.getExecutionPage('', '', 1699999999, 1700000001, a.nextOffset);
  const c = await sim.getExecutionPage('', '', 1699999999, 1700000001, b.nextOffset);
  assert.equal(a.total, 231); assert.equal(c.nextOffset, null);
  assert.equal(new Set([...a.executions, ...b.executions, ...c.executions].map(e => e.executionId)).size, 231);
  assert.equal((await sim.getExecutionPage('', 'OTHER', 0, 1800000000)).executions.length, 0);
});
await test('datafeed sorts/deduplicates and excludes the right boundary (max 500)', async () => {
  const feed = new TvDatafeed({ getHistory: async () => [...bars(1700000000, 501).reverse(), ...bars(1700000000, 2)], getSymbols: async () => [], subscribe: () => () => {} });
  const result = await new Promise((resolve, reject) => feed.getBars({ ticker: 'TEST' }, '1', { from: 1700000000, to: 1700030000 }, resolve, reject));
  assert.equal(result.length, 500); assert.equal(result[0].time, 1700000000000); assert.equal(result.at(-1).time, 1700029940000);
});
await test('legacy bridge expands calendar window, slices output, reuses request', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    const q = new URL(url).searchParams;
    assert.ok(Number(q.get('from')) < 1700000000 - 3600);
    assert.ok(Number(q.get('to')) > 1700000300 + 3600);
    return { ok: true, json: async () => ({ bars: bars(1699999940, 10) }) };
  };
  try {
    const adapter = createNt8Adapter();
    const result = await adapter.getHistory('TEST', 60, 1700000000, 1700000300);
    assert.equal(result.length, 6);
    await adapter.getHistory('TEST', 60, 1700000060, 1700000300);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
await test('updated bridge receives narrow range, without compatibility padding', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    const q = new URL(url).searchParams;
    assert.equal(q.get('from'), '1700000000'); assert.equal(q.get('to'), '1700000300');
    return { ok: true, json: async () => ({ bars: bars(1700000000, 6) }) };
  };
  try { await createNt8Adapter({ connected: true, historyWindowVersion: 1 }).getHistory('TEST', 60, 1700000000, 1700000300); }
  finally { globalThis.fetch = original; }
});
await test('SSE reconnect backfills missed bars before releasing queued live frames', async () => {
  const originalFetch = globalThis.fetch, originalSse = globalThis.EventSource;
  let connection, complete;
  globalThis.EventSource = class { constructor() { connection = this; } close() {} };
  globalThis.fetch = () => new Promise(resolve => { complete = resolve; });
  try {
    const seen = [];
    const stop = createNt8Adapter({ connected: true, historyWindowVersion: 1 }).subscribe('TEST', 60, b => seen.push(b.time));
    connection.onmessage({ data: JSON.stringify(bars(1700000000, 1)[0]) });
    connection.onopen();
    connection.onmessage({ data: JSON.stringify(bars(1700000180, 1)[0]) });
    assert.deepEqual(seen, [1700000000]);
    complete({ ok: true, json: async () => ({ bars: bars(1700000000, 3) }) });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(seen, [1700000000, 1700000000, 1700000060, 1700000120, 1700000180]);
    stop();
    connection.onmessage({ data: JSON.stringify(bars(1700000240, 1)[0]) });
    assert.equal(seen.at(-1), 1700000180);
  } finally { globalThis.fetch = originalFetch; globalThis.EventSource = originalSse; }
});
await test('search resolves a contract missing from the catalog and discards the previous source response', async () => {
  const native = { symbol: 'NQ 09-26', name: 'Nasdaq September', tickSize: .25, type: 'futures' };
  let finish;
  const adapter = { getSymbols: async () => [], getHistory: async () => [], subscribe: () => () => {},
    resolve: async symbol => { assert.equal(symbol, native.symbol); return native; } };
  const feed = new TvDatafeed(adapter);
  assert.equal(await feed.lookupSymbol(' NQ 09-26 '), native);
  adapter.resolve = () => new Promise(resolve => { finish = resolve; });
  const pending = feed.lookupSymbol(native.symbol);
  feed.setAdapter({ ...adapter, resolve: undefined });
  finish(native);
  assert.equal(await pending, null, 'an old source contract cannot enter the current search results');
  assert.equal(await feed.lookupSymbol(native.symbol), null, 'a source without direct lookup remains supported');
});
console.log(`${passed} regression scenarios passed`);
