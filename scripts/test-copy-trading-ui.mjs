// Real Edge/TradingView with a random-port fixture. All copy commands are handled
// in memory here; ordinary bridge mutations are rejected, never forwarded.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve('app/dist');
const output = path.resolve('.tmp-webbridge');
fs.mkdirSync(output, { recursive: true });
const calls = [], bridgeMutations = [], streams = new Set();
const leader = { provider: 'nt8', name: 'Sim101' };
const follower = { provider: 'atas', name: 'fixture-connector:Sim101' };
const secondFollower = { provider: 'nt8', name: 'Sim102' };
const accountRows = [
  { ...leader, displayName: 'Sim101', group: 'Demo connection' },
  { ...secondFollower, displayName: 'Sim102', group: 'Demo connection' },
  { ...follower, displayName: 'Sim101', group: 'TDL fixture' },
];
const state = { version: 1, rules: [], logs: [] };
let ruleId = 0, logId = 0, rejectNextStart = null;
const now = Math.floor(Date.now() / 60000) * 60;
const log = (id, message, extra = {}) => state.logs.push({ id: `log-${++logId}`, time: Date.now(), ruleId: id, level: 'info', message, ...extra });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fixture');
  const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (url.pathname.startsWith('/copy/api/')) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    calls.push({ method: req.method, path: url.pathname, body });
    if (req.method === 'GET' && url.pathname === '/copy/api/status') { json(state); return; }
    if (req.method === 'GET' && url.pathname === '/copy/api/accounts') { json({ accounts: accountRows }); return; }
    if (req.method !== 'POST') { json({ error: 'unexpected fixture method' }, 405); return; }
    if (url.pathname === '/copy/api/rules') {
      const config = { ...body, id: body.id || `fixture-rule-${++ruleId}` };
      const index = state.rules.findIndex(rule => rule.config.id === config.id);
      const row = { config, status: 'stopped', copiedOrders: 0 };
      if (index < 0) state.rules.push(row); else state.rules[index] = row;
      log(config.id, '规则已保存，保持停用。'); json(state); return;
    }
    if (url.pathname === '/copy/api/stop-all') {
      for (const rule of state.rules) rule.status = 'stopped';
      log('', '全部规则已停止；未提交平仓订单。'); json(state); return;
    }
    const match = /^\/copy\/api\/rules\/([^/]+)\/(start|stop|delete)$/.exec(url.pathname);
    const id = match && decodeURIComponent(match[1]);
    const rule = state.rules.find(row => row.config.id === id);
    if (!rule) { json({ error: 'unknown fixture rule' }, 404); return; }
    if (match[2] === 'start') {
      if (rejectNextStart) { const error = rejectNextStart; rejectNextStart = null; json({ error }, 409); return; }
      rule.status = 'running'; rule.startedAt = Date.now(); rule.lastPollAt = Date.now();
      log(id, '成交跟随已启用。');
    } else if (match[2] === 'stop') { rule.status = 'stopped'; log(id, '跟随已停止，当前仓位保持不变。'); }
    else state.rules.splice(state.rules.indexOf(rule), 1);
    json(state); return;
  }
  const provider = url.pathname.startsWith('/atas/') ? 'atas' : 'nt8';
  const endpoint = provider === 'atas' ? url.pathname.slice(5) : url.pathname;
  if (endpoint.startsWith('/api/')) {
    if (req.method !== 'GET') { bridgeMutations.push(endpoint); json({ error: 'fixture forbids direct trading' }, 403); return; }
    if (endpoint === '/api/status') { json({ provider, connected: true, tradingSupported: true, historyWindowVersion: 1, executionArchiveVersion: 1, symbolCatalogVersion: 2 }); return; }
    if (endpoint === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': ready\n\n'); streams.add(res);
      const timer = setInterval(() => res.write(': heartbeat\n\n'), 1000);
      res.once('close', () => { clearInterval(timer); streams.delete(res); }); return;
    }
    const info = { symbol: provider === 'nt8' ? 'NQ SEP26' : 'NQU6@CME', name: 'Nasdaq September 2026', tickSize: .25, pointValue: 20, type: 'futures' };
    const currentOnly = provider === 'nt8' && url.searchParams.get('currentOnly') === 'true';
    if (endpoint === '/api/accounts') { json({ accounts: accountRows.filter(row => row.provider === provider).map(row => ({ name: row.name, displayName: row.displayName, connection: row.group, currency: 'USD', cashValue: 50000 })) }); return; }
    if (endpoint === '/api/symbols') { json({ symbols: [info], ...(currentOnly ? { currentOnly: true, symbolCatalogVersion: 2 } : {}) }); return; }
    if (endpoint === '/api/resolve') { json({ ...info, ...(currentOnly ? { currentOnly: true } : {}) }); return; }
    if (endpoint === '/api/history') {
      const step = Number(url.searchParams.get('interval')) || 60;
      const to = Math.min(now, Number(url.searchParams.get('to')));
      const from = Math.max(to - 864000, Number(url.searchParams.get('from')));
      const bars = [];
      for (let t = Math.ceil(from / step) * step; t <= to; t += step) bars.push({ time: t, open: 24000, high: 24005, low: 23995, close: 24001, volume: 10 });
      json({ bars }); return;
    }
    if (endpoint === '/api/positions') { json({ positions: [] }); return; }
    if (endpoint === '/api/orders') { json({ orders: [] }); return; }
    if (endpoint === '/api/brackets') { json({ brackets: [] }); return; }
    if (endpoint === '/api/executions') { json({ executions: [], total: 0, nextOffset: null, archive: { state: 'ready', recordCount: 0, pendingCount: 0 } }); return; }
    json({ error: 'unexpected bridge fixture endpoint' }, 404); return;
  }
  const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (req.method !== 'GET' || !file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', ({ '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const debugPort = 11900 + process.pid % 100;
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--window-size=1440,1000',
  `--user-data-dir=${path.join(output, `copy-trading-profile-${Date.now()}`)}`, `--remote-debugging-port=${debugPort}`, 'about:blank',
], { stdio: 'ignore', windowsHide: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws, screenshot;
try {
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    try { target = (await fetch(`http://127.0.0.1:${debugPort}/json`).then(response => response.json())).find(row => row.type === 'page'); } catch { /* startup */ }
    if (!target) await pause(200);
  }
  assert.ok(target, 'Edge debugging available');
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(resolve => { ws.onopen = resolve; });
  let sequence = 0; const pending = new Map(), errors = [];
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    const item = pending.get(message.id);
    if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(message.error) : item.resolve(message.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  screenshot = async name => { const { data } = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(data, 'base64')); };
  const until = async (expression, label) => {
    for (let i = 0; i < 120; i++) { if (await evaluate(`(()=>{try{return Boolean(${expression})}catch{return false}})()`)) return; await pause(200); }
    console.log(await evaluate('document.body.innerText.slice(-4000)')); throw new Error(`Timeout ${label}`);
  };
  const clickText = async (text, selector = '[data-copy-trading-page] button') => evaluate(`(()=>{const e=Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw new Error('Missing/disabled button '+${JSON.stringify(text)});e.click()})()`);
  const clickLabel = async label => evaluate(`(()=>{const e=document.querySelector('[aria-label='+CSS.escape(${JSON.stringify(label)})+']');if(!e||e.disabled)throw new Error('Missing/disabled labeled button');e.click()})()`);
  const fill = async (label, value, select = false) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(`${select ? 'select' : 'input'}[aria-label="${label}"]`)});if(!e)throw new Error('Missing field '+${JSON.stringify(label)});Object.getOwnPropertyDescriptor(${select ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype,'value').set.call(e,${JSON.stringify(String(value))});e.dispatchEvent(new Event('${select ? 'change' : 'input'}',{bubbles:true}))})()`);
  const physicalClick = async selector => {
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw new Error('Missing click target');const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const pageText = `document.querySelector('[data-copy-trading-page]')?.textContent`;
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `if(window.top===window){
    localStorage.setItem('nt8-bridge-url',${JSON.stringify(origin)});localStorage.setItem('atas:nt8-bridge-url',${JSON.stringify(origin + '/atas')});
    localStorage.setItem('nt8-terminal-symbol','NQ SEP26');localStorage.setItem('nt8-terminal-chart-count','1');localStorage.setItem('nt8-terminal-theme','dark');
    const fetchOriginal=window.fetch.bind(window);window.fetch=(input,init)=>{const u=new URL(typeof input==='string'?input:input.url,location.href);if(u.origin!==location.origin)throw new Error('Fixture blocks external request '+u.href);return fetchOriginal(input,init)};
  }` });
  await send('Page.navigate', { url: origin });
  await until(`document.querySelector('[data-bridge-status="nt8"]')?.textContent==='NT8 已连接'`, 'initial chart app');
  await clickText('复制交易', 'nav[aria-label="主导航"] button');
  await until(`${pageText}?.includes('尚无复制规则')`, 'copy service page');
  assert.equal(calls.filter(call => call.method === 'POST').length, 0, 'opening the page never starts copying');
  await clickText('新建规则');
  await fill('复制规则名称', '跨桥跟随测试');
  await fill('主账户', JSON.stringify([leader.provider, leader.name]), true);
  await fill('跟随账户 1', JSON.stringify([follower.provider, follower.name]), true);
  assert.deepEqual(await evaluate(`Array.from(document.querySelector('select[aria-label="主账户"]').querySelectorAll('optgroup')).map(e=>e.label)`), ['ATAS X · TDL fixture', 'NT8 · Demo connection']);
  assert.equal(await evaluate(`document.querySelector('select[aria-label="主账户"]').selectedOptions[0].text`), 'NT8 · Sim101');
  assert.equal(await evaluate(`document.querySelector('select[aria-label="跟随账户 1"]').selectedOptions[0].text`), 'ATAS X · Sim101');
  await fill('跟随 1 倍率', 0.5); await fill('跟随 1 最大单笔手数', 4);
  await clickText('保存规则（保持停用）');
  await until(`${pageText}?.includes('跨桥跟随，需要填写合约映射')`, 'cross-provider validation');
  assert.equal(calls.filter(call => call.method === 'POST').length, 0, 'invalid cross-bridge rule stays local');
  await clickText('添加映射');
  await fill('跟随 1 映射 1 主合约', 'NQ SEP26');
  const nativeTarget = 'NQU6@CME#atas-id=ContractIdentifier(33251:)';
  await fill('跟随 1 映射 1 跟随合约', nativeTarget);
  await screenshot('copy-trading-desktop-editor');
  await clickText('保存规则（保持停用）');
  await until(`document.querySelector('[data-copy-rule="fixture-rule-1"]')?.textContent.includes('已停用')&&!document.querySelector('[aria-label="规则编辑"]')`, 'save without enabling');
  const saved = calls.find(call => call.path === '/copy/api/rules').body;
  assert.deepEqual(saved.leader, leader); assert.deepEqual(saved.followers[0].account, follower);
  assert.equal(saved.followers[0].multiplier, 0.5); assert.equal(saved.followers[0].maxOrderQuantity, 4);
  assert.equal(saved.followers[0].mappings[0].targetSymbol, nativeTarget);
  assert(!calls.some(call => call.path.endsWith('/start')), 'save must not silently enable');

  await clickText('编辑'); await fill('复制规则名称', '尚未保存的编辑');
  state.rules[0].config.name = '其他浏览器已修改';
  await until(`document.querySelector('[data-copy-rule] h3')?.textContent==='其他浏览器已修改'`, 'background status refresh');
  assert.equal(await evaluate(`document.querySelector('input[aria-label="复制规则名称"]').value`), '尚未保存的编辑', 'polling must preserve draft input');
  await clickLabel('关闭规则编辑');
  rejectNextStart = '主账户仍有工作订单，本次未启用。';
  await clickText('启用跟随');
  await until(`${pageText}?.includes('主账户仍有工作订单，本次未启用。')`, 'start failure shows original reason');
  assert.equal(state.rules[0].status, 'stopped');
  await clickText('启用跟随');
  await until(`document.querySelector('[data-copy-rule]')?.textContent.includes('运行中')`, 'manual start confirmed');
  state.rules[0].copiedOrders = 1;
  log('fixture-rule-1', '已按主账户成交提交跟随订单（模拟服务）。', { followerAccount: 'atas · fixture-connector:Sim101', sourceExecutionId: 'fake-fill-1', sourceSymbol: 'NQ SEP26', targetSymbol: nativeTarget, quantity: 1, targetOrderId: 'fake-order-1' });
  await until(`${pageText}?.includes('fake-order-1')`, 'server-side copied execution log');
  await clickText('账户总览', 'nav[aria-label="主导航"] button');
  await until(`document.querySelector('h1')?.textContent==='账户总览'`, 'other page');
  assert.equal(state.rules[0].status, 'running', 'leaving the control page cannot stop background copying');
  await clickText('复制交易', 'nav[aria-label="主导航"] button');
  await until(`document.querySelector('[data-copy-rule]')?.textContent.includes('运行中')`, 'reopen reflects server state');
  await screenshot('copy-trading-desktop-running');
  await clickText('停止跟随');
  await until(`document.querySelector('[data-copy-rule]')?.textContent.includes('已停用')`, 'manual stop confirmed');
  assert(calls.some(call => call.path === '/copy/api/rules/fixture-rule-1/stop'));

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await until(`document.querySelector('[aria-label="页面菜单"]')`, 'phone navigation');
  await physicalClick('[aria-label="页面菜单"]');
  await until(`document.querySelector('[role="menuitem"][aria-label="交易图表"]')`, 'phone menu open');
  await physicalClick('[role="menuitem"][aria-label="交易图表"]');
  await until(`!document.querySelector('[data-copy-trading-page]')`, 'leave copy on phone');
  // Showing the chart iframe can restore its focus after navigation; open the menu after that settles.
  await until(`window.__lastWidget?.activeChart().symbol()==='NQ SEP26'`, 'phone chart ready');
  await pause(600);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await evaluate(`Boolean(document.querySelector('[role="menuitem"][aria-label="复制交易"]'))`)) break;
    await physicalClick('[aria-label="页面菜单"]');
    await pause(300);
  }
  await until(`document.querySelector('[role="menuitem"][aria-label="复制交易"]')`, 'copy entry in phone menu');
  await physicalClick('[role="menuitem"][aria-label="复制交易"]');
  await until(`document.querySelector('[data-copy-rule]')`, 'phone copy page');
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'), 'phone copy page has no horizontal overflow');
  await screenshot('copy-trading-mobile');
  await clickText('新建规则'); await fill('复制规则名称', '同桥跟随测试');
  await fill('主账户', JSON.stringify([leader.provider, leader.name]), true);
  await fill('跟随账户 1', JSON.stringify([secondFollower.provider, secondFollower.name]), true);
  await until(`document.querySelector('[aria-label="规则编辑"]')?.textContent.includes('同桥可留空')`, 'same-provider rule mapping remains optional');
  await evaluate(`document.querySelector('[aria-label="规则编辑"]').scrollIntoView({block:'start'})`);
  assert(await evaluate(`Array.from(document.querySelectorAll('[aria-label="规则编辑"] input,[aria-label="规则编辑"] select')).every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})`), 'phone configuration fields fit without clipping');
  await screenshot('copy-trading-mobile-editor');
  await clickText('保存规则（保持停用）');
  await until(`document.querySelectorAll('[data-copy-rule]').length===2`, 'multiple saved rules');
  assert.equal(state.rules[1].status, 'stopped'); assert.deepEqual(state.rules[1].config.followers[0].mappings, []);
  await clickText('启用跟随');
  await until(`document.querySelector('[data-copy-rule="fixture-rule-1"]')?.textContent.includes('运行中')`, 'restart existing rule');
  await clickText('全部停止');
  await until(`Array.from(document.querySelectorAll('[data-copy-rule]')).every(e=>e.textContent.includes('已停用'))`, 'stop all acknowledgment');
  await clickLabel('删除规则 同桥跟随测试');
  await until(`document.querySelectorAll('[data-copy-rule]').length===1`, 'delete stopped rule');
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 740, deviceScaleFactor: 1, mobile: true });
  await pause(300);
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'), '320 px layout has no horizontal overflow');
  await evaluate(`document.querySelector('[data-copy-trading-page]').scrollTop=0`);
  await physicalClick('[aria-label="页面菜单"]');
  await until(`document.querySelector('[role="menuitem"][aria-label="切换为白天模式"]')`, 'phone theme control');
  await physicalClick('[role="menuitem"][aria-label="切换为白天模式"]');
  await pause(300); await screenshot('copy-trading-mobile-light');
  assert.equal(bridgeMutations.length, 0, 'copy control never submits a direct real/simulated bridge order');
  assert.deepEqual(errors, [], 'page and chart produce no uncaught JavaScript errors');
  console.log('PASS copy trading browser UI: provider groups, explicit mappings and native IDs, ratio/quantity, save stopped, acknowledged start/stop/errors, independent background state, draft isolation, logs, multiple rules/delete/stop-all, 390/320 px mobile menu/form, dark/light themes. All copy requests used the random-port mock.');
} catch (error) {
  try { await screenshot?.('copy-trading-failure'); } catch { /* preserve original failure */ }
  throw error;
} finally {
  ws?.close(); edge.kill(); for (const stream of streams) stream.end();
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
