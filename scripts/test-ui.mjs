// Isolated Edge + local fixtures. All bridge requests are intercepted; order mutations throw.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const root = path.resolve('app/dist');
const output = path.resolve('.tmp-webbridge');
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname === '/' ? '/index.html' : new URL(req.url, 'http://local').pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
  const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = 9500 + process.pid % 200;
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${path.join(output, `ui-profile-${Date.now()}`)}`, `--remote-debugging-port=${port}`, '--window-size=1500,950', 'about:blank',
], { stdio: 'ignore', windowsHide: true });
let ws;
const pause = ms => new Promise(r => setTimeout(r, ms));
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try { target = (await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json())).find(t => t.type === 'page'); } catch {}
    if (!target) await pause(200);
  }
  assert.ok(target, 'Edge debugging endpoint');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let seq = 0; const pending = new Map(); const errors = [];
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text + ': ' + message.params.exceptionDetails.exception?.description);
    if (pending.has(message.id)) { const p = pending.get(message.id); pending.delete(message.id); clearTimeout(p.timer); message.error ? p.reject(message.error) : p.resolve(message.result); }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expression, label) => {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await pause(200); }
    await shot('ui-failure');
    console.log('Runtime errors', errors);
    console.log('UI failure context', await evaluate(`({text:document.querySelector('iframe')?.contentDocument?.body.innerText.slice(-900),inputs:Array.from(document.querySelector('iframe')?.contentDocument?.querySelectorAll('input')||[]).map(e=>e.outerHTML)})`));
    throw new Error(`Timed out: ${label}`);
  };
  const click = text => evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)})?.click()`);
  const shot = async name => { await pause(200); const { data } = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(data, 'base64')); };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    localStorage.setItem('nt8-terminal-symbol','NQ SEP26');
    localStorage.setItem('nt8-terminal-show-trades','0');
    localStorage.setItem('nt8-terminal-status-pos',JSON.stringify({x:99999,y:99999}));
    localStorage.setItem('nt8-terminal-replay-pos',JSON.stringify({x:99999,y:99999}));
    window.__fixture = { pending: true, calls: [], offline: sessionStorage.getItem('fixture-offline') === '1' };
    // Non-five-minute fill time: 12:32:17 must return to the 12:32 bar after 5m -> 1m.
    window.__fixture.executionTime = Math.floor(Date.now()/300000)*300 - 1800 + 137;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.port !== '8090') return originalFetch(input, init);
      if (init?.method === 'POST') {
        sessionStorage.setItem('fixture-unexpected-post',JSON.stringify({url:url.href,body:init.body,phase:window.__fixture.phase,stack:new Error().stack}));
        throw new Error('UI test forbids order mutations');
      }
      if (window.__fixture.offline) throw new Error('fixture bridge offline');
      const q = url.searchParams; let data;
      window.__fixture.calls.push(url.pathname + url.search);
      const sym = {symbol:'NQ SEP26',name:'E-mini Nasdaq',tickSize:0.25,pointValue:20,type:'futures'};
      switch(url.pathname) {
        case '/api/status': data={connected:true,connectionName:'Test',historyWindowVersion:1,executionArchiveVersion:1};break;
        case '/api/symbols': data={symbols:[sym]};break;
        case '/api/resolve': data=sym;break;
        case '/api/accounts': data={accounts:[{name:'Sim101',connection:'Simulation',currency:'UsDollar',cashValue:100000,netLiquidation:100500,realizedPnl:230,unrealizedPnl:500},{name:'Test-02',connection:'Test Broker',currency:'USD',cashValue:50000,netLiquidation:49800,realizedPnl:-300,unrealizedPnl:-200}]};break;
        case '/api/positions': data={positions:[{instrument:'NQ SEP26',quantity:2,averagePrice:23987.5,marketPosition:'Long'}]};break;
        case '/api/orders': data={orders:window.__fixture.pending?[{orderId:'pending-123',instrument:'NQ SEP26',action:'Buy',orderType:'Limit',quantity:3,filled:0,limitPrice:23995,stopPrice:0,averageFillPrice:0,state:'Working',oco:'',name:'TV Entry',time:Math.floor(Date.now()/1000)}]:[]};break;
        case '/api/brackets': data={brackets:window.__fixture.pending?[{entryOrderId:'pending-123',instrument:'NQ SEP26',tp:24015,sl:23983}]:[]};break;
        case '/api/executions': {
          const paged=q.has('offset');
          const n = q.get('symbol') && q.get('symbol')!=='NQ SEP26' ? 0 : paged?231:12;
          const all=Array.from({length:n},(_,i)=>({executionId:'ex-'+i,orderId:'order-'+i,account:i<200?'Sim101':'Test-02',instrument:'NQ SEP26',time:window.__fixture.executionTime-i*(paged?60:600),timeMs:(window.__fixture.executionTime-i*(paged?60:600))*1000+456,price:24000+i%10,qty:1,side:i%2?'Sell':'Buy',commission:2.25,pointValue:20,currency:'USD'})).filter(e=>!q.get('account')||e.account===q.get('account'));
          const offset=Number(q.get('offset')||0); const limit=Number(q.get('limit')||200);
          data={executions:all.slice(offset,offset+limit),total:all.length,nextOffset:offset+limit<all.length?offset+limit:null,archive:{version:1,state:'ready',recordCount:all.length,pendingCount:0}};break;
        }
        case '/api/history': {
          const from=Number(q.get('from')),to=Math.min(Number(q.get('to')),Date.now()/1000),step=Number(q.get('interval'))||60;const bars=[];
          for(let t=Math.ceil(Math.max(from,to-86400*10)/step)*step;t<=to;t+=step){const p=24000+Math.sin(t/600)*15;bars.push({time:t,open:p-1,high:p+3,low:p-3,close:p,volume:100});}
          data={bars};break;
        }
        default: throw new Error('unexpected endpoint '+url.pathname);
      }
      return new Response(JSON.stringify(data), {status:200,headers:{'Content-Type':'application/json'}});
    };
    window.EventSource=class { constructor(){setTimeout(()=>this.onopen?.(),0);} close(){} };
  ` });
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await until(`!!window.__lastWidget && !!document.querySelector('[aria-label="主导航"]')`, 'terminal ready');
  const vendorVersion = JSON.parse(fs.readFileSync(path.join(root,'charting_library/package.json'),'utf8')).description;
  assert.equal(await evaluate(`window.TradingView.version()`), vendorVersion, 'runtime matches the packaged library version');
  assert.match(vendorVersion, /^CL v32\.1\.0 /, 'v32.1 upgrade is active');
  const labels = `(()=>{try{return window.__lastWidget.activeChart().getAllShapes().map(s=>window.__lastWidget.activeChart().getShapeById(s.id).getProperties().text||'')}catch{return []}})()`;
  await until(`(${labels}).filter(t=>t.startsWith('待成交')).length===2`, 'persistent TP/SL lines without hovering');
  await shot('pending-brackets');
  // Drag the search bar across the iframe, then verify its stored location survives reload.
  const grip = await evaluate(`(()=>{const r=document.querySelector('[aria-label="拖动合约搜索栏"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const beforeSearch = await evaluate(`(()=>{const r=document.querySelector('[data-symbol-search]').getBoundingClientRect();return {x:r.x,y:r.y}})()`);
  await send('Input.dispatchMouseEvent', { type:'mousePressed', x:grip.x, y:grip.y, button:'left', clickCount:1 });
  for(let i=1;i<=4;i++) await send('Input.dispatchMouseEvent', { type:'mouseMoved', x:grip.x+70*i/4, y:grip.y+180*i/4, button:'left', buttons:1 });
  await send('Input.dispatchMouseEvent', { type:'mouseReleased', x:grip.x+70, y:grip.y+180, button:'left', clickCount:1 });
  await until(`!!localStorage.getItem('nt8-terminal-symbol-search-pos')`, 'search position saved');
  await pause(150);
  const draggedSearch = await evaluate(`(()=>{const r=document.querySelector('[data-symbol-search]').getBoundingClientRect();return {x:r.x,y:r.y}})()`);
  assert.ok(Math.abs(draggedSearch.x-beforeSearch.x-70)<3 && Math.abs(draggedSearch.y-beforeSearch.y-180)<3, `search follows pointer over iframe: ${JSON.stringify({beforeSearch,draggedSearch,grip})}`);
  await send('Page.reload');
  await until(`!!window.__lastWidget && (${labels}).filter(t=>t.startsWith('待成交')).length===2`, 'reload after search drag');
  const restoredSearch = await evaluate(`(()=>{const r=document.querySelector('[data-symbol-search]').getBoundingClientRect();return {x:r.x,y:r.y}})()`);
  assert.ok(Math.abs(restoredSearch.x-draggedSearch.x)<3 && Math.abs(restoredSearch.y-draggedSearch.y)<3, 'search position restored');
  await evaluate(`document.querySelector('[aria-label="拖动合约搜索栏"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await until(`!localStorage.getItem('nt8-terminal-symbol-search-pos')`, 'search handle double click resets position');
  assert.ok(await evaluate(`(()=>{const e=document.querySelector('[aria-label="页面工具栏"]'),r=e.getBoundingClientRect();return r.top>=0 && r.bottom<=50 && r.right<=innerWidth && !!e.closest('nav')})()`), 'toolbar fixed at top right despite obsolete off-screen positions');
  await evaluate(`new Promise(r=>window.__lastWidget.activeChart().setResolution('5',r))`);
  await evaluate(`document.querySelector('[aria-label="显示交易历史"]').click()`);
  const historyShapes = `window.__lastWidget.activeChart().getAllShapes().filter(s=>s.name==='icon'||s.name==='trend_line'||s.name==='arrow_up'||s.name==='arrow_down')`;
  const collectHistory = `(${historyShapes}).map(s=>({id:s.id,name:s.name,points:window.__lastWidget.activeChart().getShapeById(s.id).getPoints(),props:window.__lastWidget.activeChart().getShapeById(s.id).getProperties()}))`;
  await until(`(${historyShapes}).length===18`, '12 small execution arrows and 6 FIFO connectors created');
  const fillTime = await evaluate(`window.__fixture.executionTime`);
  const assertHistory = async (seconds, previousIds = []) => {
    await until(`(${historyShapes}).length===18 && (${historyShapes}).every(s=>!${JSON.stringify(previousIds)}.includes(s.id))`, 'history rebuilt without duplicate or stale entities');
    const shapes = await evaluate(collectHistory);
    const markers = shapes.filter(s=>s.name==='icon').sort((a,b)=>b.points[0].time-a.points[0].time);
    assert.equal(markers.length,12,'every execution uses a scalable small icon');
    markers.forEach((s,i)=>{
      assert.equal(s.props.size,14,'14px icon frame (approximately 12px arrow)');
      assert.equal(s.props.icon,i%2?0xf063:0xf062,'sell points down and buy points up');
      assert.equal(s.props.color,i%2?'#ef5350':'#26a69a','buy green and sell red');
      assert.equal(s.props.angle,Math.PI/2,'upright arrow orientation');
      assert.equal(s.points[0].time,Math.floor((fillTime-i*600)/seconds)*seconds,'marker uses original fill time at current resolution');
      assert.equal(s.points[0].price,24000+i%10,'marker preserves exact execution price');
    });
    const connectors = shapes.filter(s=>s.name==='trend_line').sort((a,b)=>b.points[0].time-a.points[0].time);
    assert.equal(connectors.length,6,'FIFO connector count');
    connectors.forEach((s,i)=>s.points.forEach((p,j)=>{
      const executionIndex=i*2+1-j;
      assert.equal(p.time,Math.floor((fillTime-executionIndex*600)/seconds)*seconds,'connector endpoint uses original fill time');
      assert.equal(p.price,24000+executionIndex%10,'connector endpoint preserves execution price');
    }));
    return shapes.map(s=>s.id);
  };
  let historyIds = await assertHistory(300);
  assert.ok(await evaluate(`(${historyShapes}).every(s=>{const p=window.__lastWidget.activeChart().getShapeById(s.id).getProperties();return !p.text && p.showLabel!==true})`), 'execution arrows and connectors have no text');
  await shot('execution-arrows-5m');
  for (const resolution of ['1','5','1']) {
    await evaluate(`new Promise(r=>window.__lastWidget.activeChart().setResolution(${JSON.stringify(resolution)},r))`);
    historyIds = await assertHistory(Number(resolution)*60,historyIds);
  }
  await shot('execution-arrows');
  await evaluate(`document.querySelector('[aria-label="隐藏交易历史"]').click()`);
  await until(`(${historyShapes}).length===0`, 'history toggle removes arrows and connectors');
  await evaluate(`window.__lastWidget.activeChart().setResolution('5')`);
  await pause(800);
  await until(`(${labels}).filter(t=>t.startsWith('待成交')).length===2`, 'preview rebuild on interval change without duplicates');
  // Exercise the built-in layout UI. A custom drawing/color/study must survive
  // copying, loading another layout and reloading the browser.
  const tvDoc = `document.querySelector('iframe').contentDocument`;
  const layoutStore = `JSON.parse(localStorage.getItem('nt8-terminal-tv-layouts-v2'))`;
  const chartState = `new Promise(r=>window.__lastWidget.save(r))`;
  const tvMenu = async text => {
    await evaluate(`${tvDoc}.querySelector('[aria-label="管理布局"]').click()`);
    await until(`Array.from(${tvDoc}.querySelectorAll('span')).some(e=>e.textContent===${JSON.stringify(text)})`, 'native layout menu');
    await evaluate(`Array.from(${tvDoc}.querySelectorAll('span')).find(e=>e.textContent===${JSON.stringify(text)}).click()`);
  };
  const nameDialog = async name => {
    await until(`!!${tvDoc}.querySelector('input[maxlength="64"]')`, 'layout name dialog');
    await evaluate(`(()=>{const d=${tvDoc},input=d.querySelector('input[maxlength="64"]'),v=d.defaultView;Object.getOwnPropertyDescriptor(v.HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(name)});input.dispatchEvent(new v.Event('input',{bubbles:true}));})()`);
    await evaluate(`Array.from(${tvDoc}.querySelectorAll('button')).findLast(b=>['保存','复制','重命名'].includes(b.textContent.trim())).click()`);
    await until(`!${tvDoc}.querySelector('input[maxlength="64"]')`, 'layout name saved');
  };
  await evaluate(`window.__lastWidget.applyOverrides({'mainSeriesProperties.candleStyle.upColor':'#ff00aa','paneProperties.backgroundType':'solid','paneProperties.background':'#172333'})`);
  await evaluate(`window.__lastWidget.activeChart().createStudy('Relative Strength Index',false,false,{length:9})`);
  const drawingId = await evaluate(`window.__lastWidget.activeChart().createMultipointShape([{time:window.__fixture.executionTime,price:24020}],{shape:'horizontal_line',text:'Layout drawing A',overrides:{text:'Layout drawing A',linecolor:'#ff00aa'}})`);
  await evaluate(`new Promise((r,j)=>window.__lastWidget.saveChartToServer(r,j,{chartName:'Layout A'}))`);
  let originalLayout = await evaluate(`(${layoutStore}).charts.find(c=>c.name==='Layout A')`);
  assert.ok(originalLayout,'named layout saved');
  await evaluate(`window.__fixture.phase='copy'`);
  await tvMenu('复制…');
  await nameDialog('Layout B');
  await until(`(${layoutStore}).charts.length===2`, 'copy creates independent layout ID');
  // Copy can first save the source to attach its newly assigned ID.
  originalLayout = await evaluate(`(${layoutStore}).charts.find(c=>c.name==='Layout A')`);
  await evaluate(`window.__fixture.phase='edit-copy'`);
  await evaluate(`new Promise(r=>window.__lastWidget.activeChart().setResolution('15',r))`);
  await evaluate(`window.__lastWidget.activeChart().removeEntity(${JSON.stringify(drawingId)})`);
  await until(`(${layoutStore}).charts.some(c=>c.name==='Layout B'&&c.resolution==='15')`, 'autosave preserves copied layout name');
  assert.ok(await evaluate(`(${layoutStore}).charts.find(c=>c.id===${JSON.stringify(originalLayout.id)}).content`)===originalLayout.content,'editing copy does not overwrite original');
  await evaluate(`window.__fixture.phase='rename'`);
  await tvMenu('重命名…');
  await nameDialog('Layout B renamed');
  await until(`(${layoutStore}).charts.some(c=>c.name==='Layout B renamed')`, 'native rename persists');
  await click('草稿');
  await evaluate(`(()=>{for(const [placeholder,value] of [['如 100','100'],['如 50','50']]){const input=document.querySelector('input[placeholder="'+placeholder+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
  await until(`(${labels}).filter(t=>t.startsWith('草稿止')).length===2`, 'draft protections before layout load');
  await evaluate(`window.__fixture.phase='load-original'`);
  await tvMenu('打开布局…');
  await until(`${tvDoc}.querySelectorAll('[data-name="load-chart-dialog-item"]').length===2`, 'native load list contains two named layouts');
  await shot('saved-layouts');
  await evaluate(`window.__layoutFinished=false;window.__lastWidget.subscribe('chart_loaded',()=>{window.__layoutFinished=true});Array.from(${tvDoc}.querySelectorAll('[data-name="list-item-title"]')).find(e=>e.textContent==='Layout A').click()`);
  await until(`window.__layoutFinished && window.__lastWidget.activeChart().resolution()==='5'`, 'native load restores original period');
  await until(`(${labels}).includes('Layout drawing A') && (${labels}).filter(t=>t.startsWith('待成交')).length===2`, 'layout load restores drawings and pending protection lines');
  await until(`(${labels}).filter(t=>t.startsWith('草稿止')).length===2`, 'loading layout preserves draft inputs and rebuilds their lines');
  assert.equal(await evaluate(`document.querySelector('input[placeholder="如 100"]').value`),'100','layout replacement does not clear draft amount');
  await until(`(${layoutStore}).lastOpenedId===${JSON.stringify(originalLayout.id)}`, 'remember opened layout without overwriting another');
  assert.equal(await evaluate(`sessionStorage.getItem('fixture-unexpected-post')`),null,'loading a layout never cancels or modifies real orders');
  await send('Page.reload');
  await until(`!!window.__lastWidget && (${labels}).includes('Layout drawing A')`, 'reload restores last opened layout, including drawing');
  assert.equal(await evaluate(`window.__lastWidget.activeChart().resolution()`),'5','saved period restored');
  const restoredLayoutState = await evaluate(chartState);
  const restoredMain = restoredLayoutState.charts[0].panes.flatMap(p=>p.sources).find(s=>s.type==='MainSeries');
  assert.equal(restoredMain.state.candleStyle.upColor,'#ff00aa','restored theme does not overwrite custom candle color');
  assert.ok(restoredLayoutState.charts[0].panes.flatMap(p=>p.sources).some(s=>s.state?.inputs?.length===9),'saved indicator parameters restored');
  await evaluate(`new Promise(r=>window.__lastWidget.activeChart().setResolution('1',r))`);
  await until(`(${layoutStore}).charts.find(c=>c.id===${JSON.stringify(originalLayout.id)}).resolution==='1'`, 'autosave subscriptions work after native load and reload');
  assert.equal(await evaluate(`(${layoutStore}).charts.find(c=>c.name==='Layout B renamed').resolution`),'15','second layout remains independent');
  await shot('restored-layout');
  await evaluate('window.__fixture.pending=false');
  await until(`(${labels}).filter(t=>t.startsWith('待成交')).length===0`, 'preview removed after parent disappears');
  await click('账户总览');
  await until(`document.querySelector('h1')?.textContent==='账户总览' && document.body.innerText.includes('100,500.00 USD')`, 'overview financial cards');
  assert.equal(await evaluate(`document.querySelector('[aria-label="页面账户"]')`), null, 'overview has no account selector');
  assert.ok(await evaluate(`!document.body.innerText.includes('UsDollar') && document.querySelectorAll('[aria-label^="账户分组 "]').length===2`), 'accounts grouped by connection with standard USD');
  await shot('account-overview');
  await click('列表');
  await until(`document.querySelector('[aria-label="列表模式"]').getAttribute('aria-pressed')==='true' && document.querySelectorAll('table.account-table').length===2`, 'grouped list mode');
  await shot('account-overview-list');
  await click('卡片');
  assert.ok(await evaluate(`document.elementFromPoint(innerWidth-85,24)?.closest('[aria-label="页面工具栏"]')!==null`), 'toolbar remains accessible on overview');
  await evaluate(`document.querySelector('[aria-label="切换为白天模式"]').click()`);
  await until(`document.documentElement.classList.contains('theme-light')`, 'day theme from global toolbar');
  await shot('account-overview-light');
  await evaluate(`document.querySelector('[aria-label="切换为黑夜模式"]').click()`);
  await click('交易记录');
  const detailCount = `document.querySelectorAll('[aria-label^="查看交易详情 "]').length`;
  await until(`document.body.innerText.includes('共 116 笔交易') && (${detailCount})===100`, 'archive all accounts, first page of 115 paired trades and one unpaired remainder');
  assert.equal(await evaluate(`document.querySelector('[aria-label="记录账户"]').value`), '', 'records default to all accounts');
  assert.ok(await evaluate(`document.querySelector('[aria-label="交易表现统计"]').innerText.includes('116 笔交易')`), 'statistics include all pages');
  await click('下一页'); await until(`document.body.innerText.includes('第 2 / 2 页') && (${detailCount})===16`, 'paired trade second page');
  await shot('execution-records');
  await evaluate(`(()=>{const input=document.querySelector('[aria-label="记录账户"]');input.value='Test-02';input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(`document.body.innerText.includes('共 16 笔交易') && (${detailCount})===16`, 'account filter preserves 15 closed pairs and one unpaired remainder');
  await evaluate(`document.querySelector('[aria-label^="查看交易详情 "]').click()`);
  await until(`!!document.querySelector('[data-trade-detail-chart] canvas') && document.querySelector('[role="dialog"]').innerText.includes('K 线')`, 'trade chart details');
  await shot('trade-details');
  await send('Input.dispatchKeyEvent', { type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
  await send('Input.dispatchKeyEvent', { type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27 });
  await until(`!document.querySelector('[role="dialog"]')`, 'close details');
  await click('重置筛选');
  await click('交易图表');
  assert.equal(await evaluate(`document.querySelectorAll('iframe').length`), 1, 'navigation preserves chart iframe');
  assert.equal(await evaluate(`document.querySelectorAll('[aria-label="交易面板页面"] [role="tab"]').length`), 0, 'sidebar tabs replaced by independent panels');
  assert.ok(await evaluate(`!!document.querySelector('#trading-page-trade') && !!document.querySelector('#trading-page-accounts')`), 'independent trading and account panels remain available');
  await click('回放模拟');
  await until(`!!document.querySelector('[aria-label="回放模拟工作台"]')`, 'replay dashboard');
  await shot('replay-dashboard');
  await click('创建并开始');
  await until(`!!window.__replay?.status().active && !!window.__lastWidget && window.__tvDatafeed?.getLastPrice('NQ SEP26')>0`, 'new replay session loads historical prices');
  const sessionRows = `Object.keys(localStorage).filter(k=>k.startsWith('nt8-terminal-replay-session-v1:')).map(k=>JSON.parse(localStorage.getItem(k)))`;
  const firstId = await evaluate(`(${sessionRows})[0].id`);
  const cursorBefore = await evaluate(`window.__replay.status().cursor`);
  await click('单步推进');
  await until(`window.__replay.status().cursor>${cursorBefore}`, 'replay step advances cursor');
  await click('播放');
  await until(`document.querySelector('[data-replay-panel]').innerText.includes('播放中')`, 'replay plays');
  await click('暂停');
  await until(`document.querySelector('[data-replay-panel]').innerText.includes('已暂停')`, 'replay pauses');
  await evaluate(`(()=>{const button=document.querySelector('[aria-label="交易面板"]');if(button.getAttribute('aria-pressed')!=='true')button.click()})()`);
  await until(`document.querySelector('#trading-page-trade')?.innerText.includes('SIM-REPLAY')`, 'replay simulation remains available in trading panel');
  await evaluate(`window.__trading.placeOrder({account:'SIM-REPLAY',symbol:'NQ SEP26',action:'BUY',orderType:'MARKET',quantity:2})`);
  await evaluate(`window.__trading.closePosition('SIM-REPLAY','NQ SEP26')`);
  await evaluate(`window.__trading.placeOrder({account:'SIM-REPLAY',symbol:'NQ SEP26',action:'BUY',orderType:'LIMIT',quantity:1,limitPrice:1})`);
  await evaluate(`window.__trading.placeOrder({account:'SIM-REPLAY',symbol:'NQ SEP26',action:'BUY',orderType:'MARKET',quantity:1})`);
  await until(`(${sessionRows}).find(s=>s.id===${JSON.stringify(firstId)}).state.executions.length===3`, 'each simulated fill immediately persisted');
  const savedFirst = await evaluate(`(${sessionRows}).find(s=>s.id===${JSON.stringify(firstId)})`);
  assert.equal(savedFirst.state.orders.length,1,'pending order saved');
  assert.equal(savedFirst.state.positions[0].quantity,1,'open position saved');
  await shot('replay-active');
  await send('Page.reload');
  await until(`!!window.__replay && !window.__replay.status().active`, 'reload starts in live mode');
  await click('回放模拟');
  await until(`document.querySelectorAll('[data-replay-session]').length===1`, 'saved session survives reload');
  await click('表现与记录');
  await until(`document.querySelector('[aria-label="交易表现统计"]')?.innerText.includes('2 笔交易')`, 'session performance and paired executions');
  await shot('replay-session-performance');
  await click('继续回放');
  await until(`window.__replay.status().active && window.__tvDatafeed.getLastPrice('NQ SEP26')>0`, 'resume session');
  assert.equal(await evaluate(`window.__replay.status().cursor`),savedFirst.cursor,'resume exact cursor');
  assert.equal(await evaluate(`window.__trading.getPositions('SIM-REPLAY').then(r=>r.positions[0].quantity)`),1,'resume open position');
  assert.equal(await evaluate(`window.__trading.getOrders('SIM-REPLAY').then(r=>r.orders.length)`),1,'resume pending order');
  await click('保存并返回会话列表');
  await until(`!window.__replay.status().active && !!document.querySelector('[aria-label="回放模拟工作台"]')`, 'save and leave replay');
  await click('创建并开始');
  await until(`window.__replay.status().active && window.__tvDatafeed.getLastPrice('NQ SEP26')>0`, 'second independent session');
  assert.equal(await evaluate(`window.__trading.getPositions('SIM-REPLAY').then(r=>r.positions.length)`),0,'new session starts flat');
  assert.equal(await evaluate(`window.__trading.getOrders('SIM-REPLAY').then(r=>r.orders.length)`),0,'new session has no previous orders');
  await click('账户总览');
  await until(`!window.__replay.status().active && document.body.innerText.includes('100,500.00 USD')`, 'leaving replay restores actual account overview');
  await click('回放模拟');
  await until(`document.querySelectorAll('[data-replay-session]').length===2`, 'both saved sessions available for deletion');
  const otherSession = await evaluate(`(${sessionRows}).find(s=>s.id!==${JSON.stringify(firstId)})`);
  const otherSnapshot = await evaluate(`localStorage.getItem('nt8-terminal-replay-session-v1:'+${JSON.stringify(otherSession.id)})`);
  const firstCard = `document.querySelector('[data-replay-session="${firstId}"]')`;
  await evaluate(`Array.from(${firstCard}.querySelectorAll('button')).find(b=>b.textContent.trim()==='表现与记录').click()`);
  await until(`document.querySelector('[aria-label="交易表现统计"]')?.innerText.includes('2 笔交易')`, 'open old session details before deletion');
  await evaluate(`${firstCard}.querySelector('[aria-label^="删除回放会话 "]').click()`);
  await until(`!!document.querySelector('[role="alertdialog"]')`, 'session deletion confirmation');
  await shot('replay-delete-confirmation');
  await click('取消');
  assert.equal(await evaluate(`document.querySelectorAll('[data-replay-session]').length`),2,'cancel preserves both sessions');
  await evaluate(`${firstCard}.querySelector('[aria-label^="删除回放会话 "]').click()`);
  // A denied localStorage removal must keep both the session and its confirmation open.
  await evaluate(`(()=>{const remove=Storage.prototype.removeItem;Storage.prototype.removeItem=function(key){if(key==='nt8-terminal-replay-session-v1:'+${JSON.stringify(firstId)})throw new Error('fixture deletion denied');return remove.call(this,key)};window.__restoreStorageRemove=()=>{Storage.prototype.removeItem=remove;};})()`);
  await click('删除会话');
  await until(`document.querySelector('[role="alertdialog"] [role="alert"]')?.textContent.includes('删除失败')`, 'deletion error is visible and retryable');
  assert.equal(await evaluate(`document.querySelectorAll('[data-replay-session]').length`),2,'failed delete keeps card and data');
  await evaluate(`window.__restoreStorageRemove()`);
  await click('删除会话');
  await until(`!document.querySelector('[role="alertdialog"]') && document.querySelectorAll('[data-replay-session]').length===1`, 'confirmed deletion removes exactly one card');
  assert.equal(await evaluate(`localStorage.getItem('nt8-terminal-replay-session-v1:'+${JSON.stringify(firstId)})`),null,'entire deleted session snapshot removed');
  assert.equal(await evaluate(`document.querySelector('[aria-label="交易表现统计"]')`),null,'deleted session details closed');
  assert.equal(await evaluate(`localStorage.getItem('nt8-terminal-replay-session-v1:'+${JSON.stringify(otherSession.id)})`),otherSnapshot,'other session remains unchanged');
  await send('Page.reload');
  await until(`!!window.__replay && !window.__replay.status().active`, 'reload after session deletion');
  await click('回放模拟');
  await until(`document.querySelectorAll('[data-replay-session]').length===1`, 'deleted session stays deleted after reload');
  assert.equal(await evaluate(`document.querySelector('[data-replay-session]').getAttribute('data-replay-session')`),otherSession.id,'remaining session can still be selected');
  await evaluate(`document.querySelector('[aria-label^="删除回放会话 "]').click()`);
  await click('删除会话');
  await until(`document.querySelectorAll('[data-replay-session]').length===0 && document.body.innerText.includes('尚无回放会话')`, 'deleting last session restores empty dashboard');
  await shot('replay-sessions-deleted');
  await evaluate(`sessionStorage.setItem('fixture-offline','1')`);
  await send('Page.reload');
  await until(`!!document.querySelector('[aria-label="主导航"]')`, 'offline reload');
  await click('交易记录');
  await until(`document.body.innerText.includes('共 116 笔交易') && document.body.innerText.includes('离线')`, 'IndexedDB archive survives offline reload and restores paired records');
  await shot('execution-records-offline');
  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log('PASS browser: drag/toolbar/small arrows/5m-to-1m execution and connector timestamps/previews; native layouts save/copy/rename/load/refresh/colors/studies/drawings/order isolation; grouped cards/list/USD; all-account archive/filter/pagination/stats/detail chart/offline reload; replay dashboard/create/fill/step/play/pause/persistence/resume/isolation/exit/delete/cancel/delete failure/reload/empty state');
} finally {
  ws?.close(); edge.kill(); server.close();
}
