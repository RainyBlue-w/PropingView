import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import ts from '../app/node_modules/typescript/lib/typescript.js';

// Transpile the current production router and both backends. Every HTTP request is intercepted.
const output = path.resolve('.tmp-webbridge/trading-router-unit');
fs.mkdirSync(output, { recursive: true });
for (const name of ['config', 'bridgeAccounts', 'nt8Trading', 'simTrading', 'tradingRouter']) {
  const source = fs.readFileSync(`app/src/lib/${name}.ts`, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  fs.writeFileSync(path.join(output, `${name}.mjs`), js.replace(/from '(\.\/.+?)'/g, "from '$1.mjs'"));
}
const network = [];
const originalFetch = globalThis.fetch;
globalThis.localStorage = { getItem: () => 'http://bridge.invalid' };
globalThis.fetch = async (url, init = {}) => {
  const endpoint = new URL(url).pathname;
  network.push({ endpoint, method: init.method ?? 'GET', payload: init.body ? JSON.parse(init.body) : null });
  return { ok: true, json: async () => ({ ok: true, orderId: 'LIVE-STUB-ONLY', accounts: [{ name: 'REAL-TEST' }] }) };
};
const { SimTrading, SIM_ACCOUNT } = await import(pathToFileURL(path.join(output, 'simTrading.mjs')));
const { trading, setTradingBackend } = await import(pathToFileURL(path.join(output, 'tradingRouter.mjs')));
const payload = (account, extra = {}) => ({ account, symbol: 'TEST', action: 'BUY', quantity: 2, orderType: 'MARKET', ...extra });
const mutations = account => [
  () => trading.placeOrder(payload(account)),
  () => trading.cancelOrder(account, 'PENDING'),
  () => trading.changeOrder(account, 'PENDING', { limitPrice: 90 }),
  () => trading.closePosition(account, 'TEST'),
];
const makeSim = () => new SimTrading({ getLastPrice: () => 100, pointValueOf: () => 10, getCursorTime: () => 1700000000 });
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

try {
  await test('live backend rejects every SIM-REPLAY mutation before any network request', async () => {
    setTradingBackend(null);
    for (const mutate of mutations(SIM_ACCOUNT)) await assert.rejects(mutate, /交易账户与当前会话不一致/);
    assert.equal(network.length, 0);
  });

  await test('simulation backend rejects every real-account mutation without changing its state', async () => {
    const sim = makeSim();
    setTradingBackend(sim);
    const before = sim.exportState();
    for (const mutate of mutations('REAL-TEST')) await assert.rejects(mutate, /交易账户与当前会话不一致/);
    assert.deepEqual(sim.exportState(), before);
    assert.equal(network.length, 0);
  });

  await test('valid simulated place/change/cancel/close and reads stay entirely local', async () => {
    const sim = makeSim();
    setTradingBackend(sim);
    const entry = await trading.placeOrder(payload(SIM_ACCOUNT));
    assert.match(entry.orderId, /^SIM-/);
    assert.equal((await trading.getPositions(SIM_ACCOUNT)).positions[0].quantity, 2);
    const pending = await trading.placeOrder(payload(SIM_ACCOUNT, { orderType: 'LIMIT', limitPrice: 90 }));
    await trading.changeOrder(SIM_ACCOUNT, pending.orderId, { limitPrice: 91 });
    assert.equal((await trading.getOrders(SIM_ACCOUNT)).orders[0].limitPrice, 91);
    await trading.cancelOrder(SIM_ACCOUNT, pending.orderId);
    assert.equal((await trading.getOrders(SIM_ACCOUNT)).orders.length, 0);
    await trading.closePosition(SIM_ACCOUNT, 'TEST');
    assert.equal((await trading.getPositions(SIM_ACCOUNT)).positions.length, 0);
    assert.equal((await trading.getAccounts()).accounts[0].name, SIM_ACCOUNT);
    assert.equal((await trading.getExecutionPage(SIM_ACCOUNT, '', 0, 1800000000, 0, 1)).executions.length, 1);
    assert.equal(sim.exportState().executions.length, 2);
    assert.equal(network.length, 0);
  });

  await test('callbacks captured during replay cannot reach NT8 after replay exits', async () => {
    const sim = makeSim();
    setTradingBackend(sim);
    const queuedCallbacks = mutations(SIM_ACCOUNT);
    setTradingBackend(null);
    for (const callback of queuedCallbacks) await assert.rejects(callback, /交易账户与当前会话不一致/);
    assert.equal(sim.exportState().executions.length, 0);
    assert.equal(network.length, 0);
  });

  await test('restored live routing sends only explicitly real-account operations to intercepted NT8 endpoints', async () => {
    setTradingBackend(null);
    for (const mutate of mutations('REAL-TEST')) await mutate();
    assert.deepEqual(network.map(call => call.endpoint), ['/api/order/place', '/api/order/cancel', '/api/order/change', '/api/position/close']);
    assert.ok(network.every(call => call.method === 'POST' && call.payload.account === 'REAL-TEST'));
    assert.equal((await trading.getAccounts()).accounts[0].name, 'bridge:nt8:REAL-TEST');
    assert.equal(network.at(-1).endpoint, '/api/accounts');
    assert.equal(network.length, 6);
  });
} finally {
  setTradingBackend(null);
  globalThis.fetch = originalFetch;
}

console.log(`${passed} trading router scenarios passed; all bridge calls intercepted`);
