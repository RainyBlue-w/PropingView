import fs from 'node:fs';
import assert from 'node:assert/strict';
import ts from '../app/node_modules/typescript/lib/typescript.js';

// Exercise the actual stores and chart mount/cleanup effects with a minimal widget.
// Browser regression separately verifies rendering with the shipped chart library.
const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
};
globalThis.window = {};

function compile(filename, imports = {}) {
  const result = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputText)(name => {
    assert.ok(name in imports, `unexpected import: ${name}`);
    return imports[name];
  }, module, module.exports);
  return module.exports;
}

const layouts = compile('app/src/lib/tvLayoutStore.ts');
const events = compile('app/src/lib/tvLayoutEvents.ts');
const { TvDatafeed } = compile('app/src/lib/tvDatafeed.ts', {
  './symbolSearch': compile('app/src/lib/symbolSearch.ts'),
});
const LEGACY = 'nt8-terminal-tv-layout';
const PRIMARY = 'nt8-terminal-tv-layouts-v2';
const state = symbol => ({ charts: [{ panes: [{ sources: [{ type: 'MainSeries', state: { symbol, interval: '5' } }] }] }] });
const record = (name, symbol, timestamp = 100) => ({ name, symbol, resolution: '5', timestamp, content: JSON.stringify(state(symbol)) });

storage.set(LEGACY, JSON.stringify(state('NQ SEP26')));
assert.equal(layouts.hasSavedLayout('pane-2'), false);
assert.equal(layouts.getLastSavedLayout('pane-2'), null);
assert.equal(storage.has(PRIMARY), false, 'an extra pane cannot trigger primary legacy migration');
const legacy = layouts.getLastSavedLayout();
assert.equal(legacy.symbol, 'NQ SEP26');
const primaryBytes = storage.get(PRIMARY);
const scope = 'pane-2';
const scoped = layouts.createLayoutAdapter({ scope });
const b = await scoped.saveChart(record('ES layout', 'ES SEP26'));
const c = await scoped.saveChart(record('YM layout', 'YM SEP26', 200));
assert.equal(storage.get(PRIMARY), primaryBytes);
assert.equal(layouts.getLastSavedLayout(scope).id, c);
layouts.rememberLayout(b, scope);
assert.equal(layouts.getLastSavedLayout(scope).id, b);
assert.equal(layouts.getLastSavedLayout().id, legacy.id);
assert.equal(layouts.getLastSavedLayout('pane-3'), null);
await assert.rejects(scoped.getChartContent(legacy.id));
await assert.rejects(scoped.saveChart({ ...record('Foreign update', 'NQ SEP26'), id: legacy.id }));
await assert.rejects(layouts.createLayoutAdapter().removeChart(b));
await scoped.removeChart(c);
assert.equal(storage.get(PRIMARY), primaryBytes);
const other = layouts.createLayoutAdapter({ scope: 'pane/2' });
await other.saveChart(record('Other scope', 'CL OCT26'));
assert.equal(layouts.getLastSavedLayout('pane%2F2'), null, 'scope key escaping cannot alias another scope');
storage.set(PRIMARY, '{corrupt');
assert.equal(layouts.getLastSavedLayout(scope).id, b, 'corrupt primary storage cannot block another pane');
assert.throws(() => layouts.getLastSavedLayout());
storage.set(PRIMARY, primaryBytes);
console.log('PASS independent layout libraries, legacy migration, scoped load/remember/update/delete, corrupt-store isolation');

let rendering;
const react = {
  useRef: value => ({ current: rendering.refCount++ === 0 ? {} : value }),
  useState: value => [value, next => rendering?.errors.push(next)],
  useEffect: callback => rendering.effects.push(callback),
};
const component = compile('app/src/components/TvAdvancedChart.tsx', {
  react,
  'react/jsx-runtime': { jsx: () => null, jsxs: () => null },
  '@/lib/tvLayoutStore': layouts,
  '@/lib/tvLayoutEvents': events,
}).default;
const widgets = [];
class Widget {
  constructor(options) {
    this.options = options;
    this.events = new Map();
    this.removed = false;
    widgets.push(this);
  }
  subscribe(name, callback) { this.events.set(name, [...this.events.get(name) ?? [], callback]); }
  emit(name) { for (const callback of this.events.get(name) ?? []) callback(); }
  onChartReady(callback) { this.ready = callback; }
  activeChart() {
    const subscription = () => ({ subscribe() {}, unsubscribe() {} });
    return { onSymbolChanged: subscription, onIntervalChanged: subscription, onChartTypeChanged: subscription };
  }
  saveChartToServer() { throw new Error('unexpected automatic save'); }
  remove() { this.removed = true; }
}
window.TradingView = { widget: Widget };
const streams = new Map();
let serial = 0;
const symbols = ['NQ SEP26', 'ES SEP26'].map(symbol => ({ symbol, name: symbol, tickSize: 0.25 }));
const adapter = {
  async getSymbols() { return symbols; },
  async getHistory() { return [{ time: 900, open: 10, high: 12, low: 9, close: 11, volume: 1 }]; },
  subscribe(symbol, interval, callback) {
    const id = ++serial;
    streams.set(id, { symbol, interval, callback });
    return () => streams.delete(id);
  },
};
const datafeed = new TvDatafeed(adapter);
// Also cover forwarding a future optional public method without losing its receiver.
datafeed.getServerTime = function (callback) { assert.equal(this, datafeed); callback(123); };
function mount(props = {}) {
  const frame = { refCount: 0, effects: [], errors: [] };
  rendering = frame;
  component({ datafeed, symbol: 'NQ SEP26', initialInterval: '1', theme: 'dark', ...props });
  const cleanups = frame.effects.map(effect => effect());
  rendering = undefined;
  return { widget: widgets.at(-1), unmount: () => cleanups.forEach(cleanup => cleanup?.()) };
}
const primary = mount();
// ChartTerminal owns the active debug reference; individual chart mounts preserve it.
window.__lastWidget = primary.widget;
const pane = mount({ symbol: 'ES SEP26', layoutScope: scope });
primary.widget.ready();
pane.widget.ready();
assert.equal(window.__lastWidget, primary.widget, 'background panes must not replace the active debug widget');
assert.equal(primary.widget.options.saved_data.extendedData.id, legacy.id);
assert.equal(pane.widget.options.saved_data.extendedData.id, b);
assert.deepEqual((await pane.widget.options.save_load_adapter.getAllCharts()).map(row => row.id), [b]);
const feedA = primary.widget.options.datafeed;
const feedB = pane.widget.options.datafeed;
assert.equal((await new Promise(resolve => feedB.onReady(resolve))).supports_search, true);
assert.equal((await new Promise(resolve => feedB.searchSymbols('ES', '', '', resolve)))[0].symbol, 'ES SEP26');
const symbolInfo = await new Promise((resolve, reject) => feedB.resolveSymbol('NQ SEP26', resolve, reject));
assert.equal(symbolInfo.ticker, 'NQ SEP26');
assert.equal((await new Promise((resolve, reject) => feedB.getBars(symbolInfo, '1', { from: 0, to: 1000 }, resolve, reject)))[0].close, 11);
assert.equal(await new Promise(resolve => feedB.getServerTime(resolve)), 123);
let ticksA = 0;
let ticksB = 0;
feedA.subscribeBars(symbolInfo, '1', () => ticksA++, 'same-symbol-1');
feedB.subscribeBars(symbolInfo, '1', () => ticksB++, 'same-symbol-1');
assert.equal(streams.size, 2);
const emit = time => { for (const stream of streams.values()) stream.callback({ time, open: 11, high: 12, low: 10, close: 12, volume: 1 }); };
emit(960);
assert.deepEqual([ticksA, ticksB], [1, 1]);
feedA.unsubscribeBars('same-symbol-1');
assert.equal(streams.size, 1);
emit(1020);
assert.deepEqual([ticksA, ticksB], [1, 2]);
feedA.subscribeBars(symbolInfo, '1', () => ticksA++, 'same-symbol-1');
feedA.subscribeBars(symbolInfo, '5', () => ticksA++, 'another-series');
assert.equal(streams.size, 3);
let removalProtected = false;
events.onBeforeLayoutLoad(primary.widget, () => {
  assert.equal(primary.widget.removed, false, 'trade lines are protected before removing widget entities');
  removalProtected = true;
});
primary.unmount();
assert.equal(removalProtected, true);
assert.equal(streams.size, 1, 'cleanup unsubscribes every owned series even if widget.remove does not');
feedA.subscribeBars(symbolInfo, '1', () => ticksA++, 'late-subscribe');
assert.equal(streams.size, 1, 'late calls from a removed widget cannot recreate a subscription');
emit(1080);
assert.equal(ticksB, 3);
pane.unmount();
assert.equal(streams.size, 0);
const beforeReplay = [...storage];
const replay = mount({ persistLayout: false, layoutScope: scope });
replay.widget.ready();
assert.equal(replay.widget.options.saved_data, undefined);
assert.equal(replay.widget.options.save_load_adapter, undefined);
replay.widget.emit('onAutoSaveNeeded');
replay.unmount();
assert.deepEqual([...storage], beforeReplay, 'replay neither loads nor changes live chart layouts');
console.log('PASS widget scope restore, shared methods, simultaneous same-GUID subscriptions, single-pane removal, late subscribe and replay isolation');
