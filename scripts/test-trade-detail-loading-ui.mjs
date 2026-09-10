// Isolated Edge regression for a missing lazy-loaded detail module; every bridge call is mocked.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const root = path.resolve('app/dist'), output = path.resolve('.tmp-webbridge');
fs.mkdirSync(output, { recursive: true });
let blockDetail = true, blockedRequests = 0;
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://fixture').pathname;
  if (blockDetail && /^\/assets\/TradeDetails-[^/]+\.js$/.test(pathname)) {
    blockedRequests++; res.writeHead(503, { 'Content-Type': 'text/plain' }).end('Injected detail module load failure'); return;
  }
  const file = path.resolve(root, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = 11400 + process.pid % 100;
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
  `--user-data-dir=${path.join(output, `detail-loading-profile-${Date.now()}`)}`,
  `--remote-debugging-port=${port}`, '--window-size=1920,1080', 'about:blank',
], { stdio: 'ignore', windowsHide: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let ws;
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json())).find(t => t.type === 'page'); } catch {}
    if (!target) await pause(200);
  }
  assert.ok(target, 'Edge debugging target');
  ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise(resolve => { ws.onopen = resolve; });
  let sequence = 0;
  const pending = new Map(), exceptions = [], failedResources = [], actualBridgeRequests = [];
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  ws.onmessage = event => {
    const message = JSON.parse(event.data), p = message.params;
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text);
    if (message.method === 'Network.responseReceived' && p.response.status >= 400) failedResources.push({ status: p.response.status, url: p.response.url });
    if (message.method === 'Fetch.requestPaused') {
      actualBridgeRequests.push({ url: p.request.url, method: p.request.method });
      void send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
    }
    const cb = pending.get(message.id);
    if (cb) { pending.delete(message.id); clearTimeout(cb.timer); message.error ? cb.reject(message.error) : cb.resolve(message.result); }
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
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(150); }
    await shot('detail-loading-failure'); throw new Error(`Timeout: ${label}`);
  };
  const click = label => evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)})?.click()`);
  const intact = `!!document.querySelector('[aria-label="主导航"]') && document.querySelectorAll('[data-trade-record]').length===2`;
  const fallback = `Array.from(document.querySelectorAll('[role="alert"]')).some(node=>node.textContent.includes('交易详情暂时无法显示'))`;
  const chart = `!!document.querySelector('[data-trade-detail-chart] canvas')`;
  const openFirst = () => evaluate(`document.querySelector('[data-trade-record] button').click()`);
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  // No request can reach an actual bridge if the in-page mock is accidentally bypassed.
  await send('Fetch.enable', { patterns: [{ urlPattern: '*://*/api/*', requestStage: 'Request' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
    if(window.top!==window)return;
    localStorage.setItem('nt8-terminal-symbol','NQ TEST');localStorage.setItem('nt8-terminal-show-trades','0');
    const time=Math.floor(Date.now()/1000)-7200;
    const executions=[['entry','Buy',2,100,time],['exit','Sell',1,110,time+60]].map(([executionId,side,qty,price,time])=>({executionId,orderId:executionId,account:'Fixture',instrument:'NQ TEST',time,timeMs:time*1000,side,qty,price,commission:qty,pointValue:20,currency:'USD'}));
    const symbol={symbol:'NQ TEST',name:'NQ TEST',tickSize:.25,pointValue:20,type:'futures'};
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      if(!url.pathname.startsWith('/api/'))return originalFetch(input,init);
      if((init?.method||input?.method||'GET').toUpperCase()!=='GET'){sessionStorage.setItem('detail-fixture-mutation','1');throw new Error('No bridge writes in fixture');}
      const q=url.searchParams;let data;
      switch(url.pathname){
        case '/api/status':data={connected:true,connectionName:'Detail load fixture',historyWindowVersion:1,executionArchiveVersion:1};break;
        case '/api/symbols':data={symbols:[symbol]};break;
        case '/api/resolve':data=symbol;break;
        case '/api/accounts':data={accounts:[{name:'Fixture',connection:'Mock',currency:'USD',cashValue:100000}]};break;
        case '/api/positions':data={positions:[]};break;
        case '/api/orders':data={orders:[]};break;
        case '/api/brackets':data={brackets:[]};break;
        case '/api/executions':data={executions,total:executions.length,nextOffset:null,archive:{version:1,state:'ready',recordCount:executions.length,pendingCount:0}};break;
        case '/api/history':{
          const from=Number(q.get('from')),to=Number(q.get('to')),step=Number(q.get('interval'))||60,bars=[];
          for(let t=Math.ceil(Math.max(from,to-86400)/step)*step;t<=to;t+=step)bars.push({time:t,open:100,high:112,low:99,close:105,volume:10});
          data={bars};break;
        }
        default:throw new Error('Unknown fixture endpoint '+url.pathname);
      }
      return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
    };
    window.EventSource=class{constructor(){setTimeout(()=>this.onopen?.(),0);}close(){}};
  })();` });
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await until(`!!document.querySelector('[aria-label="主导航"]')`, 'main navigation');
  await click('交易记录'); await until(intact, 'paired and unpaired fixture rows');
  await openFirst(); await until(fallback, 'failed dynamic module is contained locally');
  assert.ok(blockedRequests > 0, 'TradeDetails module was actually blocked');
  assert.ok(await evaluate(intact), 'navigation and table survive failed module');
  await shot('detail-loading-contained');
  await click('关闭详情'); await until(`!(${fallback}) && ${intact}`, 'close fallback preserves table');
  await click('账户总览'); await until(`document.querySelector('h1')?.textContent==='账户总览'`, 'navigation still works');
  await click('交易记录'); await until(intact, 'return to history');
  blockDetail = false;
  await openFirst(); await until(`(${fallback}) || (${chart})`, 'reopen after server resource recovery');
  if (await evaluate(fallback)) {
    await click('重试详情'); await until(`(${fallback}) || (${chart})`, 'explicit retry remains contained');
    assert.ok(await evaluate(intact), 'retry preserves the history page');
  }
  let usedRefresh = false;
  if (!(await evaluate(chart))) {
    usedRefresh = true;
    assert.ok(await evaluate(`document.body.innerText.includes('刷新页面')`), 'cached rejected module provides refresh guidance');
    await send('Page.reload'); await until(`!!document.querySelector('[aria-label="主导航"]')`, 'manual reload navigation');
    await click('交易记录'); await until(intact, 'archive survives refresh'); await openFirst();
  }
  await until(chart, 'detail chart opens after resource recovery');
  await until(`document.querySelector('[role="dialog"] [role="status"]')?.textContent.includes('根')`, 'recovered chart history');
  await shot('detail-loading-recovered');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(`!document.querySelector('[role="dialog"]') && ${intact}`, 'close successful detail');
  await evaluate(`document.querySelector('[data-trade-record="unpaired"] button').click()`);
  await until(`(${chart}) && document.querySelector('[role="dialog"]')?.textContent.includes('未配对')`, 'unpaired detail remains available');
  assert.equal(await evaluate(`sessionStorage.getItem('detail-fixture-mutation')`), null, 'no mutation attempted');
  assert.deepEqual(actualBridgeRequests, [], 'all bridge requests satisfied by mocks');
  assert.deepEqual(exceptions, [], 'no uncaught browser exceptions');
  assert.deepEqual(failedResources.filter(r=>!r.url.endsWith('/favicon.ico') && !(r.status===503 && /\/TradeDetails-[^/]+\.js$/.test(r.url))), [], 'only injected module failure');
  console.log(`PASS detail module loading: isolated failure, intact navigation/table, close/reopen/retry, recovery${usedRefresh ? ' after manual refresh for browser-cached rejection' : ' without refresh'}, paired/unpaired charts; no real bridge traffic`);
} finally { ws?.close(); edge.kill(); server.close(); }
