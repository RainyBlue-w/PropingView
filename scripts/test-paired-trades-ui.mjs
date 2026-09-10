// Isolated headless Edge fixtures: no live bridge traffic or mutations are allowed.
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
const debugPort = 10400 + process.pid % 150;
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${path.join(output, `paired-trades-profile-${Date.now()}`)}`,
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
  const pending = new Map(), runtimeErrors = [], failedResources = [];
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) failedResources.push(`${message.params.response.status} ${message.params.response.url}`);
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
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const shot = async name => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const until = async (expression, label) => {
    for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await pause(200); }
    await shot('paired-trades-failure');
    console.log('Paired trade failure context', await evaluate(`({text:document.body.innerText.slice(-4500),post:sessionStorage.getItem('fixture-unexpected-post')})`));
    throw new Error(`Timed out: ${label}`);
  };
  const click = label => evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)})?.click()`);
  const setSelect = (label, value) => evaluate(`(()=>{const input=document.querySelector('select[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!input)throw new Error('Missing select '+${JSON.stringify(label)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const setDate = (label, value) => evaluate(`(()=>{const input=document.querySelector('input[aria-label='+${JSON.stringify(JSON.stringify(label))}+']');if(!input)throw new Error('Missing date '+${JSON.stringify(label)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const historyTable = `document.querySelector('section[aria-label="配对交易记录"] table')`;
  const statsText = `document.querySelector('[aria-label="交易表现统计"]')?.innerText`;
  const records = () => evaluate(`Array.from(${historyTable}.tBodies[0].rows).filter(row=>row.hasAttribute('data-trade-record')).map(row=>Array.from(row.cells).map(cell=>cell.innerText))`);
  const assertCount = (count, label) => until(`document.body.innerText.includes('共 ${count} 笔交易') && ${historyTable}?.querySelectorAll('[data-trade-record]').length===${count} && ${statsText}?.includes('${count} 笔交易')`, label);
  const storedExecutions = () => evaluate(`new Promise((resolve,reject)=>{const request=indexedDB.open('nt8-terminal-trade-archive',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{const db=request.result,tx=db.transaction('executions','readonly'),read=tx.objectStore('executions').getAll();tx.oncomplete=()=>{db.close();resolve(read.result.map(item=>item.row).sort((a,b)=>a.executionId.localeCompare(b.executionId)))};tx.onerror=()=>reject(tx.error)}})`);
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
    if(window.top!==window)return;
    localStorage.setItem('nt8-terminal-symbol','NQ SEP26');
    localStorage.setItem('nt8-terminal-show-trades','0');
    localStorage.setItem('nt8-terminal-theme','dark');
    const base=new Date();base.setHours(0,0,0,0);base.setDate(base.getDate()-5);
    const date=day=>{const d=new Date(base);d.setDate(d.getDate()+day);return d;};
    const format=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    const make=(executionId,account,instrument,day,minute,side,qty,price,commission,pointValue)=>{const timeMs=date(day).getTime()+minute*60000;return {executionId,orderId:'order-'+executionId,account,instrument,time:timeMs/1000,timeMs,side,qty,price,commission,pointValue,currency:'USD'};};
    const executions=[
      make('partial-entry','Sim101','NQ SEP26',0,1438,'Buy',3,100,7.5,20),
      make('partial-exit-1','Sim101','NQ SEP26',1,0,'Sell',1,110,2.5,20),
      make('partial-exit-2','Sim101','NQ SEP26',1,600,'Sell',2,105,5,20),
      make('short-entry','Sim101','ES SEP26',1,540,'Sell',2,200,4,50),
      make('reverse','Sim101','ES SEP26',1,600,'Buy',3,190,6,50),
      make('reverse-close','Sim101','ES SEP26',1,660,'Sell',1,195,2,50),
      make('other-account-entry','Sim102','NQ SEP26',0,720,'Sell',1,120,2.5,20),
      make('other-account-exit','Sim102','NQ SEP26',1,720,'Buy',1,115,2.5,20),
      make('unpaired','Sim101','RTY SEP26',1,780,'Buy',2,2300,4,50),
      make('missing-fee-entry','Sim101','YM SEP26',1,840,'Buy',1,40000,undefined,5),
      make('missing-fee-exit','Sim101','YM SEP26',1,900,'Sell',1,40010,1,5),
      make('unknown-side','Sim101','MES SEP26',1,960,'Mystery',1,6500,1,5),
      make('unknown-instrument','Sim101','',1,1020,'Buy',1,99,1,20),
    ];
    const instruments=[['NQ SEP26',20,100],['ES SEP26',50,195],['RTY SEP26',50,2300],['YM SEP26',5,40000],['MES SEP26',5,6500]].map(([symbol,pointValue,price])=>({symbol,name:symbol,tickSize:.25,pointValue,price,type:'futures'}));
    window.__fixture={calls:[],dates:[0,1,2].map(day=>format(date(day))),executions,offline:sessionStorage.getItem('fixture-offline')==='1'};
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      if(url.port!=='8090')return originalFetch(input,init);
      if((init?.method||input?.method||'GET').toUpperCase()!=='GET'){
        sessionStorage.setItem('fixture-unexpected-post',JSON.stringify({url:url.href,method:init?.method,body:init?.body}));
        throw new Error('Paired trade test forbids all bridge mutations');
      }
      if(window.__fixture.offline)throw new Error('fixture bridge offline');
      window.__fixture.calls.push(url.pathname+url.search);
      const q=url.searchParams;let data;
      switch(url.pathname){
        case '/api/status':data={connected:true,connectionName:'Paired trade fixture',historyWindowVersion:1,executionArchiveVersion:1};break;
        case '/api/symbols':data={symbols:instruments};break;
        case '/api/resolve':data=instruments.find(s=>s.symbol===q.get('symbol'));break;
        case '/api/accounts':data={accounts:[{name:'Sim101',connection:'Simulation',currency:'USD',cashValue:100000},{name:'Sim102',connection:'Other Simulation',currency:'USD',cashValue:50000}]};break;
        case '/api/positions':data={positions:[]};break;
        case '/api/orders':data={orders:[]};break;
        case '/api/brackets':data={brackets:[]};break;
        case '/api/executions':{
          const rows=executions.filter(e=>(!q.get('account')||e.account===q.get('account'))&&(!q.get('symbol')||e.instrument===q.get('symbol'))&&(!q.get('from')||e.time>=Number(q.get('from')))&&(!q.get('to')||e.time<=Number(q.get('to'))));
          const offset=Number(q.get('offset')||0),limit=Number(q.get('limit')||200);
          data={executions:rows.slice(offset,offset+limit),total:rows.length,nextOffset:offset+limit<rows.length?offset+limit:null,archive:{version:1,state:'ready',recordCount:executions.length,pendingCount:0}};break;
        }
        case '/api/history':{
          const from=Number(q.get('from')),to=Math.min(Number(q.get('to')),Date.now()/1000),step=Number(q.get('interval'))||60,bars=[];
          const price=instruments.find(s=>s.symbol===q.get('symbol'))?.price||100;
          for(let t=Math.ceil(Math.max(from,to-864000)/step)*step;t<=to;t+=step){const p=price+Math.sin(t/600)*2;bars.push({time:t,open:p-1,high:p+3,low:p-3,close:p,volume:100});}
          data={bars};break;
        }
        default:throw new Error('Unexpected fixture endpoint '+url.pathname);
      }
      return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
    };
    window.EventSource=class{constructor(){setTimeout(()=>this.onopen?.(),0);}close(){}};
  })();` });
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await until(`!!document.querySelector('[aria-label="主导航"]')`, 'terminal navigation');
  await click('交易记录');
  await assertCount(9, '13 archived executions produce six closed pairs, one unpaired lot and two invalid rows');
  assert.deepEqual(await evaluate(`Array.from(${historyTable}.tHead.rows[0].cells).map(cell=>cell.innerText)`), ['入场时间','离场时间','账户','合约','方向','数量','入场价格','离场价格','盈亏额','状态','详情'], 'entry/exit/PnL columns have no commission column');
  const originalStorage = await storedExecutions();
  assert.equal(originalStorage.length,13,'archive preserves all raw executions instead of replacing them with paired records');
  assert.equal(originalStorage.find(row=>row.executionId==='partial-entry').qty,3,'raw partial entry retains its original three-contract quantity');
  const allRows = await records();
  assert.equal(allRows.filter(row=>row[9]==='已平仓').length,6,'closed row count');
  assert.equal(allRows.filter(row=>row[9]==='未配对').length,1,'open quantity remains visible');
  assert.equal(allRows.filter(row=>row[9]==='资料不全').length,2,'unknown records remain visible without pairing');
  assert.deepEqual(allRows.find(row=>row[3]==='RTY SEP26').slice(4,10),['做多','2','2300','—','—','未配对'],'unpaired row shows known entry only');
  assert.deepEqual(allRows.find(row=>row[3]==='YM SEP26').slice(4,10),['做多','1','40000','40010','—','已平仓'],'missing fee does not fabricate net profit despite known entry and exit');
  assert.deepEqual(allRows.find(row=>row[3]==='MES SEP26').slice(4,10),['方向未知','1','6500','—','—','资料不全'],'unknown side does not guess a direction or profit');
  assert.ok(await evaluate(`${statsText}.includes('1,718.00 USD') && ${statsText}.includes('6 个 FIFO 平仓批次')`),'statistics sum known paired net PnL and disclose missing data');
  await shot('paired-trades-overview');

  await setSelect('记录账户','Sim101'); await setSelect('记录合约','NQ SEP26');
  await assertCount(2,'partial entry merges with two independent exits');
  const partialRows = await records();
  assert.deepEqual(partialRows.map(row=>row.slice(4,10)),[['做多','2','100','105','190.00 USD','已平仓'],['做多','1','100','110','195.00 USD','已平仓']],'partial close quantities and allocated fees yield 190 and 195 USD');
  assert.ok(await evaluate(`${statsText}.includes('385.00 USD') && ${statsText}.includes('15.00 USD')`),'partial fills allocate the original entry fees once');
  await evaluate(`${historyTable}.querySelector('[data-trade-record] button').click()`);
  await until(`!!document.querySelector('[data-trade-detail-chart] canvas') && document.querySelector('[role="dialog"]')?.innerText.includes('K 线')`,'partial paired trade opens its price chart');
  const detailRows = await evaluate(`Array.from(document.querySelector('[role="dialog"] table.account-table').tBodies[0].rows).map(row=>Array.from(row.cells).map(cell=>cell.innerText))`);
  assert.equal(detailRows.length,1,'details contain only the selected allocation, not every exit of its shared entry');
  assert.equal(detailRows[0][2],'2','details preserve selected partial quantity');
  assert.ok(detailRows[0][0].includes('@ 100')&&detailRows[0][1].includes('@ 105')&&detailRows[0].at(-1)==='190.00 USD','detail prices and net profit match the selected row');
  await shot('paired-trades-partial-detail');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await until(`!document.querySelector('[role="dialog"]')`,'close paired details');
  const dates = await evaluate('window.__fixture.dates');
  await setDate('记录开始日期',dates[1]); await setDate('记录结束日期',dates[1]);
  await assertCount(2,'exit-day filter retains previous-day entry and midnight exit');
  assert.deepEqual(await records(),partialRows,'cross-day date filter does not re-pair truncated executions');
  assert.ok(await evaluate(`${statsText}.includes('385.00 USD') && ${statsText}.includes('15.00 USD')`),'cross-day statistics retain complete entry costs');
  await shot('paired-trades-cross-day');
  await setDate('记录开始日期',dates[0]); await setDate('记录结束日期',dates[0]);
  await assertCount(0,'entry-day-only range excludes trades closed on following day');
  await click('重置筛选');
  await setSelect('记录账户','Sim101'); await setSelect('记录合约','ES SEP26');
  await assertCount(2,'reversal has one short close and one later long close');
  assert.deepEqual((await records()).map(row=>row.slice(4,10)),[['做多','1','190','195','246.00 USD','已平仓'],['做空','2','200','190','992.00 USD','已平仓']],'reversal quantity and fees split between old short and new long');
  await click('重置筛选');
  await setSelect('记录账户组','Other Simulation'); await setSelect('记录合约','NQ SEP26');
  await assertCount(1,'second account remains independently filterable');
  assert.deepEqual((await records())[0].slice(2,10),['Sim102','NQ SEP26','做空','1','120','115','95.00 USD','已平仓'],'opposite executions from another account cannot match the first account');
  await click('重置筛选');
  assert.deepEqual(await storedExecutions(),originalStorage,'pairing, filters and details leave archived raw executions unchanged');
  await evaluate(`sessionStorage.setItem('fixture-offline','1')`);
  await send('Page.reload');
  await until(`!!document.querySelector('[aria-label="主导航"]')`,'offline navigation');
  await click('交易记录'); await assertCount(9,'offline reload recreates identical paired and unpaired records');
  await until(`document.body.innerText.includes('离线')`,'offline status');
  assert.deepEqual(await records(),allRows,'all pairing and residual presentation survives offline reload');
  assert.deepEqual(await storedExecutions(),originalStorage,'offline reload retains exact raw archive');
  await shot('paired-trades-offline');
  assert.equal(await evaluate(`sessionStorage.getItem('fixture-unexpected-post')`),null,'no bridge mutations attempted');
  assert.deepEqual(runtimeErrors,[],'browser runtime errors');
  assert.deepEqual(failedResources.filter(url=>!url.endsWith('/favicon.ico')),[],'required resources load');
  console.log('PASS paired trade browser: merged entry/exit/PnL columns; partial fills and proportional fees; selected allocation detail chart; shorts and reversals; account/symbol isolation; cross-day exit-date filtering; visible unpaired and unknown rows; missing net values; immutable raw archive and offline reconstruction; no bridge mutations');
} finally {
  ws?.close(); edge.kill(); server.close();
}
