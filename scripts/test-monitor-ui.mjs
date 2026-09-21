// Monitor page against the built frontend with a fully mocked bridge.
// The fixture allows only GET; any bridge mutation fails the test.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const root = path.resolve('app/dist');
const output = path.resolve('.tmp-webbridge');
fs.mkdirSync(output, { recursive: true });
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://local').pathname;
  const file = path.resolve(root, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end(); return;
  }
  const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const debugPort = 11300 + process.pid % 150;
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${path.join(output, `monitor-profile-${Date.now()}`)}`,
  `--remote-debugging-port=${debugPort}`, '--window-size=1920,1080', 'about:blank',
], { stdio: 'ignore', windowsHide: true });
let ws;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await fetch(`http://127.0.0.1:${debugPort}/json`).then(r => r.json())).find(t => t.type === 'page'); } catch {}
    if (!target) await pause(200);
  }
  assert.ok(target, 'Edge debugging endpoint');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => { ws.onopen = resolve; });
  let sequence = 0;
  const pending = new Map(), runtimeErrors = [];
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') {
      runtimeErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    }
    const callback = pending.get(message.id);
    if (callback) {
      pending.delete(message.id); clearTimeout(callback.timer);
      message.error ? callback.reject(message.error) : callback.resolve(message.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      .catch(error => { throw new Error(`${error.message || error}: ${expression.slice(0, 250)}`); });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const until = async (expression, label) => {
    for (let i = 0; i < 120; i++) { if (await evaluate(`(()=>{try{return (${expression})}catch{return false}})()`)) return; await pause(200); }
    console.log('Monitor failure context', await evaluate(`document.body.innerText.slice(-1500)`));
    throw new Error(`Timed out: ${label}`);
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
    if(window.top!==window)return;
    if(!sessionStorage.getItem('monitor-fixture-initialized')){
      for(const [key,value] of Object.entries({'symbol':'NQ SEP26','interval':'5','chart-count':'1','theme':'dark','show-trades':'0'}))localStorage.setItem('nt8-terminal-'+key,value);
      sessionStorage.setItem('monitor-fixture-initialized','1');
    }
    window.__monitorFixture={calls:[]};
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      if(url.port!=='8090'&&url.port!=='8091')return originalFetch(input,init);
      if((init?.method||input?.method||'GET').toUpperCase()!=='GET')throw new Error('Monitor test forbids bridge mutations: '+url.pathname);
      window.__monitorFixture.calls.push(url.port+url.pathname+url.search);
      const q=url.searchParams;let data;
      if(url.port==='8091'){
        switch(url.pathname){
          case '/api/status':data={provider:'atas',connected:false};break;
          case '/api/accounts':data={accounts:[]};break;
          default:throw new Error('Unexpected ATAS fixture endpoint '+url.pathname);
        }
        return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
      }
      switch(url.pathname){
        case '/api/status':data={connected:true,connectionName:'Monitor fixture',historyWindowVersion:1,executionArchiveVersion:1};break;
        case '/api/symbols':data={symbols:[{symbol:'NQ SEP26',name:'E-mini Nasdaq',tickSize:0.25,pointValue:20,type:'futures'}]};break;
        case '/api/resolve':data={symbol:'NQ SEP26',name:'E-mini Nasdaq',tickSize:0.25,pointValue:20,type:'futures'};break;
        case '/api/accounts':data={accounts:[{name:'Sim101',connection:'Simulation',currency:'UsDollar',cashValue:100000,netLiquidation:100500,realizedPnl:230,unrealizedPnl:500}]};break;
        case '/api/positions':data={positions:[{instrument:'NQ SEP26',quantity:2,averagePrice:23990,marketPosition:'Long'}]};break;
        case '/api/orders':data={orders:[
          {orderId:'fixture-tp',instrument:'NQ SEP26',action:'Sell',orderType:'Limit',quantity:2,filled:0,limitPrice:24050,stopPrice:0,averageFillPrice:0,state:'Working',oco:'oco-1',name:'TV TP',time:1},
          {orderId:'fixture-sl',instrument:'NQ SEP26',action:'Sell',orderType:'StopMarket',quantity:2,filled:0,limitPrice:0,stopPrice:23950,averageFillPrice:0,state:'Working',oco:'oco-1',name:'TV SL',time:1},
          {orderId:'fixture-filled',instrument:'NQ SEP26',action:'Buy',orderType:'Market',quantity:2,filled:2,limitPrice:0,stopPrice:0,averageFillPrice:23990,state:'Filled',oco:'',name:'TV Entry',time:1},
        ]};break;
        case '/api/brackets':data={brackets:[]};break;
        case '/api/executions':data={executions:[],total:0,nextOffset:null,archive:{version:1,state:'ready',recordCount:0,pendingCount:0}};break;
        case '/api/history':{
          const from=Number(q.get('from')),to=Number(q.get('to')),step=Number(q.get('interval'))||300,bars=[];
          for(let t=Math.ceil(from/step)*step;t<=to;t+=step){const p=24000+Math.sin(t/600)*5;bars.push({time:t,open:p-1,high:p+3,low:p-3,close:p,volume:100});}
          data={bars};break;
        }
        default:throw new Error('Unexpected fixture endpoint '+url.pathname);
      }
      return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
    };
    window.EventSource=class{
      constructor(url){
        const q=new URL(url,location.href).searchParams;
        const step=Number(q.get('interval'))||300;
        const t1=Math.floor(Date.now()/1000/step)*step;
        setTimeout(()=>{this.onopen?.();
          this.onmessage?.({data:JSON.stringify({time:t1,open:24002,high:24008,low:23998,close:24005,volume:100})});
          this.onmessage?.({data:JSON.stringify({time:t1+step,open:24005,high:24012,low:24003,close:24010,volume:100})});
        },300);
      }
      close(){}
    };
  })();` });
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await until(`Array.from(document.querySelectorAll('[aria-label="主导航"] button')).some(b=>b.textContent.trim()==='监控面板')`, 'monitor nav entry');
  await evaluate(`Array.from(document.querySelectorAll('[aria-label="主导航"] button')).find(b=>b.textContent.trim()==='监控面板').click()`);

  await until(`document.querySelectorAll('[data-monitor-card]').length===1`, 'one monitor card for the positioned account');
  await until(`document.querySelector('[data-monitor-chart] canvas')`, 'lightweight chart canvas rendered');
  await until(`document.querySelector('[data-monitor-card]')?.innerText.includes('800.00 USD')`, 'live pnl from SSE ticks');

  const text = await evaluate(`document.querySelector('[data-monitor-card]').innerText`);
  assert.ok(text.includes('Sim101'), 'card shows the account name');
  assert.ok(text.includes('净清算') && text.includes('100,500.00 USD'), 'card shows net liquidation');
  assert.ok(text.includes('现金') && text.includes('100,000.00 USD'), 'card shows cash value');
  assert.ok(text.includes('当日已实现') && text.includes('230.00 USD'), 'card shows realized pnl');
  assert.ok(text.includes('浮动盈亏 · 实时'), 'total pnl switches to live once prices arrive');
  assert.ok(text.includes('NQ SEP26') && text.includes('+2 @ 23990'), 'position row shows quantity and average price');

  const intervals = await evaluate(`Array.from(document.querySelectorAll('[data-monitor-card] [aria-label="K线周期"] button')).map(b=>({text:b.textContent.trim(),pressed:b.getAttribute('aria-pressed')}))`);
  assert.deepEqual(intervals, [
    { text: '1分', pressed: 'false' }, { text: '5分', pressed: 'true' },
    { text: '15分', pressed: 'false' }, { text: '60分', pressed: 'false' },
  ], 'interval switcher defaults to 5 minutes');

  const historyCalls = await evaluate(`window.__monitorFixture.calls.filter(c=>c.includes('/api/history')).length`);
  assert.ok(historyCalls >= 2, `main chart and monitor card each load history: ${historyCalls}`);
  assert.deepEqual(runtimeErrors, [], 'no page runtime errors');
  console.log('PASS monitor page: card with balances, live pnl from SSE, position row, default 5m interval and rendered chart');
} finally {
  try { ws?.close(); } catch {}
  edge.kill();
  server.close();
}
