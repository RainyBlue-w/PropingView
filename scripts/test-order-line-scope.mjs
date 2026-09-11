// Real hook code with isolated React/chart/timer fixtures. No browser, bridge or account connection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from '../app/node_modules/typescript/lib/typescript.js';

function compile(filename, imports = {}, globals = {}) {
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: name => {
    assert.ok(name in imports, `unexpected import ${name}`);
    return imports[name];
  }, console, ...globals, fetch: () => { throw new Error('Network access is forbidden in this fixture'); } });
  return exports;
}

// Keep render separate from passive-effect commit, so promises/events can arrive in between.
function hookRunner() {
  const slots = [], effects = new Map();
  let cursor = 0, pending = [], dirty = false, run;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const react = {
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => {
        const next = typeof value === 'function' ? value(slots[index]) : value;
        if (!Object.is(next, slots[index])) { slots[index] = next; dirty = true; }
      }];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) slots[index] = { deps, callback };
      return slots[index].callback;
    },
    useEffect(callback, deps) {
      const index = cursor++;
      if (!same(effects.get(index)?.deps, deps)) pending.push({ index, callback, deps });
    },
  };
  return {
    react,
    render(callback = run) { run = callback; cursor = 0; pending = []; dirty = false; run(); },
    commit() {
      const batch = pending; pending = [];
      // React runs all changed passive-effect cleanups before the new effect setups.
      for (const { index } of batch) effects.get(index)?.cleanup?.();
      for (const { index, callback, deps } of batch) effects.set(index, { deps, cleanup: callback() });
    },
    flushState() {
      for (let attempts = 0; dirty; attempts++) {
        assert.ok(attempts < 10, 'hook state updates must settle');
        this.render(); this.commit();
      }
    },
    dispose() { for (const effect of effects.values()) effect.cleanup?.(); effects.clear(); },
  };
}

const MONTH = 'MNQU6@CME#atas-id=ContractIdentifier(33268:)';
const CONTINUOUS = '#MNQU6@CME';
const microtasks = () => new Promise(resolve => setImmediate(resolve));

function fixture({ deferCreate = false } = {}) {
  const runner = hookRunner();
  const callbacks = new Map(), mouseCallbacks = new Set(), timers = new Map();
  const shapes = new Map(), creates = [], removes = [], requests = [];
  let shapeId = 0, timerId = 0, ready = true, readyCallbacks = [];
  const emit = (event, ...args) => { for (const callback of [...(callbacks.get(event) ?? [])]) callback(...args); };
  const chart = {
    currentSymbol: MONTH,
    symbol() { return this.currentSymbol; },
    createMultipointShape(points, options) {
      const id = `shape-${++shapeId}`;
      const request = { id, symbol: this.currentSymbol, points: structuredClone(points), options: structuredClone(options) };
      creates.push(request);
      const shape = {
        ...request,
        getPoints() { return this.points; },
        setPoints(value) { this.points = structuredClone(value); emit('drawing_event', id, 'points_changed'); },
        setProperties(value) { Object.assign(this.options.overrides, value); },
      };
      // Shapes belong to the symbol at creation. getShapeById can still find them after a switch.
      return new Promise(resolve => {
        request.release = () => { shapes.set(id, shape); resolve(id); };
        if (!deferCreate) request.release();
      });
    },
    getShapeById(id) { return shapes.get(id); },
    removeEntity(id) { removes.push(id); shapes.delete(id); emit('drawing_event', id, 'remove'); },
    dataReady(callback) { if (!ready) readyCallbacks.push(callback); return ready; },
  };
  const widget = {
    activeChart: () => chart,
    subscribe(event, callback) {
      if (!callbacks.has(event)) callbacks.set(event, new Set());
      callbacks.get(event).add(callback);
    },
    unsubscribe(event, callback) { callbacks.get(event)?.delete(callback); },
  };
  const window = {
    addEventListener(event, callback) { assert.equal(event, 'mouseup'); mouseCallbacks.add(callback); },
    removeEventListener(event, callback) { assert.equal(event, 'mouseup'); mouseCallbacks.delete(callback); },
  };
  const trading = {
    cancelOrder: async (...args) => { requests.push({ method: 'cancelOrder', args: structuredClone(args) }); },
    changeOrder: async (...args) => { requests.push({ method: 'changeOrder', args: structuredClone(args) }); },
  };
  const instrument = compile('app/src/lib/chartInstrument.ts');
  const layout = compile('app/src/lib/tvLayoutEvents.ts');
  const { useOrderLines } = compile('app/src/hooks/useOrderLines.ts', {
    react: runner.react,
    '@/lib/tradingRouter': { trading },
    '@/lib/chartInstrument': instrument,
    '@/lib/tvLayoutEvents': layout,
  }, {
    window,
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  let props = {
    widget, symbol: MONTH, account: 'Fixture-A',
    orders: [{ orderId: 'native-order', instrument: MONTH, chartSymbols: [MONTH, CONTINUOUS], action: 'Buy',
      orderType: 'Limit', limitPrice: 20000, stopPrice: 0, quantity: 1, filled: 0, state: 'Working', name: 'Entry' }],
    positions: [{ instrument: MONTH, chartSymbols: [MONTH, CONTINUOUS], quantity: 1, averagePrice: 19990, marketPosition: 'Long' }],
    brackets: [], tickSize: .25, pointValue: 2, theme: 'dark', epoch: 1,
    getLastPrice: () => 20000, subscribePrice: () => () => {}, onChanged: () => {},
  };
  const render = (patch = {}, commit = true) => {
    props = { ...props, ...patch }; chart.currentSymbol = props.symbol;
    runner.render(() => useOrderLines(props));
    if (commit) runner.commit();
  };
  const visible = () => [...shapes.values()].filter(shape => shape.symbol === chart.currentSymbol);
  return {
    chart, widget, shapes, creates, removes, requests, timers, render, emit, visible,
    commit: () => runner.commit(),
    settle: async () => { await microtasks(); runner.flushState(); await microtasks(); },
    releaseCreates(from = 0) { for (const create of creates.slice(from)) create.release(); },
    move(id, price) { shapes.get(id).points[0].price = price; emit('drawing_event', id, 'move'); },
    runTimers() { const batch = [...timers.values()]; timers.clear(); for (const callback of batch) callback(); },
    mouseUp() { for (const callback of [...mouseCallbacks]) callback(); },
    beginLayout() {
      ready = false; layout.notifyBeforeLayoutLoad(widget);
      emit('chart_load_requested'); emit('chart_loaded');
    },
    finishLayout() { ready = true; const batch = readyCallbacks; readyCallbacks = []; for (const callback of batch) callback(); },
    dispose() { runner.dispose(); },
  };
}

let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await test('fixture delivers ordinary user drag and removal to fake trading with native identifiers', async () => {
  const f = fixture();
  try {
    f.render(); await f.settle();
    assert.equal(f.visible().length, 2);
    const order = f.creates.find(create => create.options.lock === false);
    f.move(order.id, 20020); f.mouseUp(); await microtasks();
    assert.deepEqual(f.requests, [{ method: 'changeOrder', args: ['Fixture-A', 'native-order', { limitPrice: 20010 }] }]);
    f.emit('drawing_event', order.id, 'remove'); await microtasks();
    assert.deepEqual(f.requests.at(-1), { method: 'cancelOrder', args: ['Fixture-A', 'native-order'] });
  } finally { f.dispose(); }
});

for (const [scope, patch] of [['symbol', { symbol: CONTINUOUS }], ['account', { account: 'Fixture-B' }]]) {
  await test(`late order and position creation after ${scope} render is discarded before effects commit`, async () => {
    const f = fixture({ deferCreate: true });
    try {
      f.render();
      const old = f.creates.slice();
      assert.equal(old.length, 2, 'both order and position creation must be pending');
      f.render(patch, false);
      f.releaseCreates(); await microtasks();
      assert.equal(f.shapes.size, 0, 'rendered scope alone must invalidate old asynchronous results');
      assert.deepEqual(f.removes, old.map(create => create.id));
      assert.equal(f.requests.length, 0);
      f.commit(); f.releaseCreates(old.length); await f.settle();
      assert.equal(f.visible().length, 2, 'the new scope recreates both lines');
      assert.equal(f.requests.length, 0);
    } finally { f.dispose(); }
  });
}

await test('old remove, drag timer and mouseup after account render cannot submit with the new account', async () => {
  const f = fixture();
  try {
    f.render(); await f.settle();
    const order = f.creates.find(create => create.options.lock === false);
    f.move(order.id, 20020);
    assert.equal(f.timers.size, 1, 'a real pending drag is scheduled');
    f.render({ account: 'Fixture-B' }, false);
    f.emit('drawing_event', order.id, 'remove'); f.runTimers(); f.mouseUp(); await microtasks();
    assert.equal(f.requests.length, 0, 'old events must be rejected before effect cleanup runs');
    f.commit(); await f.settle();
    assert.equal(f.timers.size, 0);
    assert.equal(f.visible().length, 2);
    assert.equal(f.requests.length, 0, 'programmatic cleanup must not cancel the old native order');
  } finally { f.dispose(); }
});

await test('account and symbol changes during layout dataReady wait still resume managed drawing', async () => {
  const f = fixture();
  try {
    f.render(); await f.settle();
    f.beginLayout();
    assert.equal(f.shapes.size, 0);
    const before = f.creates.length;
    f.render({ account: 'Fixture-B' });
    f.render({ symbol: CONTINUOUS });
    await f.settle();
    assert.equal(f.creates.length, before, 'loading blocks drawing until native dataReady');
    f.finishLayout(); await f.settle();
    assert.equal(f.visible().length, 2, 'layout resumes in the latest account and symbol scope');
    assert.equal(f.requests.length, 0);
  } finally { f.dispose(); }
});

await test('switching back to the previous symbol recreates drawings despite retained old shape handles', async () => {
  const f = fixture();
  try {
    f.render(); await f.settle();
    const initial = f.visible().map(shape => shape.id);
    f.render({ symbol: CONTINUOUS }); await f.settle();
    assert.equal(f.visible().length, 2);
    f.render({ symbol: MONTH }); await f.settle();
    assert.equal(f.visible().length, 2);
    assert.ok(f.visible().every(shape => !initial.includes(shape.id)));
    assert.equal(f.shapes.size, 2);
    assert.equal(f.requests.length, 0);
  } finally { f.dispose(); }
});

console.log(`${passed} order-line lifecycle checks passed (actual hook, fake chart and trading only).`);
