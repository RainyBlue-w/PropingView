import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import ts from '../app/node_modules/typescript/lib/typescript.js';

const output = path.resolve('.tmp-webbridge/replay-persistence-unit');
fs.mkdirSync(output, { recursive: true });
for (const name of ['simTrading', 'replayStore']) {
  const source = fs.readFileSync(`app/src/lib/${name}.ts`, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  fs.writeFileSync(path.join(output, `${name}.mjs`), js.replace(/from '(\.\/.+?)'/g, "from '$1.mjs'"));
}
const { SimTrading, SIM_ACCOUNT } = await import(pathToFileURL(path.join(output, 'simTrading.mjs')));
const { createReplaySession, deleteReplaySession, loadReplaySessions, saveReplaySession, REPLAY_SESSION_PREFIX } = await import(pathToFileURL(path.join(output, 'replayStore.mjs')));
const backing = new Map();
let quotaFailure = false;
let deleteFailure = false;
globalThis.localStorage = {
  get length() { return backing.size; },
  key: index => [...backing.keys()][index] ?? null,
  getItem: key => backing.get(key) ?? null,
  setItem: (key, value) => {
    if (quotaFailure) throw new DOMException('Storage full', 'QuotaExceededError');
    backing.set(key, value);
  },
  removeItem: key => {
    if (deleteFailure) throw new DOMException('Storage unavailable', 'SecurityError');
    backing.delete(key);
  },
};
let last = 100;
let cursor = 1700000000;
const deps = { getLastPrice: () => last, pointValueOf: () => 10, getCursorTime: () => cursor };
const order = (action, quantity, extra = {}) => ({ account: SIM_ACCOUNT, symbol: 'TEST', action, quantity, orderType: 'MARKET', ...extra });
const bar = (extra = {}) => ({ time: cursor, open: 100, high: 103, low: 99, close: 102, volume: 1, ...extra });
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await test('restored positions, OCO, pending entry and counters continue without changing prior executions', async () => {
  const sim = new SimTrading(deps, { initialEquity: 25000 });
  await sim.placeOrder(order('BUY', 2, { tp: 105, sl: 95 }));
  await sim.placeOrder(order('BUY', 1, { orderType: 'STOPMARKET', stopPrice: 110, tp: 115, sl: 106 }));
  const snapshot = JSON.parse(JSON.stringify(sim.exportState()));
  const restored = new SimTrading(deps, { state: snapshot });
  assert.deepEqual(JSON.parse(JSON.stringify(restored.exportState())), snapshot);
  assert.equal((await restored.getAccounts()).accounts[0].cashValue, 25000);
  last = 102; cursor += 60;
  await restored.placeOrder(order('SELL', 1));
  assert.equal(restored.exportState().realized, 20);
  assert.deepEqual((await restored.getOrders()).orders.filter(o => o.oco).map(o => o.quantity), [1, 1]);
  restored.onBar('TEST', bar({ high: 106, low: 94 }));
  assert.equal((await restored.getPositions()).positions.length, 0);
  assert.equal((await restored.getOrders()).orders.length, 1);
  cursor += 60;
  restored.onBar('TEST', bar({ open: 110, high: 112, low: 109, close: 111 }));
  const after = restored.exportState();
  assert.equal(after.positions.find(p => p.instrument === 'TEST').quantity, 1);
  assert.deepEqual(after.orders.map(o => [o.name, o.quantity, o.limitPrice, o.stopPrice]), [['TP', 1, 115, 0], ['SL', 1, 0, 106]]);
  assert.equal(after.ocoSeq, 2);
  assert.ok(after.orderSeq > snapshot.orderSeq);
  assert.equal(after.executions[0].executionId, snapshot.executions[0].executionId);
  assert.equal(new Set(after.executions.map(e => e.executionId)).size, after.executions.length);
  for (const row of (await restored.getExecutions(SIM_ACCOUNT, 'TEST')).executions) {
    assert.equal(row.account, SIM_ACCOUNT); assert.equal(row.currency, 'USD');
    assert.equal(row.pointValue, 10); assert.equal(row.commission, 0); assert.ok(row.executionId);
  }
  last = 100;
});

await test('snapshots and restored engines cannot mutate one another', async () => {
  const sim = new SimTrading(deps);
  await sim.placeOrder(order('BUY', 1, { tp: 110, sl: 90 }));
  const snapshot = sim.exportState();
  const restored = new SimTrading(deps, { state: snapshot });
  snapshot.positions[0].quantity = 99;
  snapshot.orders[0].quantity = 99;
  snapshot.executions[0].price = 1;
  assert.equal(sim.exportState().positions[0].quantity, 1);
  assert.equal(restored.exportState().positions[0].quantity, 1);
  assert.equal(restored.exportState().orders[0].quantity, 1);
  assert.equal(restored.exportState().executions[0].price, 100);
});

await test('change notifications expose complete post-mutation states, including OCO legs', async () => {
  const seen = [];
  const sim = new SimTrading({ ...deps, onChange: () => seen.push(sim.exportState()) });
  await sim.placeOrder(order('BUY', 1, { tp: 110, sl: 90 }));
  assert.equal(seen.length, 1); assert.equal(seen[0].orders.length, 2);
  const pending = await sim.placeOrder(order('BUY', 1, { orderType: 'LIMIT', limitPrice: 80 }));
  await sim.changeOrder(SIM_ACCOUNT, pending.orderId, { limitPrice: 85 });
  await sim.cancelOrder(SIM_ACCOUNT, pending.orderId);
  sim.onBar('TEST', bar());
  await sim.closePosition(SIM_ACCOUNT, 'TEST');
  assert.equal(seen.length, 6);
  assert.equal(seen.at(-1).orders.length, 0);
  assert.equal(seen.at(-1).positions[0].quantity, 0);
  assert.equal(seen.at(-1).executions.length, 2);
});

await test('session save/load preserves settings, market metadata and independent trading state', async () => {
  const a = createReplaySession({ name: 'First', symbol: 'TEST', startTime: 1700000000, initialEquity: 25000 });
  const b = createReplaySession({ name: 'Second', symbol: 'OTHER', startTime: 1690000000, initialEquity: 12000 });
  const sim = new SimTrading(deps, { initialEquity: a.initialEquity });
  await sim.placeOrder(order('BUY', 2, { tp: 110, sl: 90 }));
  a.state = sim.exportState(); a.cursor = cursor; a.interval = '5'; a.speed = 2; a.stepSec = 900;
  a.lastPrices = { TEST: 100 }; a.pointValues = { TEST: 10 };
  saveReplaySession(a); saveReplaySession(b);
  const loaded = loadReplaySessions();
  assert.deepEqual(loaded.errors, []); assert.equal(loaded.sessions.length, 2);
  const restoredA = loaded.sessions.find(s => s.id === a.id), restoredB = loaded.sessions.find(s => s.id === b.id);
  assert.deepEqual(restoredA, JSON.parse(JSON.stringify(a)));
  assert.equal(restoredB.state.orders.length, 0); assert.equal(restoredB.initialEquity, 12000);
  const engineA = new SimTrading(deps, { state: restoredA.state });
  await engineA.closePosition(SIM_ACCOUNT, 'TEST');
  assert.equal(restoredB.state.executions.length, 0);
  assert.equal(loaded.sessions.find(s => s.id === a.id).state.positions[0].quantity, 2);
});

await test('quota failure is visible and leaves previous durable snapshot and current memory intact', async () => {
  const session = loadReplaySessions().sessions.find(s => s.name === 'First');
  const old = backing.get(`${REPLAY_SESSION_PREFIX}${session.id}`);
  session.cursor += 3600;
  quotaFailure = true;
  assert.throws(() => saveReplaySession(session), /保存失败.*当前会话仍保留在内存中/);
  quotaFailure = false;
  assert.equal(backing.get(`${REPLAY_SESSION_PREFIX}${session.id}`), old);
  assert.ok(session.cursor > JSON.parse(old).cursor);
  saveReplaySession(session);
  assert.equal(loadReplaySessions().sessions.find(s => s.id === session.id).cursor, session.cursor);
});

await test('corrupt sessions are reported and preserved while valid sessions remain available', async () => {
  const key = `${REPLAY_SESSION_PREFIX}broken`;
  backing.set(key, '{invalid-json');
  const loaded = loadReplaySessions();
  assert.equal(loaded.sessions.length, 2); assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0], /broken/); assert.equal(backing.get(key), '{invalid-json');
  const snapshot = loaded.sessions[0].state;
  assert.throws(() => new SimTrading(deps, { state: { ...snapshot, initialEquity: NaN } }), /损坏/);
  assert.throws(() => saveReplaySession({ ...loaded.sessions[0], cursor: 0 }), /不完整/);
});

await test('paged simulation execution API honors caller page size after restore', async () => {
  const sim = new SimTrading(deps);
  for (let i = 0; i < 7; i++) await sim.placeOrder(order(i % 2 ? 'SELL' : 'BUY', 1));
  const restored = new SimTrading(deps, { state: sim.exportState() });
  const first = await restored.getExecutionPage(SIM_ACCOUNT, '', 0, 2000000000, 0, 3);
  const second = await restored.getExecutionPage(SIM_ACCOUNT, '', 0, 2000000000, first.nextOffset, 3);
  const third = await restored.getExecutionPage(SIM_ACCOUNT, '', 0, 2000000000, second.nextOffset, 3);
  assert.equal(first.executions.length, 3); assert.equal(second.executions.length, 3);
  assert.equal(third.executions.length, 1); assert.equal(third.nextOffset, null);
  assert.equal(new Set([...first.executions, ...second.executions, ...third.executions].map(e => e.executionId)).size, 7);
});

await test('same-bar fills retain actual execution order through snapshot restore and legacy migration', async () => {
  const sim = new SimTrading(deps);
  const older = await sim.placeOrder(order('BUY', 1, { orderType: 'LIMIT', limitPrice: 90 }));
  const newer = await sim.placeOrder(order('BUY', 1));
  // A later-created market order fills before the earlier limit, within the same replay bar.
  await sim.changeOrder(SIM_ACCOUNT, older.orderId, { limitPrice: 101 });
  const snapshot = JSON.parse(JSON.stringify(sim.exportState()));
  assert.deepEqual(snapshot.executions.map(e => e.orderId), [newer.orderId, older.orderId]);
  assert.equal(new Set(snapshot.executions.map(e => e.time)).size, 1);
  assert.deepEqual(snapshot.executions.map(e => e.sequence), [1, 2]);
  assert.deepEqual(snapshot.executions.map(e => e.timeMs), [cursor * 1000, cursor * 1000]);
  const restored = new SimTrading(deps, { state: snapshot });
  for (let i = 0; i < 10; i++) await restored.placeOrder(order(i % 2 ? 'BUY' : 'SELL', 1));
  const rows = restored.exportState().executions;
  assert.deepEqual(rows.map(e => e.sequence), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.equal(new Set(rows.map(e => e.time)).size, 1);
  assert.deepEqual(rows.slice(0, 2), snapshot.executions);
  const legacy = { ...snapshot, executions: snapshot.executions.map(({ sequence, timeMs, ...row }) => row) };
  const legacyRestored = new SimTrading(deps, { state: legacy });
  await legacyRestored.closePosition(SIM_ACCOUNT, 'TEST');
  assert.deepEqual(legacyRestored.exportState().executions.map(e => e.sequence), [1, 2, 3]);
  assert.equal(legacyRestored.exportState().executions.at(-1).timeMs, cursor * 1000);
});

await test('deleting a session removes its trades and snapshot while preserving all other storage', async () => {
  const session = createReplaySession({ name: 'Delete me', symbol: 'TEST', startTime: 1700000000, initialEquity: 25000 });
  const sim = new SimTrading(deps, { initialEquity: session.initialEquity });
  await sim.placeOrder(order('BUY', 1));
  await sim.closePosition(SIM_ACCOUNT, 'TEST');
  session.state = sim.exportState();
  session.cursor = cursor;
  saveReplaySession(session);
  // Keep a similarly named session to detect prefix matching instead of exact-key deletion.
  saveReplaySession({ ...session, id: `${session.id}-keep`, name: 'Keep me' });
  backing.set('nt8-terminal-tv-layouts-v2', JSON.stringify({ layouts: [{ id: session.id }] }));
  backing.set('unrelated-real-trade-data', JSON.stringify({ executionId: session.id }));
  const expected = new Map(backing);
  const targetKey = `${REPLAY_SESSION_PREFIX}${session.id}`;
  assert.equal(JSON.parse(backing.get(targetKey)).state.executions.length, 2);
  expected.delete(targetKey);

  deleteReplaySession(session.id);
  assert.deepEqual(backing, expected);
  assert.ok(!loadReplaySessions().sessions.some(row => row.id === session.id));
  // Reload the storage module to represent a page reload without in-memory session state.
  const reloaded = await import(`${pathToFileURL(path.join(output, 'replayStore.mjs')).href}?after-delete`);
  assert.ok(!reloaded.loadReplaySessions().sessions.some(row => row.id === session.id));
  assert.deepEqual(backing, expected);
  deleteReplaySession(session.id);
  assert.deepEqual(backing, expected);
});

await test('session deletion rejects empty IDs without changing any storage', async () => {
  const expected = new Map(backing);
  for (const id of ['', '   ', '\t\n', undefined, null]) {
    assert.throws(() => deleteReplaySession(id), /ID 不能为空/);
    assert.deepEqual(backing, expected);
  }
});

await test('failed deletion reports an error and retains the complete session for retry', async () => {
  const session = loadReplaySessions().sessions.find(row => row.name === 'Keep me');
  const expected = new Map(backing);
  deleteFailure = true;
  try {
    assert.throws(() => deleteReplaySession(session.id), /回放会话删除失败.*Storage unavailable/);
    assert.deepEqual(backing, expected);
    assert.deepEqual(loadReplaySessions().sessions.find(row => row.id === session.id), session);
  } finally {
    deleteFailure = false;
  }
  deleteReplaySession(session.id);
  expected.delete(`${REPLAY_SESSION_PREFIX}${session.id}`);
  assert.deepEqual(backing, expected);
});

console.log(`${passed} replay persistence scenarios passed`);
