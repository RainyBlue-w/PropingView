// All HTTP traffic is intercepted. This test never connects to an installed trading platform.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from '../app/node_modules/typescript/lib/typescript.js';

const require = createRequire(path.resolve('app/package.json'));
const storage = new Map([['nt8-terminal-account', 'Shared/@ 账户']]);
const calls = [];
const sources = { nt8: { connected: true, provider: 'nt8' }, atas: { connected: true, provider: 'atas' } };
const pending = new Map();
const context = vm.createContext({ URL, URLSearchParams, AbortController, setTimeout, clearTimeout, console,
  window: { location: new URL('https://terminal.example/') },
  localStorage: { get length() { return storage.size; }, key: index => [...storage.keys()][index] ?? null,
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
  fetch: async (url, options = {}) => {
    const address = new URL(url);
    assert.equal(address.origin, 'https://terminal.example', 'unexpected request must never leave the isolated mock');
    const provider = address.pathname.startsWith('/atas/') ? 'atas' : 'nt8';
    const endpoint = address.pathname.replace(/^\/atas/, '');
    const payload = options.body ? JSON.parse(options.body) : null;
    calls.push({ provider, endpoint, payload, query: address.searchParams });
    if (pending.has(provider)) await pending.get(provider);
    if (!sources[provider]) throw new Error('Offline mock');
    const state = sources[provider];
    const data = endpoint === '/api/status' ? state
      : endpoint === '/api/accounts' ? { accounts: [{ name: 'Shared/@ 账户', displayName: '共享账户', connection: 'Prop', currency: 'USD' }] }
      : endpoint === '/api/executions' ? { executions: [{ account: 'Shared/@ 账户', executionId: 'same-fill-id', orderId: 'same-order-id', instrument: 'ES', qty: 1, price: 100, side: 'Buy', time: 1 }], nextOffset: null }
      : endpoint === '/api/resolve' ? { symbol: address.searchParams.get('symbol'), name: 'ES test future', tickSize: 0.25, pointValue: 50, exchange: state.exchange }
      : endpoint === '/api/symbols' ? { symbols: [{ symbol: 'ES', name: 'ES test future', tickSize: 0.25, pointValue: 50, exchange: state.exchange }] }
      : endpoint === '/api/history' ? { bars: [{ time: 60, open: 100, high: 100, low: 100, close: 100, volume: 1 }] }
      : endpoint === '/api/orders' ? { orders: [] }
      : endpoint === '/api/positions' ? { positions: [] }
      : endpoint === '/api/brackets' ? { brackets: [] }
      : endpoint.startsWith('/api/order/') || endpoint === '/api/position/close' ? { ok: true, orderId: 'MOCK-ONLY' }
      : assert.fail(`Unmocked endpoint ${endpoint}`);
    return { ok: true, json: async () => data };
  },
});
const cache = new Map();
function load(name) {
  const filename = path.resolve('app/src', name);
  if (cache.has(filename)) return cache.get(filename).exports;
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  cache.set(filename, module);
  const importModule = specifier => {
    if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return require(specifier);
    const target = specifier.startsWith('@/') ? path.resolve('app/src', specifier.slice(2)) : path.resolve(path.dirname(filename), specifier);
    const file = fs.existsSync(`${target}.ts`) ? `${target}.ts` : `${target}.tsx`;
    return load(path.relative(path.resolve('app/src'), file));
  };
  const initialize = vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename });
  initialize(importModule, module, module.exports);
  return module.exports;
}
const config = load('lib/config.ts');
const accounts = load('lib/bridgeAccounts.ts');
const api = load('lib/nt8Trading.ts');
const feed = load('lib/nt8Bridge.ts');
const analytics = load('lib/tradeAnalytics.ts');
const name = 'Shared/@ 账户';
const nt8 = accounts.bridgeAccountId('nt8', name), atas = accounts.bridgeAccountId('atas', name);

const all = await api.nt8Trading.getAccounts();
assert.equal(all.accounts.length, 2);
assert.deepEqual(Array.from(all.accounts, account => account.name), [nt8, atas]);
assert.ok(all.accounts.every(account => account.displayName === '共享账户'));
assert.deepEqual(Array.from(all.accounts, account => account.connection), ['NT8 · Prop', 'ATAS X · Prop']);
assert.equal(accounts.displayBridgeAccount(atas), name);
assert.equal(accounts.migrateLegacyAccount(name), nt8);
assert.equal(accounts.migrateLegacyAccount(nt8), nt8);
assert.equal(accounts.migrateLegacyAccount('SIM-REPLAY'), 'SIM-REPLAY');
console.log('PASS same-named accounts remain distinct, with readable names and separate provider groups');

calls.length = 0;
for (const [id, provider] of [[nt8, 'nt8'], [atas, 'atas']]) {
  config.setProvider(provider === 'nt8' ? 'atas' : 'nt8'); // Chart feed is deliberately the other provider.
  await api.nt8Trading.placeOrder({ account: id, symbol: 'ES', action: 'BUY', orderType: 'LIMIT', quantity: 1, limitPrice: 100 });
  await api.nt8Trading.cancelOrder(id, 'same-order-id');
  await api.nt8Trading.changeOrder(id, 'same-order-id', { limitPrice: 101 });
  await api.nt8Trading.closePosition(id, 'ES');
  await api.nt8Trading.getPositions(id);
  await api.nt8Trading.getOrders(id);
  await api.nt8Trading.getBrackets(id);
  assert.ok(calls.slice(-7).every(call => call.provider === provider));
  assert.ok(calls.slice(-7).every(call => call.payload ? call.payload.account === name : call.query.get('account') === name));
}
console.log('PASS every order mutation and account read routes by account, independent of the selected chart feed');

const first = (await api.nt8Trading.getExecutionPage(nt8, '', 0, 2)).executions[0];
const second = (await api.nt8Trading.getExecutionPage(atas, '', 0, 2)).executions[0];
assert.notEqual(analytics.executionKey(first), analytics.executionKey(second));
assert.equal(first.account, nt8);
assert.equal(second.account, atas);
console.log('PASS duplicate fill/order IDs from different bridges cannot overwrite or pair across accounts');

for (const [offline, available] of [['nt8', 'atas'], ['atas', 'nt8']]) {
  const old = sources[offline];
  sources[offline] = null;
  const result = await api.nt8Trading.getAccounts();
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].provider, available);
  const statuses = await Promise.all(['nt8', 'atas'].map(provider => feed.checkNt8Status(provider)));
  assert.equal(statuses[offline === 'nt8' ? 0 : 1], null);
  assert.equal(statuses[available === 'nt8' ? 0 : 1].connected, true);
  sources[offline] = old;
}
sources.atas = { connected: true, provider: 'nt8' };
assert.equal(await feed.checkNt8Status('atas'), null, 'misconfigured ATAS URL must not appear connected to NT8');
sources.atas = { connected: true, provider: 'atas' };
console.log('PASS one offline bridge does not hide the other; status detects a mismatched upstream');

config.setProvider('nt8');
const nt8Feed = feed.createNt8Adapter({ connected: true, provider: 'nt8', historyWindowVersion: 1 });
let release;
pending.set('nt8', new Promise(resolve => { release = resolve; }));
const inFlight = nt8Feed.getHistory('ES', 60, 60, 60);
config.setProvider('atas');
release(); pending.delete('nt8');
await inFlight;
await nt8Feed.getHistory('ES', 60, 60, 60);
assert.equal(calls.at(-1).provider, 'nt8');
const atasFeed = feed.createNt8Adapter({ connected: true, provider: 'atas', historyWindowVersion: 1 });
await atasFeed.getHistory('ES', 60, 60, 60);
assert.equal(calls.at(-1).provider, 'atas');
console.log('PASS existing chart adapters keep their original source across asynchronous feed switching');

const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const Status = load('components/BridgeConnectionStatus.tsx').default;
const html = renderToStaticMarkup(React.createElement(Status, { statuses: { nt8: { connected: true }, atas: null } }));
assert.match(html, /NT8 已连接/); assert.match(html, /ATAS 未连接/);
assert.match(html, /data-bridge-status="nt8"/); assert.match(html, /data-bridge-status="atas"/);
console.log('PASS both connection states are rendered independently');

// A minimal transaction fixture models the existing v1 database, including old NT8 records.
const legacy = { ...first, account: name, commission: 7, currency: 'USD' };
const stores = {
  executions: new Map([[analytics.executionKey(legacy), { key: analytics.executionKey(legacy), row: legacy }]]),
  meta: new Map([['lastSynced', 100]]),
};
const database = {
  close() {},
  transaction() {
    const transaction = {
      objectStore(name) {
        return {
          getAll: () => ({ result: [...stores[name].values()] }),
          get: key => ({ result: stores[name].get(key) }),
          put: (value, key) => { stores[name].set(key ?? value.key, structuredClone(value)); },
        };
      },
    };
    queueMicrotask(() => transaction.oncomplete?.());
    return transaction;
  },
};
context.indexedDB = {
  open(name) {
    assert.equal(name, 'nt8-terminal-trade-archive', 'existing NT8 archive must remain readable');
    const request = { result: database };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  },
};
sources.nt8.executionArchiveVersion = 1;
sources.atas.executionArchiveVersion = 1;
const archive = load('lib/historyStore.ts');
await archive.syncHistoryNow();
let snapshot = archive.getHistoryArchive();
assert.equal(snapshot.rows.length, 2, 'legacy NT8 row and fresh NT8 row must deduplicate while retaining ATAS');
assert.equal(snapshot.rows.find(row => row.account === nt8).commission, 7, 'sparse upstream data must retain old archive metadata');
assert.ok(snapshot.rows.every(row => row.accountDisplayName === '共享账户'));
assert.ok(stores.meta.get('bridgeSync').nt8 > 100 && stores.meta.get('bridgeSync').atas > 100);
sources.nt8 = null;
await archive.syncHistoryNow();
assert.equal(archive.getHistoryArchive().rows.length, 2, 'one bridge disconnecting cannot erase either archive');
sources.atas = null;
cache.delete(path.resolve('app/src/lib/historyStore.ts'));
const offlineArchive = load('lib/historyStore.ts');
await offlineArchive.syncHistoryNow();
snapshot = offlineArchive.getHistoryArchive();
assert.equal(snapshot.rows.length, 2);
assert.ok(snapshot.rows.every(row => row.accountDisplayName === '共享账户'));
console.log('PASS old NT8 archive migration, dual-source persistence, metadata retention and offline reload');

sources.nt8 = { provider: 'nt8', connected: true, historyWindowVersion: 1 };
sources.atas = { provider: 'atas', connected: true, historyWindowVersion: 1 };
const replayStore = load('lib/replayStore.ts');
const input = { name: 'Saved source', symbol: 'ES', startTime: 1700000000, initialEquity: 25000 };
const nt8Session = replayStore.createReplaySession(input);
const atasSession = replayStore.createReplaySession({ ...input, provider: 'atas' });
replayStore.saveReplaySession(nt8Session);
replayStore.saveReplaySession(atasSession);
const legacySession = JSON.parse(storage.get(replayStore.REPLAY_SESSION_PREFIX + nt8Session.id));
delete legacySession.provider;
storage.set(replayStore.REPLAY_SESSION_PREFIX + nt8Session.id, JSON.stringify(legacySession));
cache.delete(path.resolve('app/src/lib/replayStore.ts'));
config.setProvider('atas');
const restoredSessions = load('lib/replayStore.ts').loadReplaySessions().sessions;
assert.equal(restoredSessions.length, 2, 'both providers use the same session dashboard and storage prefix');
assert.equal(restoredSessions.find(session => session.id === nt8Session.id).provider, 'nt8', 'legacy sessions retain their original NT8 source');
assert.equal(restoredSessions.find(session => session.id === atasSession.id).provider, 'atas');
const { loadReplayFeed } = load('lib/replayFeed.ts');
const ReplaySession = load('lib/replaySession.ts').ReplaySession;
for (const record of restoredSessions) {
  config.setProvider(record.provider === 'nt8' ? 'atas' : 'nt8');
  calls.length = 0;
  const { adapter, info } = await loadReplayFeed(record);
  const replay = new ReplaySession(adapter, record.cursor);
  await replay.getHistory(record.symbol, 60, 60, 120);
  assert.equal(info.exchange, record.provider === 'nt8' ? 'NT8' : 'ATAS');
  assert.equal(replay.exchange, info.exchange);
  assert.ok(calls.length >= 3 && calls.every(call => call.provider === record.provider));
  assert.ok(calls.every(call => call.payload === null), 'restoring replay cannot submit any live mutation');
}
sources.nt8 = null;
await assert.rejects(() => loadReplayFeed(nt8Session), /NT8/, 'an offline original source must not silently borrow the currently selected ATAS feed');
console.log('PASS session source persistence, legacy NT8 migration, combined dashboard and cross-source replay restoration');

const { TvDatafeed } = load('lib/tvDatafeed.ts');
const atasDatafeed = new TvDatafeed(feed.createNt8Adapter(sources.atas, 'atas'));
const resolved = await new Promise((resolve, reject) => atasDatafeed.resolveSymbol('ES', resolve, reject));
assert.equal(resolved.exchange, 'ATAS'); assert.equal(resolved.listed_exchange, 'ATAS');
const settings = await new Promise(resolve => atasDatafeed.onReady(resolve));
assert.equal(settings.exchanges[0].value, 'ATAS');
sources.atas.exchange = 'CME';
const cmeDatafeed = new TvDatafeed(feed.createNt8Adapter(sources.atas, 'atas'));
const cme = await new Promise((resolve, reject) => cmeDatafeed.resolveSymbol('ES', resolve, reject));
assert.equal(cme.exchange, 'CME'); assert.equal(cme.listed_exchange, 'CME');
console.log('PASS ATAS chart exchange labels and upstream exchange metadata are preserved');
