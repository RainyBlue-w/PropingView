// Real TradingView runtime; independent mock NT8 and ATAS endpoints on a random
// local port. No request, including the mocked order, can reach either real bridge.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve('app/dist');
const output = path.resolve('.tmp-webbridge');
fs.mkdirSync(output, { recursive: true });
const calls = [], orders = [], streams = new Set();
const accountSnapshots = [];
let omitAtasSim101 = false;
const online = { nt8: true, atas: true };
const symbols = { nt8: 'NQ SEP26', atas: '#MNQU6@CME' };
const atasPositionSymbol = 'MNQU6@CME#atas-id=ContractIdentifier(33268:)';
const atasUnrelatedSymbol = 'MNQU6@CME#atas-id=ContractIdentifier(99999:)';
const atasChartSymbols = [atasPositionSymbol, symbols.atas];
const atasCatalog = [
  { symbol: symbols.atas, name: 'Micro E-mini Nasdaq-100', exchange: 'CME_Ind', tickSize: .25, pointValue: 2, type: 'futures' },
  { symbol: atasPositionSymbol, name: 'Micro E-mini Nasdaq-100 September 2026', exchange: 'CME_Ind', tickSize: .25, pointValue: 2, type: 'futures' },
  { symbol: atasUnrelatedSymbol, name: 'Micro E-mini Nasdaq-100 September 2026 Delayed15M', exchange: 'CME_Delayed15M', tickSize: .25, pointValue: 2, type: 'futures' },
];
const nt8ContractMonths = ['NQ SEP26', 'NQ DEC26', 'NQ MAR27'];
let currentNt8Symbol = symbols.nt8;
const rawAccounts = { nt8: 'Sim101', atas: 'fixture-connector:Sim101' };
const safeAtasAccount = 'fixture-connector:Safe02';
const positions = {
  nt8: [{ instrument: symbols.nt8, quantity: 2, averagePrice: 24001.25, marketPosition: 'Long' }],
  atas: [{ instrument: atasPositionSymbol, chartSymbols: atasChartSymbols, quantity: 3, averagePrice: 25001.25, marketPosition: 'Long' }],
};
const atasWorkingOrder = { orderId: 'fixture-atas-limit', instrument: atasPositionSymbol, chartSymbols: atasChartSymbols,
  action: 'Buy', orderType: 'Limit', quantity: 1, filled: 0, limitPrice: 25004.75, stopPrice: 0,
  averageFillPrice: 0, state: 'Working', oco: '', name: 'TVEntry', time: Math.floor(Date.now() / 1000) };
let protectionError = null, rejectNextOrder = null, delayAtasBracket = false, delayedBracketReply = null;
const now = Math.floor(Date.now() / 60000) * 60;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const provider = url.pathname.startsWith('/atas/') ? 'atas' : 'nt8';
  const endpoint = provider === 'atas' ? url.pathname.slice(5) : url.pathname;
  if (endpoint.startsWith('/api/')) {
    calls.push({ provider, path: endpoint, method: req.method, query: Object.fromEntries(url.searchParams) });
    res.setHeader('Content-Type', 'application/json');
    if (req.method !== 'GET' && !(req.method === 'POST' && endpoint === '/api/order/place')) {
      res.writeHead(403).end('{"error":"Fixture forbids unexpected trading mutation"}'); return;
    }
    if (endpoint === '/api/status') {
      res.end(JSON.stringify({ provider, connected: online[provider], tradingSupported: true, historyWindowVersion: 1, executionArchiveVersion: 1,
        tradingError: provider === 'atas' ? protectionError : null,
        archive: { state: 'ready', version: 1, recordCount: 0, pendingCount: 0 } })); return;
    }
    if (!online[provider]) { res.writeHead(503).end(JSON.stringify({ error: `${provider} fixture offline` })); return; }
    if (endpoint === '/api/stream') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(': ready\n\n');
      streams.add(res);
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 1000);
      res.once('close', () => { clearInterval(timer); streams.delete(res); }); return;
    }
    const info = provider === 'atas' ? atasCatalog[0] : { symbol: symbols.nt8, name: 'Nasdaq September 2026 fixture', tickSize: .25, pointValue: 20, type: 'futures' };
    let data;
    switch (endpoint) {
      case '/api/accounts': {
        data = { accounts: [
        { name: rawAccounts[provider], displayName: 'Sim101', connection: 'Demo connection', currency: 'USD', cashValue: provider === 'nt8' ? 100000 : 50000, realizedPnl: 200, unrealizedPnl: 50 },
        ...(provider === 'atas' ? [{ name: safeAtasAccount, displayName: 'Safe02', connection: 'Demo connection', currency: 'USD', cashValue: 75000, realizedPnl: 0, unrealizedPnl: 0 }] : []),
        ].filter(account => !(provider === 'atas' && omitAtasSim101 && account.name === rawAccounts.atas)) };
        accountSnapshots.push({ provider, names: data.accounts.map(account => account.name) });
        break;
      }
      case '/api/symbols': {
        const currentOnly = provider === 'nt8' && url.searchParams.get('currentOnly') === 'true';
        data = provider === 'nt8'
          ? { symbols: (currentOnly ? [currentNt8Symbol] : nt8ContractMonths).map(symbol => ({ ...info, symbol, name: 'Nasdaq fixture' })), ...(currentOnly ? { currentOnly: true, symbolCatalogVersion: 2 } : {}) }
          : { symbols: atasCatalog };
        break;
      }
      case '/api/resolve': {
        const requested = url.searchParams.get('symbol');
        const currentOnly = provider === 'nt8' && url.searchParams.get('currentOnly') === 'true';
        const native = provider === 'nt8'
          ? ({ 'NQ': currentNt8Symbol, 'NQ 09-26': 'NQ SEP26', 'NQ 12-26': 'NQ DEC26', 'NQ 03-27': 'NQ MAR27' }[requested] || requested)
          : atasCatalog.find(s => s.symbol.toUpperCase() === requested?.toUpperCase())?.symbol || requested;
        if (!(provider === 'nt8' ? nt8ContractMonths.includes(native) : atasCatalog.some(s => s.symbol === native))
          || (currentOnly && native !== currentNt8Symbol)) { res.writeHead(404).end('{"error":"not a current catalog symbol"}'); return; }
        data = { ...(provider === 'atas' ? atasCatalog.find(s => s.symbol === native) : info), symbol: native, ...(currentOnly ? { currentOnly: true } : {}) }; break;
      }
      case '/api/history': {
        if (!(provider === 'nt8' ? nt8ContractMonths.includes(url.searchParams.get('symbol')) : atasCatalog.some(s => s.symbol === url.searchParams.get('symbol')))) { res.writeHead(404).end('{"error":"foreign history symbol"}'); return; }
        const step = Number(url.searchParams.get('interval')) || 60;
        const to = Math.min(now, Number(url.searchParams.get('to')));
        const from = Math.max(to - 864000, Number(url.searchParams.get('from')));
        const base = provider === 'nt8' ? 24000 : 25000;
        const bars = [];
        for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
          const price = base + Math.sin(t / 600) * 5;
          bars.push({ time: t, open: price, high: price + 2, low: price - 2, close: price + 1, volume: 10 });
        }
        data = { bars }; break;
      }
      case '/api/positions': data = { positions: url.searchParams.get('account') === rawAccounts[provider] ? positions[provider] : [] }; break;
      case '/api/orders': data = { orders: provider === 'atas' && url.searchParams.get('account') === rawAccounts.atas ? [atasWorkingOrder] : [] }; break;
      case '/api/brackets': {
        const syncError = provider === 'atas' && url.searchParams.get('account') === rawAccounts.atas ? protectionError : null;
        if (provider === 'atas' && url.searchParams.get('account') === rawAccounts.atas && delayAtasBracket) {
          delayAtasBracket = false;
          delayedBracketReply = () => res.end(JSON.stringify({ brackets: [], syncError }));
          return;
        }
        data = { brackets: [], syncError }; break;
      }
      case '/api/executions': data = { executions: [], total: 0, nextOffset: null, archive: { state: 'ready', recordCount: 0, pendingCount: 0 } }; break;
      case '/api/order/place': {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        orders.push({ provider, body: JSON.parse(Buffer.concat(chunks).toString()) });
        if (rejectNextOrder) {
          const reason = rejectNextOrder; rejectNextOrder = null;
          res.writeHead(409).end(JSON.stringify({ error: reason })); return;
        }
        data = { ok: true, orderId: 'mock-only' }; break;
      }
      default: res.writeHead(404).end('{"error":"Unexpected fixture endpoint"}'); return;
    }
    res.end(JSON.stringify(data)); return;
  }
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (req.method !== 'GET' || !file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const debugPort = 10900 + process.pid % 100;
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--window-size=1440,1000',
  `--user-data-dir=${path.join(output, `dual-bridge-profile-${Date.now()}`)}`, `--remote-debugging-port=${debugPort}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws;
try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await fetch(`http://127.0.0.1:${debugPort}/json`).then(r => r.json())).find(t => t.type === 'page'); } catch { /* startup */ }
    if (!target) await pause(200);
  }
  assert.ok(target, 'Edge debugging available');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => { ws.onopen = resolve; });
  let sequence = 0;
  const pending = new Map(), errors = [];
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const item = pending.get(message.id);
    if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(message.error) : item.resolve(message.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async name => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(data, 'base64'));
  };
  const until = async (expression, label) => {
    for (let i = 0; i < 120; i++) {
      if (await evaluate(`(()=>{try{return Boolean(${expression})}catch{return false}})()`)) return;
      await pause(200);
    }
    await shot('dual-bridge-failure');
    console.log(await evaluate('document.body.innerText.slice(-3000)'));
    console.log('Chart diagnostic:', await evaluate(`({symbol:window.__lastWidget?.activeChart().symbol(),prices:${JSON.stringify(atasCatalog.map(s => s.symbol))}.map(symbol=>({symbol,price:window.__tvDatafeed?.getLastPrice(symbol)}))})`));
    console.log('Position drawings:', await evaluate(`(()=>{try{return ${positionLines}}catch(e){return String(e)}})()`));
    console.log('Recent symbol requests:', calls.filter(c => c.path === '/api/resolve' || c.path === '/api/history').slice(-12));
    throw new Error('Timeout: ' + label);
  };
  const clickText = async (selector, text) => evaluate(`(()=>{const e=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw new Error('Missing button');e.click()})()`);
  const searchSymbol = async query => evaluate(`(()=>{const input=document.querySelector('input[aria-label="搜索合约"]');if(!input)throw new Error('Missing symbol search');input.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(query)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const closeSymbolSearch = async () => evaluate(`document.querySelector('input[aria-label="搜索合约"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  const pickSymbol = async symbol => {
    const selector = `[data-symbol-result="${symbol}"]`;
    await until(`document.querySelector(${JSON.stringify(selector)})`, 'canonical search result ' + symbol);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await until(`window.__lastWidget?.activeChart().symbol()===${JSON.stringify(symbol.toUpperCase())}&&!document.querySelector('[data-symbol-result]')`, 'search selection displays the selected canonical contract');
  };
  const chooseAccount = async (provider, name = 'Sim101') => {
    await evaluate(`document.querySelector('[aria-label="选择交易账户"]').click()`);
    await until(`document.querySelector('[aria-label="选择交易账户"]')?.getAttribute('aria-expanded')==='true'`, 'account dropdown opened');
    await evaluate(`(()=>{const h=Array.from(document.querySelectorAll('#trading-page-trade button')).find(e=>e.getAttribute('aria-label')!=='选择交易账户'&&e.textContent.includes(${JSON.stringify(provider === 'atas' ? 'ATAS X · Demo connection' : 'NT8 · Demo connection')}));const b=Array.from(h.parentElement.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(name)});if(!b)throw new Error('Missing account option');b.click()})()`);
  };
  // Inspect actual TradingView drawings, not just the account sidebar. Position
  // lines are locked yellow horizontal drawings with a signed quantity label.
  const positionLines = `(()=>{const chart=window.__lastWidget.activeChart();return chart.getAllShapes().filter(s=>s.name==='horizontal_line').map(s=>{const shape=chart.getShapeById(s.id);return {id:s.id,points:shape.getPoints(),properties:shape.getProperties()}}).filter(s=>s.properties.linecolor==='#f0b90b')})()`;
  const workingOrderLines = `(()=>{const chart=window.__lastWidget.activeChart();return chart.getAllShapes().filter(s=>s.name==='horizontal_line').map(s=>{const shape=chart.getShapeById(s.id);return {id:s.id,points:shape.getPoints(),properties:shape.getProperties()}}).filter(s=>s.properties.text==='LMT | +1')})()`;
  const expectPositionLine = async (provider, quantity, averagePrice, label, chartSymbol = symbols[provider]) => {
    const quantityLabel = `${quantity > 0 ? '+' : ''}${quantity}`;
    await until(`window.__lastWidget?.activeChart().symbol()===${JSON.stringify(chartSymbol.toUpperCase())}&&(()=>{const lines=${positionLines};return lines.length===1&&lines[0].points.length===1&&Math.abs(lines[0].points[0].price-${averagePrice})<0.00001&&(lines[0].properties.text===${JSON.stringify(quantityLabel)}||lines[0].properties.text.startsWith(${JSON.stringify(quantityLabel + ' | ')}))})()`, label);
    await until(provider === 'atas'
      ? `(()=>{const lines=${workingOrderLines};return lines.length===1&&Math.abs(lines[0].points[0].price-${atasWorkingOrder.limitPrice})<0.00001})()`
      : `(${workingOrderLines}).length===0`, label + ': working order display and provider isolation');
    return (await evaluate(positionLines))[0];
  };
  const expectNoPositionLine = async label => until(`(${positionLines}).length===0`, label);
  const expectNoWorkingOrderLine = async label => until(`(${workingOrderLines}).length===0`, label);
  const setChartSymbol = async symbol => {
    await evaluate(`new Promise(resolve=>window.__lastWidget.activeChart().setSymbol(${JSON.stringify(symbol)},resolve))`);
    await until(`window.__lastWidget?.activeChart().symbol()===${JSON.stringify(symbol.toUpperCase())}&&window.__tvDatafeed.getLastPrice(${JSON.stringify(symbol)})>24000`, 'chart loads the native ATAS contract ' + symbol);
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `if(window.top===window){
    localStorage.setItem('nt8-bridge-url',${JSON.stringify(origin)});
    localStorage.setItem('atas:nt8-bridge-url',${JSON.stringify(origin + '/atas')});
    localStorage.setItem('nt8-terminal-symbol','NQ SEP26');
    localStorage.setItem('nt8-terminal-chart-count','1');
    localStorage.setItem('nt8-terminal-trading-panel-open','1');
    localStorage.setItem('nt8-terminal-account-panel-open','1');
    for(const [id,name,provider,symbol] of [['legacy','Legacy NT8',undefined,'NQ SEP26'],['atas-replay','ATAS replay','atas',${JSON.stringify(symbols.atas)}]]){
      const start=${now - 86400};
      localStorage.setItem('nt8-terminal-replay-session-v1:'+id,JSON.stringify({version:1,id,name,provider,symbol,startTime:start,cursor:start,initialEquity:100000,createdAt:Date.now(),updatedAt:Date.now(),interval:'1',speed:1,stepSec:60,state:{version:1,initialEquity:100000,positions:[],orders:[],executions:[],realized:0,orderSeq:0,ocoSeq:0},lastPrices:{},pointValues:{}}));
    }
    const f=window.fetch.bind(window);window.fetch=(input,init)=>{const u=new URL(typeof input==='string'?input:input.url,location.href);if(u.origin!==location.origin)throw new Error('Fixture blocks external request '+u.href);return f(input,init)};
  }` });
  await send('Page.navigate', { url: origin });
  await until(`document.querySelector('[data-bridge-status="nt8"]')?.textContent==='NT8 已连接'&&document.querySelector('[data-bridge-status="atas"]')?.textContent==='ATAS 已连接'`, 'independent connected badges');
  await until(`window.__lastWidget?.activeChart().symbol()==='NQ SEP26'&&window.__tvDatafeed?.getLastPrice('NQ SEP26')>23000`, 'NT8 chart ready');
  await expectPositionLine('nt8', 2, 24001.25, 'NT8 position is a real chart drawing at its average price');

  // Chart metadata keeps all expiries available; the search catalog contains only the platform's current contract.
  const beforeCurrentSearch = calls.length;
  await searchSymbol('NQ');
  await until(`document.querySelector('[data-symbol-result="NQ SEP26"]')`, 'NT8 search displays its platform current contract');
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('[data-symbol-result]')).map(e=>e.dataset.symbolResult)`), [symbols.nt8], 'one NT8 search result per underlying, without deferred months');
  assert(calls.slice(beforeCurrentSearch).some(c => c.provider === 'nt8' && c.path === '/api/symbols' && c.query.currentOnly === 'true'), 'NT8 search explicitly requests the current-contract catalog');
  await pickSymbol(symbols.nt8);

  // An explicit deferred month cannot escape that restriction through the resolve fallback.
  const beforeDeferredSearch = calls.length;
  await searchSymbol('NQ 12-26');
  await until(`document.querySelector('[data-symbol-search]')?.textContent.includes('无匹配合约')&&!document.querySelector('[data-symbol-result]')`, 'explicit non-current contract remains absent from search');
  assert(calls.slice(beforeDeferredSearch).some(c => c.provider === 'nt8' && c.path === '/api/resolve' && c.query.symbol === 'NQ 12-26' && c.query.currentOnly === 'true'), 'search fallback enforces the current-contract restriction');
  assert(!calls.slice(beforeDeferredSearch).some(c => c.provider === 'nt8' && c.path === '/api/resolve' && c.query.symbol === 'NQ 12-26' && c.query.currentOnly !== 'true'), 'deferred expiry cannot use unrestricted resolution from search');
  await closeSymbolSearch();

  // Native rollover changes search candidates after reopening without silently changing an existing older chart.
  currentNt8Symbol = 'NQ DEC26';
  const beforeCatalogRefresh = calls.length;
  await searchSymbol('NQ');
  await until(`document.querySelector('[data-symbol-result="NQ DEC26"]')&&!document.querySelector('[data-symbol-result="NQ SEP26"]')`, 'reopened search reflects the platform rollover');
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('[data-symbol-result]')).map(e=>e.dataset.symbolResult)`), [currentNt8Symbol], 'rollover replaces the previous current month');
  assert(calls.slice(beforeCatalogRefresh).some(c => c.provider === 'nt8' && c.path === '/api/symbols' && c.query.currentOnly === 'true'), 'reopening search refreshes the current-contract catalog');
  await closeSymbolSearch();
  assert.equal(await evaluate(`window.__lastWidget.activeChart().symbol()`), symbols.nt8, 'existing historical-month chart remains unchanged after catalog rollover');
  const beforeOldMonthHistory = calls.length;
  await evaluate(`new Promise(resolve=>window.__lastWidget.activeChart().setResolution('5',resolve))`);
  assert(calls.slice(beforeOldMonthHistory).some(c => c.provider === 'nt8' && c.path === '/api/history' && c.query.symbol === symbols.nt8), 'the old chart still loads native history after the platform current contract changes');
  await evaluate(`new Promise(resolve=>window.__lastWidget.activeChart().setResolution('1',resolve))`);
  currentNt8Symbol = symbols.nt8;

  await clickText('nav[aria-label="主导航"] button', '账户总览');
  await until(`document.querySelectorAll('section[aria-label^="账户分组"]').length===2`, 'both account groups');
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('section[aria-label^="账户分组"]')).map(e=>e.getAttribute('aria-label')).sort()`), ['账户分组 ATAS X · Demo connection', '账户分组 NT8 · Demo connection']);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('article h3')).filter(e=>e.textContent==='Sim101').length`), 2, 'same display name appears once in each provider group');
  await shot('dual-bridge-accounts');
  await clickText('nav[aria-label="主导航"] button', '交易图表');
  await evaluate(`document.querySelector('[aria-label="选择交易账户"]').click()`);
  await until(`document.querySelector('[aria-label="选择交易账户"]')?.getAttribute('aria-expanded')==='true'`, 'account dropdown');
  await evaluate(`(()=>{const header=Array.from(document.querySelectorAll('#trading-page-trade button')).find(e=>e.textContent.includes('ATAS X · Demo connection'));const group=header.parentElement;const choice=Array.from(group.querySelectorAll('button')).find(e=>e.textContent.trim()==='Sim101');if(!choice)throw new Error('ATAS account option missing');choice.click()})()`);
  await until(`window.__lastWidget?.activeChart().symbol()===${JSON.stringify(symbols.atas)}&&window.__tvDatafeed?.getLastPrice(${JSON.stringify(symbols.atas)})>24000&&document.querySelector('[aria-label="选择交易账户"]').textContent.includes('ATAS X')`, 'ATAS account switches to its continuous chart source');
  const firstAtasLine = await expectPositionLine('atas', 3, 25001.25, 'ATAS monthly position is drawn on its explicitly associated continuous chart');
  positions.atas = [{ instrument: atasPositionSymbol, chartSymbols: atasChartSymbols, quantity: -2, averagePrice: 24998.75, marketPosition: 'Short' }];
  const changedAtasLine = await expectPositionLine('atas', -2, 24998.75, 'ATAS polling updates signed position quantity and average price on the continuous chart');
  assert.equal(changedAtasLine.id, firstAtasLine.id, 'ATAS position changes update the existing drawing without leaving an old line');
  await shot('dual-bridge-atas-position');
  // The continuous contract is displayable only with the bridge's explicit
  // native association. Similar names or another contract ID grant no match.
  positions.atas = [{ ...positions.atas[0], chartSymbols: [atasPositionSymbol] }];
  await expectNoPositionLine('removing the explicit continuous association removes the position drawing');
  positions.atas = [{ ...positions.atas[0], chartSymbols: atasChartSymbols }];
  await expectPositionLine('atas', -2, 24998.75, 'restoring the native association redraws the continuous position');
  await setChartSymbol(atasUnrelatedSymbol);
  await pause(700);
  await expectNoPositionLine('same-month same-root contract from another native ID cannot inherit the position');
  await expectNoWorkingOrderLine('an unrelated contract ID cannot inherit the working order');
  assert.equal(positions.atas[0].instrument, atasPositionSymbol, 'display matching never rewrites the original trading instrument');
  await setChartSymbol(atasPositionSymbol);
  const monthlyLine = await expectPositionLine('atas', -2, 24998.75, 'special-character canonical monthly symbol also draws its own position', atasPositionSymbol);
  await until(`(()=>{const price=window.__tvDatafeed.getLastPrice(${JSON.stringify(atasPositionSymbol)});if(price==null)return false;const pnl=Math.round((price-24998.75)*-2*2*100)/100;return (${positionLines})[0]?.properties.text==='-2 | '+(pnl>=0?'+':'')+pnl+'$'})()`, 'monthly position label uses the native price and MNQ two-dollar point value despite uppercased chart identity');
  assert.equal(await evaluate('window.__lastWidget.activeChart().symbol()'), atasPositionSymbol.toUpperCase(), 'TradingView uppercases its display symbol while preserving the complete contract ID');
  assert(calls.some(c => c.provider === 'atas' && c.path === '/api/history' && c.query.symbol === atasPositionSymbol), 'market data keeps the original native spelling despite the uppercased chart symbol');
  assert(!calls.some(c => c.provider === 'atas' && c.path === '/api/history' && c.query.symbol === atasPositionSymbol.toUpperCase()), 'the chart display spelling does not replace the native history identifier');
  console.log('ATAS symbol evidence:', { continuous: symbols.atas, nativeTicker: atasPositionSymbol, chartSymbol: await evaluate('window.__lastWidget.activeChart().symbol()') });
  await setChartSymbol(symbols.atas);
  console.log('ATAS returning from monthly chart:', await evaluate(`(()=>{const chart=window.__lastWidget.activeChart();let previous;try{const s=chart.getShapeById(${JSON.stringify(monthlyLine.id)});previous={points:s.getPoints(),properties:s.getProperties()}}catch(e){previous=String(e)}return {symbol:chart.symbol(),shapes:chart.getAllShapes(),previous}})()`));
  await expectPositionLine('atas', -2, 24998.75, 'continuous chart restores exactly one explicitly mapped position line');
  const beforeAtasSearch = calls.length;
  await searchSymbol('MNQ 09-26');
  await until(`document.querySelector('[data-symbol-result="${atasPositionSymbol}"]')&&!document.querySelector('[data-symbol-result="NQ SEP26"]')`, 'ATAS numeric-month alias matches its native contract without stale NT8 candidates');
  await pickSymbol(atasPositionSymbol);
  assert(calls.slice(beforeAtasSearch).some(c => c.provider === 'atas' && c.path === '/api/symbols'), 'ATAS search loads its own provider catalog');
  assert(!calls.slice(beforeAtasSearch).some(c => c.path === '/api/resolve' && c.query.symbol === 'MNQ 09-26'), 'ATAS month alias matches catalog metadata without sending an NT8-format identifier to ATAS');
  await setChartSymbol(symbols.atas);
  await expectPositionLine('atas', -2, 24998.75, 'continuous position survives native-month search and return');
  assert(calls.some(c => c.provider === 'atas' && c.path === '/api/positions' && c.query.account === rawAccounts.atas), 'position query carries raw ATAS account');
  await until(`Array.from(document.querySelectorAll('#trading-page-trade button')).some(e=>e.textContent.includes('买入')&&!e.disabled)`, 'ATAS ticket ready');
  await evaluate(`Array.from(document.querySelectorAll('#trading-page-trade button')).find(e=>e.textContent.includes('买入')&&!e.disabled).click()`);
  await until(`document.querySelector('#trading-page-trade')?.textContent.includes('已提交')`, 'mock-only order response');
  assert.equal(orders.length, 1);
  assert.equal(orders[0].provider, 'atas');
  assert.equal(orders[0].body.account, rawAccounts.atas);
  assert.equal(orders[0].body.symbol, symbols.atas, 'ATAS order cannot inherit NT8 symbol');

  // A normal POST rejection belongs only to the originating order ticket.
  const ordinaryRejection = 'Outside trading hours (isolated fixture rejection)';
  rejectNextOrder = ordinaryRejection;
  await evaluate(`Array.from(document.querySelectorAll('#trading-page-trade button')).find(e=>e.textContent.includes('买入')&&!e.disabled).click()`);
  await until(`document.querySelector('#trading-page-trade')?.textContent.includes(${JSON.stringify(ordinaryRejection)})`, 'ordinary order rejection shows original reason');
  assert.equal(orders.length, 2);
  assert.equal(orders[1].provider, 'atas');
  await pause(3200); // Include the next bridge status refresh.
  assert(!await evaluate(`document.querySelector('[data-bridge-status="atas"]')?.textContent.includes('保护异常')`), 'ordinary rejection must not become a protection warning');
  assert(!await evaluate(`document.querySelector('[data-sidebar]')?.textContent.includes('账户同步提示')`), 'ordinary POST rejection must not become a polling error');

  // Provider-level protection warnings remain visible, but only the affected account shows their details.
  protectionError = 'Fixture: Sim101 protective order synchronization failed';
  await until(`document.querySelector('[data-bridge-status="atas"]')?.textContent.includes('保护异常')&&document.querySelector('[data-sidebar]')?.textContent.includes(${JSON.stringify(protectionError)})`, 'genuine protection failure appears on badge and affected account');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('[data-sidebar] a')).find(e=>e.textContent==='数据桥诊断')?.href`), origin + '/atas/api/debug', 'diagnostics follow the selected account bridge');
  const beforeSafe = calls.length;
  await chooseAccount('atas', 'Safe02');
  await until(`document.querySelector('[aria-label="选择交易账户"]')?.textContent.includes('Safe02')&&!document.querySelector('[data-sidebar]')?.textContent.includes(${JSON.stringify(protectionError)})`, 'another ATAS account does not inherit Sim101 protection error');
  await expectNoPositionLine('selecting the flat ATAS account clears the previous account position line');
  await expectNoWorkingOrderLine('selecting another account clears the previous account working order drawing');
  await pause(700);
  assert(calls.slice(beforeSafe).some(c => c.provider === 'atas' && c.path === '/api/brackets' && c.query.account === safeAtasAccount), 'protection status is queried for Safe02');
  assert(await evaluate(`document.querySelector('[data-bridge-status="atas"]')?.textContent.includes('保护异常')`), 'genuine provider warning remains while the unaffected account is selected');
  assert(!await evaluate(`document.querySelector('#trading-page-trade')?.textContent.includes(${JSON.stringify(ordinaryRejection)})`), 'a previous account order rejection is not shown on Safe02');

  // A delayed response from the old account cannot reintroduce its warning after selection changes.
  await chooseAccount('atas');
  await until(`document.querySelector('[data-sidebar]')?.textContent.includes(${JSON.stringify(protectionError)})`, 'affected account warning returns when selected');
  await expectPositionLine('atas', -2, 24998.75, 'ATAS position line returns despite an account protection warning');
  delayAtasBracket = true;
  for (let i = 0; i < 100 && !delayedBracketReply; i++) await pause(50);
  assert.ok(delayedBracketReply, 'captured a delayed account-scoped protection response');
  await chooseAccount('atas', 'Safe02');
  delayedBracketReply(); delayedBracketReply = null;
  await pause(700);
  assert(!await evaluate(`document.querySelector('[data-sidebar]')?.textContent.includes(${JSON.stringify(protectionError)})`), 'stale Sim101 response is discarded after switching to Safe02');
  await expectNoPositionLine('a delayed old-account poll cannot restore its position line on the flat account');
  await expectNoWorkingOrderLine('a delayed old-account poll cannot restore its working order drawing');
  protectionError = null;
  await chooseAccount('atas');
  await until(`document.querySelector('[data-bridge-status="atas"]')?.textContent==='ATAS 已连接'&&!document.querySelector('[data-sidebar]')?.textContent.includes('账户同步提示')`, 'recovered protection clears both global badge and affected account warning');
  await expectPositionLine('atas', -2, 24998.75, 'returning to the ATAS account restores exactly one current position line');

  // Preserve the legacy replay's source even when the live account is ATAS.
  await clickText('nav[aria-label="主导航"] button', '回放模拟');
  await until(`document.querySelectorAll('[data-replay-session]').length===2`, 'both providers replay sessions remain in one dashboard');
  const beforeReplay = calls.length;
  await clickText('[data-replay-session="legacy"] button', '继续回放');
  await until(`window.__lastWidget?.activeChart().symbol()==='NQ SEP26'&&document.querySelector('[aria-label="回放会话合约"]')`, 'legacy NT8 replay opens while live source is ATAS');
  assert(calls.slice(beforeReplay).some(c => c.provider === 'nt8' && c.path === '/api/history' && c.query.symbol === symbols.nt8), 'legacy session explicitly requests NT8 history');
  assert(!calls.slice(beforeReplay).some(c => c.provider === 'atas' && c.path === '/api/history' && c.query.symbol === symbols.nt8), 'replay never sends an NT8 symbol to ATAS');
  await evaluate('window.__replay.exit()');
  await clickText('nav[aria-label="主导航"] button', '交易图表');
  await until(`window.__lastWidget?.activeChart().symbol()===${JSON.stringify(symbols.atas)}&&document.querySelector('[aria-label="选择交易账户"]').textContent.includes('ATAS X')`, 'exit replay restores ATAS live account/chart');
  await expectPositionLine('atas', -2, 24998.75, 'exiting replay restores the live ATAS position line');

  await chooseAccount('nt8');
  await until(`window.__lastWidget?.activeChart().symbol()==='NQ SEP26'`, 'return to NT8');
  await expectPositionLine('nt8', 2, 24001.25, 'returning to NT8 restores its own position price without an ATAS line');
  // Delay layout serialization to expose ATAS->NT8 selection racing the older save.
  await evaluate(`(()=>{const w=window.__lastWidget;const save=w.save.bind(w);w.save=(cb,...args)=>save(data=>setTimeout(()=>cb(data),700),...args)})()`);
  await chooseAccount('atas');
  await chooseAccount('nt8');
  await pause(1100);
  assert.equal(await evaluate(`window.__lastWidget.activeChart().symbol()`), symbols.nt8, 'newer account choice cancels older pending source switch');
  assert.equal(await evaluate(`localStorage.getItem('terminal-bridge-provider')`), 'nt8');
  await expectPositionLine('nt8', 2, 24001.25, 'rapid cross-provider selection cannot leave a stale ATAS position line');
  await chooseAccount('atas');
  await until(`window.__lastWidget?.activeChart().symbol()===${JSON.stringify(symbols.atas)}`, 'ATAS still opens after canceled source switch');
  await expectPositionLine('atas', -2, 24998.75, 'ATAS position line returns after a canceled source switch');
  online.nt8 = false;
  await until(`document.querySelector('[data-bridge-status="nt8"]')?.textContent==='NT8 未连接'&&document.querySelector('[data-bridge-status="atas"]')?.textContent==='ATAS 已连接'`, 'one bridge offline keeps other connected');
  assert.equal(await evaluate(`window.__lastWidget.activeChart().symbol()`), symbols.atas);
  assert(await evaluate(`Array.from(document.querySelectorAll('#trading-page-trade button')).some(e=>e.textContent.includes('买入')&&!e.disabled)`), 'ATAS remains tradable when NT8 is offline');

  // A temporarily absent account is not a request to reset the user's hidden
  // preference. Keep another account from the same bridge in the snapshot so
  // this specifically covers partial account results, not just disconnection.
  const hiddenAccountId = `bridge:atas:${encodeURIComponent(rawAccounts.atas)}`;
  const hiddenStorage = `JSON.parse(localStorage.getItem('nt8-terminal-hidden-accounts')||'[]')`;
  const restoreEye = `document.querySelector('#trading-page-accounts [aria-label="恢复显示账户 Sim101"]')`;
  const assertHiddenAccount = async label => {
    await until(`!!${restoreEye}&&(${hiddenStorage}).includes(${JSON.stringify(hiddenAccountId)})`, label + ': hidden eye and persisted preference');
    await evaluate(`document.querySelector('[aria-label="选择交易账户"]').click()`);
    await until(`document.querySelector('[aria-label="选择交易账户"]')?.getAttribute('aria-expanded')==='true'`, label + ': account menu opened');
    assert.deepEqual(await evaluate(`(()=>{const h=Array.from(document.querySelectorAll('#trading-page-trade button')).find(e=>e.getAttribute('aria-label')!=='选择交易账户'&&e.textContent.includes('ATAS X · Demo connection'));return Array.from(h.parentElement.querySelectorAll('button')).filter(e=>e!==h).map(e=>e.textContent.trim())})()`), ['Safe02'], label + ': hidden ATAS Sim101 is excluded while Safe02 remains selectable');
    await evaluate(`document.querySelector('[aria-label="选择交易账户"]').click()`);
  };
  await until(`!Array.from(document.querySelectorAll('#trading-page-accounts button')).some(e=>e.textContent.includes('NT8 · Demo connection'))`, 'offline NT8 account snapshot has left only the ATAS group');
  await evaluate(`document.querySelector('#trading-page-accounts [aria-label="隐藏账户 Sim101"]').click()`);
  await until(`document.querySelector('[aria-label="选择交易账户"]')?.textContent.includes('Safe02')`, 'hiding the selected ATAS account automatically selects the remaining Safe02 account');
  await assertHiddenAccount('initial explicit hide');
  const beforePartialAccounts = accountSnapshots.length;
  omitAtasSim101 = true;
  await until(`!${restoreEye}&&!!document.querySelector('#trading-page-accounts [aria-label="隐藏账户 Safe02"]')`, 'ATAS poll applies the partial account snapshot without Sim101');
  assert(accountSnapshots.slice(beforePartialAccounts).some(snapshot => snapshot.provider === 'atas' && snapshot.names.length === 1 && snapshot.names[0] === safeAtasAccount), 'the bridge actually returned a partial same-provider account snapshot');
  assert(await evaluate(`(${hiddenStorage}).includes(${JSON.stringify(hiddenAccountId)})`), 'a missing account retains its saved hidden preference');
  omitAtasSim101 = false;
  await assertHiddenAccount('account returns after a partial snapshot');
  await send('Page.reload', { ignoreCache: true });
  await until(`document.querySelector('[data-bridge-status="atas"]')?.textContent==='ATAS 已连接'&&document.querySelector('[aria-label="选择交易账户"]')?.textContent.includes('Safe02')`, 'reload preserves the selected visible ATAS account');
  await assertHiddenAccount('page reload after the account returns');
  await expectNoPositionLine('a hidden account cannot restore its position drawing on reload');
  await expectNoWorkingOrderLine('a hidden account cannot restore its order drawing on reload');
  await shot('dual-bridge-hidden-account-persistence');
  await evaluate(`${restoreEye}.click()`);
  await until(`!!document.querySelector('#trading-page-accounts [aria-label="隐藏账户 Sim101"]')&&!(${hiddenStorage}).includes(${JSON.stringify(hiddenAccountId)})`, 'only the explicit restore eye removes the saved hidden preference');
  await chooseAccount('atas');
  await expectPositionLine('atas', -2, 24998.75, 'explicitly restored account is selectable with its own position and order drawings');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await pause(500);
  assert(await evaluate(`['nt8','atas'].every(p=>{const e=document.querySelector('[data-bridge-status="'+p+'"]');const r=e?.getBoundingClientRect();return r&&r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<60})`), 'both badges fit compact phone header');
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'), 'no phone horizontal overflow');
  await shot('dual-bridge-mobile');
  assert.deepEqual(calls.filter(c => c.method !== 'GET').map(c => ({ provider: c.provider, method: c.method, path: c.path })), [
    { provider: 'atas', method: 'POST', path: '/api/order/place' },
    { provider: 'atas', method: 'POST', path: '/api/order/place' },
  ], 'programmatic line cleanup never emits an order change, cancellation or other unexpected trading mutation');
  assert.equal(atasWorkingOrder.instrument, atasPositionSymbol, 'chart display aliases never replace the working order native instrument');
  assert.deepEqual(errors, [], 'no uncaught browser errors');
  console.log('PASS dual bridge UI: NT8 current-contract-only search and fallback, rollover catalog refresh with old-chart history preserved, ATAS month aliases with native order identifiers, explicit continuous/monthly chart association with real position drawings and quantity/average-price updates, unrelated contract ID exclusion, special-character canonical symbols preserved, flat-account cleanup and stale-response isolation, statuses/account groups, correct mock order routing, ordinary rejection stays on its ticket, account-scoped protection warnings, legacy replay source, rapid account switching, offline isolation, hidden-account persistence across partial snapshots and reload until explicit restore, phone header.');
} finally {
  ws?.close(); edge.kill();
  for (const res of streams) res.destroy();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
