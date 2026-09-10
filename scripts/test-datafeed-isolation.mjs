import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from '../app/node_modules/typescript/lib/typescript.js';

const output = path.resolve('.tmp-webbridge/datafeed-isolation-unit');
fs.mkdirSync(output, { recursive: true });
for (const name of ['tvDatafeed', 'simTrading']) {
  const source = fs.readFileSync(`app/src/lib/${name}.ts`, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  fs.writeFileSync(path.join(output, `${name}.mjs`), compiled);
}
const { TvDatafeed } = await import(pathToFileURL(path.join(output, 'tvDatafeed.mjs')));
const { SimTrading, SIM_ACCOUNT } = await import(pathToFileURL(path.join(output, 'simTrading.mjs')));

const symbol = { symbol: 'TEST', name: 'Test future', tickSize: 0.25, pointValue: 10 };
const bar = (time, close) => ({ time, open: close, high: close, low: close, close, volume: 1 });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const adapter = (extra = {}) => ({
  getSymbols: async () => [symbol],
  getHistory: async () => [bar(600, 101)],
  subscribe: () => () => {},
  ...extra,
});
const requestBars = (feed, from = 0, to = 720) => {
  const results = [], errors = [];
  const done = feed.getBars({ ticker: symbol.symbol }, '1', { from, to },
    (bars, meta) => results.push({ bars, meta }), error => errors.push(error));
  return { done, results, errors };
};
const assertCancelled = (request) => {
  assert.deepEqual(request.results, []);
  assert.equal(request.errors.length, 1);
  assert.match(request.errors[0], /数据源已切换/);
};
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await test('delayed live history cannot overwrite replay prices or simulation fills', async () => {
  const liveHistory = deferred();
  const feed = new TvDatafeed(adapter({ getHistory: () => liveHistory.promise }));
  const live = requestBars(feed, 1500, 1900);
  let replayTick;
  feed.setAdapter(adapter({ getCursor: () => 660, subscribe: (_symbol, _interval, callback) => {
    replayTick = callback;
    return () => {};
  } }));
  const replay = requestBars(feed);
  await replay.done;
  assert.equal(replay.results[0].bars[0].close, 101);
  liveHistory.resolve([bar(1800, 25000)]);
  await live.done;
  assertCancelled(live);
  assert.equal(feed.getLastPrice('TEST'), 101);

  const sim = new SimTrading({ getLastPrice: name => feed.getLastPrice(name), pointValueOf: () => 10, getCursorTime: () => 660 });
  await sim.placeOrder({ account: SIM_ACCOUNT, symbol: 'TEST', action: 'BUY', quantity: 1, orderType: 'MARKET' });
  assert.equal(sim.exportState().executions[0].price, 101);
  const ticks = [];
  feed.subscribeBars({ ticker: 'TEST' }, '1', tick => ticks.push(tick), 'replay');
  replayTick(bar(660, 102));
  assert.equal(ticks.length, 1, 'old live timestamps must not reject earlier replay bars');
  assert.equal(feed.getLastPrice('TEST'), 102);
});

await test('live empty-page probe settles as cancelled after switching to replay', async () => {
  const probe = deferred(), started = deferred();
  let calls = 0;
  const feed = new TvDatafeed(adapter({ getHistory: async () => {
    if (++calls === 1) return [];
    started.resolve();
    return probe.promise;
  } }));
  const live = requestBars(feed, 1500, 1900);
  await started.promise;
  feed.setAdapter(adapter({ getCursor: () => 660 }));
  await requestBars(feed).done;
  probe.resolve([bar(1200, 20000)]);
  await live.done;
  assertCancelled(live);
  assert.equal(feed.getLastPrice('TEST'), 101);
});

await test('replay empty-page probe cannot deliver old nextTime after returning live', async () => {
  const probe = deferred(), started = deferred();
  let calls = 0;
  const feed = new TvDatafeed(adapter({ getCursor: () => 660, getHistory: async () => {
    if (++calls === 1) return [];
    started.resolve();
    return probe.promise;
  } }));
  const replay = requestBars(feed, 700, 800);
  await started.promise;
  feed.setAdapter(adapter({ getHistory: async () => [bar(1800, 25000)] }));
  await requestBars(feed, 1500, 1900).done;
  probe.resolve([bar(600, 101)]);
  await replay.done;
  assertCancelled(replay);
  assert.equal(feed.getLastPrice('TEST'), 25000);
});

await test('generation rejects an old request even when the same adapter is restored', async () => {
  const pending = deferred();
  let calls = 0;
  const live = adapter({ getHistory: async () => ++calls === 1 ? pending.promise : [bar(1800, 25001)] });
  const feed = new TvDatafeed(live);
  const old = requestBars(feed, 1500, 1900);
  feed.setAdapter(adapter());
  feed.setAdapter(live);
  await requestBars(feed, 1500, 1900).done;
  pending.resolve([bar(1800, 24000)]);
  await old.done;
  assertCancelled(old);
  assert.equal(feed.getLastPrice('TEST'), 25001);
});

await test('old subscription frames cannot emit during teardown or after adapter switch', async () => {
  let oldTick, newTick, unsubscribed = 0;
  const feed = new TvDatafeed(adapter({ subscribe: (_symbol, _interval, callback) => {
    oldTick = callback;
    return () => { unsubscribed++; callback(bar(1900, 26000)); };
  } }));
  const oldTicks = [], newTicks = [], prices = [];
  feed.onPriceChange((name, price) => prices.push([name, price]));
  feed.subscribeBars({ ticker: 'TEST' }, '1', tick => oldTicks.push(tick), 'old');
  feed.setAdapter(adapter({ subscribe: (_symbol, _interval, callback) => {
    newTick = callback;
    return () => {};
  } }));
  await requestBars(feed).done;
  feed.subscribeBars({ ticker: 'TEST' }, '1', tick => newTicks.push(tick), 'new');
  oldTick(bar(1960, 26001));
  newTick(bar(660, 102));
  assert.equal(unsubscribed, 1);
  assert.deepEqual(oldTicks, []);
  assert.equal(newTicks.length, 1);
  assert.deepEqual(prices, [['TEST', 102]]);
  feed.unsubscribeBars('new');
  newTick(bar(720, 103));
  assert.equal(newTicks.length, 1);
  assert.equal(feed.getLastPrice('TEST'), 102);
});

await test('listSymbols retries current metadata after stale resolution or rejection', async () => {
  for (const reject of [false, true]) {
    const pending = deferred();
    const feed = new TvDatafeed(adapter({ getSymbols: () => pending.promise }));
    const result = feed.listSymbols();
    const current = { ...symbol, tickSize: 0.01, pointValue: 5 };
    feed.setAdapter(adapter({ getSymbols: async () => [current] }));
    if (reject) pending.reject(new Error('Old bridge offline'));
    else pending.resolve([symbol]);
    assert.deepEqual(await result, [current]);
  }
});

await test('symbol resolution and search finish without delivering stale metadata', async () => {
  const pendingResolve = deferred(), pendingSearch = deferred();
  const resolveStarted = deferred(), searchStarted = deferred();
  const feed = new TvDatafeed(adapter({ getSymbols: async () => [], resolve: async name => {
    if (name === 'TEST') { resolveStarted.resolve(); return pendingResolve.promise; }
    searchStarted.resolve();
    return pendingSearch.promise;
  } }));
  const resolutions = [], errors = [], searches = [];
  const resolution = feed.resolveSymbol('TEST', item => resolutions.push(item), error => errors.push(error));
  const search = feed.searchSymbols('OTHER', '', '', items => searches.push(items));
  await Promise.all([resolveStarted.promise, searchStarted.promise]);
  feed.setAdapter(adapter());
  pendingResolve.resolve(symbol);
  pendingSearch.resolve({ ...symbol, symbol: 'OTHER' });
  await Promise.all([resolution, search]);
  assert.deepEqual(resolutions, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /数据源已切换/);
  assert.deepEqual(searches, [[]]);
  await feed.resolveSymbol('TEST', item => resolutions.push(item), error => errors.push(error));
  assert.equal(resolutions.length, 1);
  assert.equal(resolutions[0].ticker, 'TEST');
});

console.log(`${passed} datafeed isolation scenarios passed`);
