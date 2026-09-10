// Load an actual v29 saved layout into v32, then save and reload it.
// Uses an isolated Edge profile and blocks every bridge mutation at the CDP layer.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const root = path.resolve('app/dist');
const output = path.resolve('.tmp-webbridge');
const profile = path.join(output, `layout-upgrade-profile-${process.pid}-${Date.now()}`);
const fixture = JSON.parse(fs.readFileSync('scripts/fixtures/layout-v29.json', 'utf8'));
const originalId = fixture.lastOpenedId;
const storageKey = 'nt8-terminal-tv-layouts-v2';
const missingAssets = [];
const bridgeMutations = [];
const bridgeErrors = [];
const errors = [];
fs.mkdirSync(profile, { recursive: true });
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://local').pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (pathname.includes('/charting_library/')) missingAssets.push(pathname);
    res.writeHead(404).end();
    return;
  }
  const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1500,950', 'about:blank',
], { stdio: 'ignore', windowsHide: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws;

function bridgeFixture(url) {
  const q = url.searchParams;
  const sym = { symbol: 'NQ SEP26', name: 'E-mini Nasdaq', tickSize: 0.25, pointValue: 20, type: 'futures' };
  switch (url.pathname) {
    case '/api/status': return { connected: true, connectionName: 'Layout test', historyWindowVersion: 1, executionArchiveVersion: 1 };
    case '/api/symbols': return { symbols: [sym] };
    case '/api/resolve': return sym;
    case '/api/accounts': return { accounts: [{ name: 'Sim101', connection: 'Simulation', currency: 'USD', cashValue: 100000, netLiquidation: 100000, realizedPnl: 0, unrealizedPnl: 0 }] };
    case '/api/positions': return { positions: [] };
    case '/api/orders': return { orders: [] };
    case '/api/brackets': return { brackets: [] };
    case '/api/executions': return { executions: [], total: 0, nextOffset: null, archive: { version: 1, state: 'ready', recordCount: 0, pendingCount: 0 } };
    case '/api/history': {
      const from = Number(q.get('from'));
      const to = Math.min(Number(q.get('to')), Date.now() / 1000);
      const step = Number(q.get('interval')) || 60;
      const bars = [];
      for (let t = Math.ceil(Math.max(from, to - 86400 * 10) / step) * step; t <= to; t += step) {
        const price = 24000 + Math.sin(t / 600) * 15;
        bars.push({ time: t, open: price - 1, high: price + 3, low: price - 3, close: price, volume: 100 });
      }
      return { bars };
    }
    default: throw new Error(`Unexpected bridge endpoint: ${url.pathname}`);
  }
}

try {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const debugPort = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
      target = (await fetch(`http://127.0.0.1:${debugPort}/json`).then(response => response.json())).find(page => page.type === 'page');
    } catch { /* Edge is still starting. */ }
    if (!target) await pause(100);
  }
  assert.ok(target, 'Edge debugging endpoint');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => { ws.onopen = resolve; });
  let sequence = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const respondToBridge = async ({ requestId, request }) => {
    if (request.method !== 'GET') {
      bridgeMutations.push({ method: request.method, url: request.url });
      await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      return;
    }
    try {
      const body = JSON.stringify(bridgeFixture(new URL(request.url)));
      await send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
        body: Buffer.from(body).toString('base64'),
      });
    } catch (error) {
      bridgeErrors.push(error.message);
      await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    }
  };
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Fetch.requestPaused') void respondToBridge(message.params).catch(error => bridgeErrors.push(error.message));
    if (pending.has(message.id)) {
      const task = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(task.timer);
      if (message.error) task.reject(new Error(JSON.stringify(message.error)));
      else task.resolve(message.result);
    }
  };
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const shot = async name => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const until = async (expression, label) => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(`(()=>{try{return (${expression})}catch{return false}})()`)) return;
      await pause(200);
    }
    await shot('layout-upgrade-failure');
    console.log({ errors, missingAssets, bridgeErrors, bridgeMutations });
    throw new Error(`Timed out: ${label}`);
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*://*:8090/*', requestStage: 'Request' }] });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    if (location.origin === ${JSON.stringify(origin)} && window === window.top) {
      if (sessionStorage.getItem('layout-upgrade-seeded') !== '1') {
        localStorage.setItem(${JSON.stringify(storageKey)}, ${JSON.stringify(JSON.stringify(fixture))});
        localStorage.setItem('nt8-terminal-symbol', 'NQ SEP26');
        localStorage.setItem('nt8-terminal-interval', '1');
        localStorage.setItem('nt8-terminal-show-trades', '0');
        sessionStorage.setItem('layout-upgrade-seeded', '1');
      }
      window.EventSource = class { constructor() { setTimeout(() => this.onopen?.(), 0); } close() {} };
    }
  ` });
  await send('Page.navigate', { url: origin + '/' });

  const chart = 'window.__lastWidget.activeChart()';
  const chartState = 'new Promise(resolve => window.__lastWidget.save(resolve))';
  const store = `JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}))`;
  const drawing = `(${chart}.getAllShapes().map(shape=>({id:shape.id,points:${chart}.getShapeById(shape.id).getPoints(),properties:${chart}.getShapeById(shape.id).getProperties()})).find(shape=>shape.properties.text==='Layout v29 drawing'))`;
  const ready = async () => {
    await until(`!!window.__lastWidget && !!${drawing}`, 'old layout restored');
    // v32's no-callback overload returns a Promise, unlike the older boolean API.
    await evaluate(`${chart}.dataReady()`);
    await until(`${chart}.getAllStudies().length === 2`, 'two original studies restored');
  };
  const assertRestored = async lineWidth => {
    await ready();
    const runtimeVersion = await evaluate('window.TradingView.version()');
    assert.match(runtimeVersion, /^CL v32\.1\.0\b/, 'actual runtime is Charting Library v32.1.0');
    assert.equal(await evaluate(`${chart}.symbol()`), 'NQ SEP26', 'old layout symbol');
    assert.equal(await evaluate(`${chart}.resolution()`), '5', 'old layout period overrides one-minute UI cache');
    const state = await evaluate(chartState);
    assert.equal(state.name, 'Layout v29', 'old layout name');
    const sources = state.charts[0].panes.flatMap(pane => pane.sources);
    const main = sources.find(source => source.type === 'MainSeries');
    const studies = sources.filter(source => source.metaInfo);
    const rsi = studies.find(source => source.metaInfo.description === 'Relative Strength Index');
    assert.equal(studies.length, 2, 'only the original Volume and RSI studies, with no extra default indicator');
    assert.equal(studies.filter(source => source.metaInfo.description === 'Volume').length, 1, 'Volume is not duplicated');
    assert.equal(studies.filter(source => source.metaInfo.description === 'Relative Strength Index').length, 1, 'RSI is not duplicated');
    assert.equal(rsi?.state.inputs.length, 9, 'old RSI length');
    assert.equal(main.state.candleStyle.upColor, '#ff00aa', 'old custom candle color');
    assert.equal(state.charts[0].chartProperties.paneProperties.background, '#172333', 'old custom background');
    const line = await evaluate(drawing);
    assert.equal(line.points[0].price, 24020, 'old horizontal line price');
    assert.equal(line.properties.linewidth, lineWidth, 'horizontal line width');
    const layouts = await evaluate(store);
    assert.equal(layouts.charts.length, 1, 'upgrade retains one layout');
    assert.equal(layouts.lastOpenedId, originalId, 'old layout identity retained');
    assert.equal(layouts.charts[0].name, 'Layout v29', 'old saved layout name retained');
    return { runtimeVersion, line };
  };
  const { runtimeVersion, line } = await assertRestored(2);
  await shot('layout-v29-loaded-in-v32');
  await evaluate(`${chart}.getShapeById(${JSON.stringify(line.id)}).setProperties({linewidth:3})`);
  await evaluate('new Promise((resolve,reject) => window.__lastWidget.saveChartToServer(resolve,reject))');
  const saved = await evaluate(store);
  assert.notEqual(saved.charts[0].content, fixture.charts[0].content, 'saving writes the upgraded chart state');
  await send('Page.reload');
  await assertRestored(3);
  await shot('layout-v29-resaved-in-v32');
  assert.deepEqual(bridgeMutations, [], 'layout upgrade never attempts a bridge mutation');
  assert.deepEqual(bridgeErrors, [], 'all bridge reads are simulated');
  assert.deepEqual(missingAssets, [], 'no missing charting library assets');
  assert.deepEqual(errors, [], 'no browser runtime exceptions');
  console.log(`PASS ${runtimeVersion}: v29 layout name/id/symbol/5m, RSI length 9, custom candle/background colors, horizontal drawing; save/reload persistence; no duplicate studies, missing assets, or bridge mutations.`);
} finally {
  ws?.close();
  edge.kill();
  server.close();
}
