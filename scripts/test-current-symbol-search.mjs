// Every request is intercepted in this VM; no installed bridge or trading account is contacted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from '../app/node_modules/typescript/lib/typescript.js';

const current = { symbol: 'NQ SEP26', name: 'E-mini NASDAQ', type: 'futures', tickSize: 0.25 };
const future = { ...current, symbol: 'NQ DEC26' };
const past = { ...current, symbol: 'NQ JUN26' };
const forex = { symbol: 'EURUSD', name: 'Euro FX', type: 'forex' };
const atas = { symbol: 'NQU6@CME', name: 'NASDAQ September 2026', type: 'futures' };
const atasFar = { ...atas, symbol: 'NQZ6@CME', name: 'NASDAQ December 2026' };
const calls = [];
let oldBridge = false;
const storage = new Map();
const context = vm.createContext({ URL, URLSearchParams, AbortController, setTimeout, clearTimeout, console,
  window: { location: new URL('https://terminal.example/') },
  localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  fetch: async url => {
    const address = new URL(url);
    assert.equal(address.origin, 'https://terminal.example', 'all requests must stay inside the mock');
    const provider = address.pathname.startsWith('/atas/') ? 'atas' : 'nt8';
    const endpoint = address.pathname.replace(/^\/atas/, '');
    const searchOnly = address.searchParams.get('currentOnly') === 'true';
    const requested = address.searchParams.get('symbol');
    calls.push({ provider, endpoint, searchOnly, requested });
    const catalog = provider === 'nt8' ? [current, future, forex] : [atas, atasFar];
    if (provider === 'atas') assert.equal(searchOnly, false, 'NT8 current-month policy must not alter ATAS requests');
    let data;
    let status = 200;
    if (endpoint === '/api/symbols') data = { symbols: searchOnly && !oldBridge ? [current, forex] : catalog,
      ...(searchOnly && !oldBridge ? { currentOnly: true, symbolCatalogVersion: 2 } : {}) };
    else if (endpoint === '/api/resolve') {
      const match = [...catalog, ...(provider === 'nt8' ? [past] : [])].find(row => row.symbol === requested);
      if (!match || (searchOnly && !oldBridge && match !== current && match !== forex)) status = 404;
      else data = { ...match, ...(searchOnly && !oldBridge ? { currentOnly: true } : {}) };
    } else assert.fail(`Unmocked endpoint ${endpoint}`);
    return { ok: status === 200, status, json: async () => data };
  },
});
const cache = new Map();
function load(name) {
  const filename = path.resolve('app/src', name);
  if (cache.has(filename)) return cache.get(filename).exports;
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  cache.set(filename, module);
  const require = specifier => {
    assert.ok(specifier.startsWith('.') || specifier.startsWith('@/'), `unexpected package ${specifier}`);
    const target = specifier.startsWith('@/') ? path.resolve('app/src', specifier.slice(2)) : path.resolve(path.dirname(filename), specifier);
    return load(path.relative(path.resolve('app/src'), `${target}.ts`));
  };
  vm.runInContext(`(function(require,module,exports){${compiled}\n})`, context, { filename })(require, module, module.exports);
  return module.exports;
}
const { createNt8Adapter } = load('lib/nt8Bridge.ts');
const { TvDatafeed } = load('lib/tvDatafeed.ts');
const nt8 = createNt8Adapter({ provider: 'nt8', connected: true, symbolCatalogVersion: 2 });
const atasAdapter = createNt8Adapter({ provider: 'atas', connected: true });
const names = rows => Array.from(rows, row => row.symbol);
const builtInSearch = (feed, query) => new Promise(resolve => feed.searchSymbols(query, '', '', resolve));
const chartResolve = (feed, query) => new Promise((resolve, reject) => feed.resolveSymbol(query, resolve, reject));
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await test('NT8 search requests the verified current catalog while ordinary reads retain other expiries', async () => {
  assert.deepEqual(names(await nt8.getSearchSymbols()), [current.symbol, forex.symbol]);
  assert.equal(calls.at(-1).searchOnly, true);
  assert.deepEqual(names(await nt8.getSymbols()), [current.symbol, future.symbol, forex.symbol]);
  assert.equal(calls.at(-1).searchOnly, false);
});
await test('search-only resolution rejects far and past contracts while exact history resolution remains available', async () => {
  assert.equal((await nt8.searchResolve(current.symbol)).symbol, current.symbol);
  assert.equal(calls.at(-1).searchOnly, true);
  assert.equal((await nt8.searchResolve(forex.symbol)).symbol, forex.symbol);
  for (const row of [future, past]) {
    assert.equal(await nt8.searchResolve(row.symbol), null);
    assert.equal((await nt8.resolve(row.symbol)).symbol, row.symbol);
    assert.equal(calls.at(-1).searchOnly, false);
  }
});
await test('both TradingView search entry points use current policy and cannot fall back to unrestricted resolve', async () => {
  const feed = new TvDatafeed(nt8);
  assert.deepEqual(names(await feed.listSymbols(true)), [current.symbol, forex.symbol]);
  assert.deepEqual(names(await feed.listSymbols()), [current.symbol, future.symbol, forex.symbol]);
  assert.equal(await feed.lookupSymbol(future.symbol), null);
  assert.equal(calls.at(-1).searchOnly, true);
  assert.deepEqual(names(await builtInSearch(feed, 'NQ')), [current.symbol]);
  assert.deepEqual(names(await builtInSearch(feed, 'NQ 09-26')), [current.symbol]);
  assert.deepEqual(names(await builtInSearch(feed, future.symbol)), []);
  assert.equal(calls.at(-1).searchOnly, true);
  assert.equal((await chartResolve(feed, past.symbol)).ticker, past.symbol);
  assert.equal(calls.at(-1).searchOnly, false, 'restored historical charts must resolve the exact contract');
});
await test('old bridges ignoring currentOnly fail closed despite a newer cached status', async () => {
  oldBridge = true;
  await assert.rejects(nt8.getSearchSymbols(), /请在 NT8 编译并重启新版数据桥，以启用主力合约搜索/);
  assert.equal(await nt8.searchResolve(future.symbol), null);
  const feed = new TvDatafeed(nt8);
  assert.equal(await feed.lookupSymbol(future.symbol), null);
  const before = calls.length;
  assert.deepEqual(names(await builtInSearch(feed, future.symbol)), []);
  assert.equal(calls.length, before + 1, 'failed catalog validation must not invoke any fallback resolve');
  assert.equal((await chartResolve(feed, past.symbol)).ticker, past.symbol);
  oldBridge = false;
});
await test('ATAS search and exact resolution remain unrestricted and receive no currentOnly flag', async () => {
  const feed = new TvDatafeed(atasAdapter);
  assert.deepEqual(names(await feed.listSymbols(true)), [atas.symbol, atasFar.symbol]);
  assert.deepEqual(names(await builtInSearch(feed, 'NQ')), [atas.symbol, atasFar.symbol]);
  assert.equal((await feed.lookupSymbol(atasFar.symbol)).symbol, atasFar.symbol);
  assert.equal((await chartResolve(feed, atasFar.symbol)).ticker, atasFar.symbol);
  assert.ok(calls.filter(call => call.provider === 'atas').every(call => !call.searchOnly));
});
await test('adapters without search-specific methods keep their existing search behavior', async () => {
  const adapter = { getSymbols: async () => [current], resolve: async symbol => symbol === future.symbol ? future : null,
    subscribe: () => () => {}, getHistory: async () => [] };
  const feed = new TvDatafeed(adapter);
  assert.deepEqual(names(await feed.listSymbols(true)), [current.symbol]);
  assert.equal(await feed.lookupSymbol(future.symbol), future);
  assert.deepEqual(names(await builtInSearch(feed, future.symbol)), [future.symbol]);
});
await test('pending search catalog and lookup responses cannot cross an adapter switch', async () => {
  let releaseCatalog, releaseResolve;
  const stale = { getSymbols: async () => [future],
    getSearchSymbols: () => new Promise(resolve => { releaseCatalog = resolve; }),
    searchResolve: () => new Promise(resolve => { releaseResolve = resolve; }),
    subscribe: () => () => {}, getHistory: async () => [] };
  const feed = new TvDatafeed(stale);
  const pendingCatalog = feed.listSymbols(true);
  const pendingResolve = feed.lookupSymbol(future.symbol);
  feed.setAdapter(atasAdapter);
  releaseCatalog([future]);
  releaseResolve(future);
  assert.deepEqual(names(await pendingCatalog), [atas.symbol, atasFar.symbol]);
  assert.equal(await pendingResolve, null);
});

console.log(`${passed} current-symbol-search checks passed.`);
