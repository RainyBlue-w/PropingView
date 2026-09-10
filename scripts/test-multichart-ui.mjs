// Isolated Edge with local fixtures. Bridge requests never leave the fixture;
// only two explicitly expected UI actions receive mocked mutation responses.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const root = path.resolve('app/dist');
const output = path.resolve('.tmp-webbridge');
fs.mkdirSync(output, { recursive: true });
const symbols = ['NQ SEP26', 'ES SEP26', 'YM SEP26', 'RTY SEP26'];
const prices = [24000, 6500, 44000, 2300];
const resolutions = ['1', '5', '15', '60'];
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
const debugPort = 9800 + process.pid % 150;
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${path.join(output, `multichart-profile-${Date.now()}`)}`,
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
    if (message.method === 'Runtime.exceptionThrown') {
      runtimeErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    }
    if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) {
      failedResources.push(`${message.params.response.status} ${message.params.response.url}`);
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
  const shot = async name => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(output, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const until = async (expression, label) => {
    // A reload/replay transition can leave a debug reference to the disposed widget
    // briefly visible. Readiness predicates retry; application exceptions are still
    // collected independently by Runtime.exceptionThrown and asserted below.
    for (let i = 0; i < 120; i++) { if (await evaluate(`(()=>{try{return (${expression})}catch{return false}})()`)) return; await pause(200); }
    await shot('multichart-failure');
    console.log('Multichart failure context', await evaluate(`({text:document.body.innerText.slice(-2000),panes:Array.from(document.querySelectorAll('[data-chart-pane]')).map(p=>({id:p.dataset.chartPane,active:p.dataset.active,hidden:p.hidden,text:p.innerText.slice(0,150)})),post:sessionStorage.getItem('fixture-unexpected-post')})`));
    throw new Error(`Timed out: ${label}`);
  };
  const click = label => evaluate(`document.querySelector('button[aria-label=${JSON.stringify(label)}]')?.click()`);
  const clickText = label => evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)})?.click()`);
  const visiblePaneCount = `Array.from(document.querySelectorAll('[data-chart-pane]')).filter(p=>p.getBoundingClientRect().width>0).length`;
  const workspaceWidth = () => evaluate(`document.querySelector('[data-chart-workspace]').getBoundingClientRect().width`);
  const panelVisible = id => `document.getElementById(${JSON.stringify(id)})?.getBoundingClientRect().width>0`;
  const setInput = (selector, value) => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});if(!input)throw new Error('Missing input: '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const activate = async (index, expectedSymbol = symbols[index - 1]) => {
    await until(`!!document.querySelector('button[aria-label="选择图表 ${index}"]') && !document.querySelector('button[aria-label="选择图表 ${index}"]').disabled`, `chart ${index} ready for selection`);
    await click(`选择图表 ${index}`);
    await until(`document.querySelector('[data-chart-pane="${index}"]')?.dataset.active==='true' && window.__lastWidget?.activeChart().symbol()===${JSON.stringify(expectedSymbol)}`, `activate chart ${index}`);
    await evaluate(`window.__testWidgets??=[];window.__testWidgets[${index - 1}]=window.__lastWidget;true`);
  };
  const chartState = () => evaluate(`window.__testWidgets.map(w=>({symbol:w.activeChart().symbol(),resolution:w.activeChart().resolution(),theme:w.getTheme().toLowerCase()}))`);
  const assertBars = async (index, price) => {
    const bars = await evaluate(`(async()=>{const c=window.__testWidgets[${index - 1}].activeChart();await c.dataReady();const d=await c.exportData({includeTime:false,includeUserTime:false,includeSeries:true,includedStudies:[]});return {schema:d.schema,rows:d.data.slice(-20).map(row=>Array.from(row))};})()`);
    assert.ok(bars.rows.length >= 5, `chart ${index} has real chart series bars: ${JSON.stringify(bars.schema)}`);
    for (const row of bars.rows) {
      assert.ok(row.length >= 4 && row.slice(0, 4).every(value => typeof value === 'number' && Math.abs(value - price) < 30), `chart ${index} keeps its own ${price} price series: ${JSON.stringify(row)}`);
    }
  };

  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
    if(window.top!==window)return;
    if(!sessionStorage.getItem('multichart-fixture-initialized')){
      for(const [key,value] of Object.entries({'symbol':'NQ SEP26','interval':'1','chart-count':'1','theme':'dark','show-trades':'0','trading-panel-open':'1','account-panel-open':'1','panel-width':'300'}))localStorage.setItem('nt8-terminal-'+key,value);
      sessionStorage.setItem('multichart-fixture-initialized','1');
      sessionStorage.setItem('multichart-fixture-time',String(Math.floor(Date.now()/60000)*60));
    }
    const names=${JSON.stringify(symbols)},prices=${JSON.stringify(prices)};
    const instruments=names.map((symbol,i)=>({symbol,name:['E-mini Nasdaq','E-mini S&P 500','E-mini Dow','E-mini Russell'][i],tickSize:[0.25,0.25,1,0.1][i],pointValue:[20,50,5,50][i],type:'futures'}));
    window.__fixture={calls:[],mutations:[],time:Number(sessionStorage.getItem('multichart-fixture-time')),esClosed:false,esCancelled:false};
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      if(url.port!=='8090')return originalFetch(input,init);
      const method=(init?.method||input?.method||'GET').toUpperCase();
      if(method!=='GET'){
        const body=JSON.parse(init?.body||'null');
        const expected=window.__fixture.expectedMutation;
        if(method==='POST'&&expected&&url.pathname===expected.path&&JSON.stringify(body)===JSON.stringify(expected.body)){
          window.__fixture.mutations.push({path:url.pathname,body});
          window.__fixture.expectedMutation=null;
          if(url.pathname==='/api/position/close')window.__fixture.esClosed=true;
          if(url.pathname==='/api/order/cancel')window.__fixture.esCancelled=true;
          return new Response(JSON.stringify({ok:true}),{status:200,headers:{'Content-Type':'application/json'}});
        }
        sessionStorage.setItem('fixture-unexpected-post',JSON.stringify({url:url.href,method,body:init?.body}));
        throw new Error('Multichart test forbids bridge mutations');
      }
      window.__fixture.calls.push(url.pathname+url.search);
      const q=url.searchParams;let data;
      switch(url.pathname){
        case '/api/status':data={connected:true,connectionName:'Multi-chart fixture',historyWindowVersion:1,executionArchiveVersion:1};break;
        case '/api/symbols':data={symbols:instruments};break;
        case '/api/resolve':data=instruments.find(s=>s.symbol===q.get('symbol'));if(!data)throw new Error('Unknown fixture symbol '+q.get('symbol'));break;
        case '/api/accounts':data={accounts:[{name:'Sim101',connection:'Simulation',currency:'UsDollar',cashValue:100000,netLiquidation:100500,realizedPnl:230,unrealizedPnl:500},{name:'Fixture-02',connection:'Test Broker',currency:'USD',cashValue:50000,netLiquidation:49800,realizedPnl:-300,unrealizedPnl:-200}]};break;
        case '/api/positions':data={positions:q.get('account')==='Sim101'?[
          {instrument:'NQ SEP26',quantity:2,averagePrice:23987.5,marketPosition:'Long'},
          ...(!window.__fixture.esClosed?[{instrument:'ES SEP26',quantity:-3,averagePrice:6500.125,marketPosition:'Short'}]:[]),
        ]:[]};break;
        case '/api/orders':data={orders:q.get('account')==='Sim101'?[
          {orderId:'fixture-nq-order',instrument:'NQ SEP26',action:'Buy',orderType:'Limit',quantity:1,filled:0,limitPrice:23900,stopPrice:0,averageFillPrice:0,state:'Working',oco:'',name:'TV Entry',time:window.__fixture.time},
          ...(!window.__fixture.esCancelled?[{orderId:'fixture-es-order',instrument:'ES SEP26',action:'Sell',orderType:'StopMarket',quantity:3,filled:0,limitPrice:0,stopPrice:6600.125,averageFillPrice:0,state:'Working',oco:'',name:'TV Entry',time:window.__fixture.time}]:[]),
          {orderId:'fixture-filled-order',instrument:'YM SEP26',action:'Buy',orderType:'Market',quantity:1,filled:1,limitPrice:0,stopPrice:0,averageFillPrice:44000,state:'Filled',oco:'',name:'Old filled',time:window.__fixture.time},
        ]:[]};break;
        case '/api/brackets':data={brackets:[]};break;
        case '/api/executions':data={executions:[],total:0,nextOffset:null,archive:{version:1,state:'ready',recordCount:0,pendingCount:0}};break;
        case '/api/history':{
          const index=names.indexOf(q.get('symbol'));if(index<0)throw new Error('Unknown history symbol');
          const from=Number(q.get('from')),to=Math.min(Number(q.get('to')),window.__fixture.time),step=Number(q.get('interval'))||60,bars=[];
          for(let t=Math.ceil(Math.max(from,to-864000)/step)*step;t<=to;t+=step){const p=prices[index]+Math.sin(t/600)*12;bars.push({time:t,open:p-1,high:p+3,low:p-3,close:p,volume:100+index*10});}
          data={bars};break;
        }
        default:throw new Error('Unexpected fixture endpoint '+url.pathname);
      }
      return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
    };
    window.EventSource=class{constructor(){setTimeout(()=>this.onopen?.(),0);}close(){}};
  })();` });
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await until(`!!window.__lastWidget && !!document.querySelector('[aria-label="主导航"]') && ${visiblePaneCount}===1`, 'single chart initial ready');
  await evaluate(`new Promise(resolve=>window.__lastWidget.onChartReady(resolve))`);
  await until(`document.querySelector('#trading-page-trade')?.innerText.includes('下单 · NQ SEP26') && window.__tvDatafeed?.getLastPrice('NQ SEP26')>23000`, 'initial selected chart and market data bound to ticket');

  // The selected account panel shows every instrument, independently of the active chart.
  await until(`document.querySelectorAll('[data-position-instrument]').length===2 && document.querySelectorAll('[data-order-id]').length===2`, 'all instrument positions and working orders visible');
  const tradeText = await evaluate(`document.querySelector('#trading-page-trade').innerText`);
  assert.ok(tradeText.includes('所有持仓') && tradeText.includes('所有工作中订单') && !tradeText.includes('当前合约持仓'), 'headings describe all instruments');
  assert.ok(await evaluate(`document.querySelector('[data-position-instrument="ES SEP26"]').innerText.includes('6500.125') && document.querySelector('[data-order-id="fixture-es-order"]').innerText.includes('6600.125')`), 'non-active instrument prices retain their own precision');
  assert.equal(await evaluate(`document.querySelector('[data-order-id="fixture-filled-order"]')`), null, 'filled orders excluded from working orders');
  await shot('multichart-all-instrument-positions-orders');
  await evaluate(`window.__fixture.expectedMutation={path:'/api/position/close',body:{account:'Sim101',symbol:'ES SEP26'}}`);
  await click('市价平仓 ES SEP26');
  await until(`window.__fixture.esClosed && !document.querySelector('[data-position-instrument="ES SEP26"]')`, 'closing ES from NQ chart removes only the ES position');
  assert.ok(await evaluate(`!!document.querySelector('[data-position-instrument="NQ SEP26"]') && window.__lastWidget.activeChart().symbol()==='NQ SEP26'`), 'NQ position and active chart unchanged by ES close');
  await evaluate(`window.__fixture.expectedMutation={path:'/api/order/cancel',body:{account:'Sim101',orderId:'fixture-es-order'}}`);
  await click('撤销 ES SEP26 订单 fixture-es-order');
  await until(`window.__fixture.esCancelled && !document.querySelector('[data-order-id="fixture-es-order"]')`, 'cancel targets ES order ID');
  assert.ok(await evaluate(`!!document.querySelector('[data-order-id="fixture-nq-order"]')`), 'other working order preserved');
  assert.deepEqual(await evaluate(`window.__fixture.mutations`), [
    {path:'/api/position/close',body:{account:'Sim101',symbol:'ES SEP26'}},
    {path:'/api/order/cancel',body:{account:'Sim101',orderId:'fixture-es-order'}},
  ], 'only exact fixture close and cancel actions were requested');

  // Two independent full-height columns; closing either keeps the other column and ticket state.
  await until(`${panelVisible('trading-page-trade')} && ${panelVisible('trading-page-accounts')}`, 'both side panels visible');
  const geometry = await evaluate(`(()=>{const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right}};return {trade:rect('trading-page-trade'),accounts:rect('trading-page-accounts'),tradeHeading:rect('trading-panel-heading'),accountHeading:rect('account-panel-heading')};})()`);
  assert.ok(Math.abs(geometry.tradeHeading.y - geometry.accountHeading.y) < 2, 'panel headers share the same row');
  assert.ok(geometry.accounts.x >= geometry.trade.right && Math.abs(geometry.trade.height - geometry.accounts.height) < 2, 'panels are separate horizontal columns');
  assert.ok(geometry.trade.width >= 290 && geometry.accounts.width >= 290, 'each panel preserves a usable original width');
  const narrowChartWidth = await workspaceWidth();
  const optionalPrice = '#trading-page-trade input[placeholder="成交后自动挂"]';
  await setInput(optionalPrice, '24020');
  await click('关闭交易面板');
  await until(`!(${panelVisible('trading-page-trade')}) && ${panelVisible('trading-page-accounts')}`, 'close trading independently');
  const onePanelChartWidth = await workspaceWidth();
  assert.ok(onePanelChartWidth > narrowChartWidth + 250, 'closing one panel returns one column to charts');
  await click('交易面板');
  await until(panelVisible('trading-page-trade'), 'reopen trading');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(optionalPrice)}).value`), '24020', 'absolute TP price survives hiding panel');
  await click('账户信息');
  await until(`!(${panelVisible('trading-page-accounts')}) && ${panelVisible('trading-page-trade')}`, 'account toggle closes independently');
  await click('交易面板');
  await until(`!(${panelVisible('trading-page-accounts')}) && !(${panelVisible('trading-page-trade')})`, 'both side panels closed');
  assert.ok(await workspaceWidth() > onePanelChartWidth + 250, 'closing both expands chart to full workspace');
  await click('交易面板'); await click('账户信息');
  await until(`${panelVisible('trading-page-trade')} && ${panelVisible('trading-page-accounts')}`, 'restore both side panels');
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(optionalPrice)}).value`), '24020', 'ticket survives hiding the entire sidebar');

  await click('双图');
  await until(`${visiblePaneCount}===2 && document.querySelectorAll('[data-chart-pane] iframe').length===2`, 'two chart grid');
  await activate(1); await activate(2);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(optionalPrice)}).value`), '', 'switching to a different symbol clears old absolute TP');
  await click('四图');
  await until(`${visiblePaneCount}===4 && document.querySelectorAll('[data-chart-pane] iframe').length===4`, 'four chart grid');
  for (let i = 1; i <= 4; i++) { await activate(i); await assertBars(i, prices[i - 1]); }
  assert.deepEqual((await chartState()).map(s => s.symbol), symbols, 'four chart symbols are independent');

  // A real pointer interaction within the iframe must select its chart for the shared ticket.
  await activate(1);
  const point = await evaluate(`(()=>{const r=document.querySelector('[data-chart-pane="3"] iframe').getBoundingClientRect();return {x:r.x+r.width*0.6,y:r.y+r.height*0.6};})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  await until(`document.querySelector('[data-chart-pane="3"]').dataset.active==='true' && window.__lastWidget===window.__testWidgets[2]`, 'iframe pointer selects corresponding shared ticket widget');

  // Search changes only the selected chart; return to four different symbols afterwards.
  const chooseSymbol = async symbol => {
    await setInput('input[placeholder="搜索合约…"]', symbol);
    await until(`Array.from(document.querySelectorAll('[data-symbol-search] span')).some(e=>e.textContent===${JSON.stringify(symbol)})`, 'search result loaded');
    await evaluate(`Array.from(document.querySelectorAll('[data-symbol-search] span')).find(e=>e.textContent===${JSON.stringify(symbol)}).parentElement.click()`);
    await until(`window.__lastWidget.activeChart().symbol()===${JSON.stringify(symbol)}`, 'search updates selected chart');
  };
  await chooseSymbol('RTY SEP26');
  assert.deepEqual((await chartState()).map(s => s.symbol), ['NQ SEP26', 'ES SEP26', 'RTY SEP26', 'RTY SEP26'], 'search leaves all other symbols unchanged');
  await chooseSymbol('YM SEP26');
  for (let i = 0; i < 4; i++) {
    await evaluate(`new Promise(resolve=>window.__testWidgets[${i}].activeChart().setResolution(${JSON.stringify(resolutions[i])},resolve))`);
    await assertBars(i + 1, prices[i]);
  }
  assert.deepEqual((await chartState()).map(s => s.resolution), resolutions, 'each chart has its own resolution');

  // Persist four distinct native layouts and drawings to four independent storage scopes.
  await evaluate('window.__testDrawingIds=[]');
  for (let i = 0; i < 4; i++) {
    const name = `Fixture pane ${i + 1}`;
    const drawing = await evaluate(`window.__testWidgets[${i}].activeChart().createMultipointShape([{time:window.__fixture.time-7200,price:${prices[i] + 2}}],{shape:'horizontal_line',text:${JSON.stringify(name)},overrides:{text:${JSON.stringify(name)},linecolor:'#ff00aa'}})`);
    await evaluate(`window.__testDrawingIds[${i}]=${JSON.stringify(drawing)};true`);
    await evaluate(`new Promise((resolve,reject)=>window.__testWidgets[${i}].saveChartToServer(resolve,reject,{chartName:${JSON.stringify(name)}}))`);
    const key = `nt8-terminal-tv-layouts-v2${i ? `:pane:chart-${i + 1}` : ''}`;
    await until(`JSON.parse(localStorage.getItem(${JSON.stringify(key)})||'null')?.charts.some(c=>c.name===${JSON.stringify(name)}&&c.symbol===${JSON.stringify(symbols[i])}&&c.resolution===${JSON.stringify(resolutions[i])})`, `layout scope ${i + 1} saved`);
  }
  await click('切换为白天模式');
  await until(`window.__testWidgets.every(w=>w.getTheme().toLowerCase()==='light')`, 'light theme applied to every pane');
  await shot('multichart-four-panels-light');
  await click('切换为黑夜模式');
  await until(`window.__testWidgets.every(w=>w.getTheme().toLowerCase()==='dark')`, 'dark theme applied to every pane');

  // Grid reduction must keep opened widgets and unsaved drawings alive.
  await evaluate(`window.__testOriginalWidgets=window.__testWidgets.slice();true`);
  await click('单图');
  await until(`${visiblePaneCount}===1`, 'reduce grid to one visible chart');
  assert.equal(await evaluate(`document.querySelectorAll('[data-chart-pane] iframe').length`), 4, 'hidden chart widgets remain mounted');
  await click('双图'); await until(`${visiblePaneCount}===2`, 'expand grid to two');
  await click('四图'); await until(`${visiblePaneCount}===4`, 'restore four charts');
  for (let i = 1; i <= 4; i++) await activate(i);
  assert.ok(await evaluate(`window.__testWidgets.every((w,i)=>w===window.__testOriginalWidgets[i]&&w.activeChart().getAllShapes().some(s=>s.id===window.__testDrawingIds[i]))`), 're-expansion preserves widget identity and exact drawing entities');
  await activate(3);
  await shot('multichart-four-panels-dark');

  await send('Page.reload');
  await until(`!!window.__lastWidget && ${visiblePaneCount}===4 && document.querySelector('[data-chart-pane="3"]')?.dataset.active==='true' && window.__lastWidget.activeChart().symbol()==='YM SEP26'`, 'refresh restores four charts and selected pane');
  assert.ok(await evaluate(`${panelVisible('trading-page-trade')} && ${panelVisible('trading-page-accounts')}`), 'panel visibility preferences restored');
  for (let i = 1; i <= 4; i++) {
    await activate(i); await assertBars(i, prices[i - 1]);
    await until(`window.__lastWidget.activeChart().getAllShapes().some(s=>window.__lastWidget.activeChart().getShapeById(s.id).getProperties().text===${JSON.stringify(`Fixture pane ${i}`)})`, `pane ${i} restores its own drawing`);
  }
  assert.deepEqual(await chartState(), symbols.map((symbol, i) => ({ symbol, resolution: resolutions[i], theme: 'dark' })), 'all chart scopes restore symbol, resolution and theme');
  await shot('multichart-restored');

  // Replay replaces the chart instance; all four live scopes must return intact.
  await activate(3);
  const savedScopes = await evaluate(`Object.fromEntries(Object.keys(localStorage).filter(key=>key.startsWith('nt8-terminal-tv-layouts-v2')).map(key=>[key,JSON.parse(localStorage.getItem(key)).charts.map(chart=>({id:chart.id,name:chart.name,symbol:chart.symbol,resolution:chart.resolution}))]))`);
  await clickText('回放模拟');
  await until(`!!document.querySelector('[aria-label="回放模拟工作台"]')`, 'replay dashboard from four charts');
  await clickText('创建并开始');
  await until(`window.__replay?.status().active && window.__lastWidget && window.__tvDatafeed?.getLastPrice('YM SEP26')>0`, 'replay starts from selected YM chart');
  const replayCursor = await evaluate(`window.__replay.status().cursor`);
  await clickText('单步推进');
  await until(`window.__replay.status().cursor>${replayCursor}`, 'replay advances independently');
  await clickText('保存并返回会话列表');
  await until(`!window.__replay.status().active && !!document.querySelector('[aria-label="回放模拟工作台"]')`, 'replay exit restores live mode');
  await clickText('交易图表');
  await until(`(()=>{try{return ${visiblePaneCount}===4 && !document.querySelector('button[aria-label="选择图表 3"]')?.disabled && document.querySelector('[data-chart-pane="3"]')?.dataset.active==='true' && window.__lastWidget?.activeChart().symbol()==='YM SEP26'}catch{return false}})()`, 'replay roundtrip restores four charts and active pane');
  for (let i = 1; i <= 4; i++) {
    await activate(i); await assertBars(i, prices[i - 1]);
    await until(`window.__lastWidget.activeChart().getAllShapes().some(s=>window.__lastWidget.activeChart().getShapeById(s.id).getProperties().text===${JSON.stringify(`Fixture pane ${i}`)})`, `replay exit restores drawing in pane ${i}`);
  }
  assert.deepEqual(await chartState(), symbols.map((symbol, i) => ({symbol,resolution:resolutions[i],theme:'dark'})), 'replay roundtrip preserves every live symbol and interval');
  assert.deepEqual(await evaluate(`Object.fromEntries(Object.keys(localStorage).filter(key=>key.startsWith('nt8-terminal-tv-layouts-v2')).map(key=>[key,JSON.parse(localStorage.getItem(key)).charts.map(chart=>({id:chart.id,name:chart.name,symbol:chart.symbol,resolution:chart.resolution}))]))`), savedScopes, 'replay does not contaminate any named live layout scope');
  await activate(3);
  await shot('multichart-replay-roundtrip');
  assert.equal(await evaluate(`sessionStorage.getItem('fixture-unexpected-post')`), null, 'no unexpected bridge mutation was attempted');
  assert.deepEqual(runtimeErrors, [], 'browser runtime errors');
  assert.deepEqual(failedResources.filter(url => !url.endsWith('/favicon.ico')), [], 'all required resources load');
  console.log('PASS multichart browser: all-instrument positions/orders/headings/precision; strict mocked non-active ES close/cancel isolation; independent horizontal panels/toggles/ticket state/full-width; 1/2/4 charts; independent symbol OHLC/resolution/search; iframe selection; four layout scopes/reload; shared theme; grid reduction preserves widgets/drawings; four-pane replay roundtrip; no unexpected bridge mutations');
} finally {
  ws?.close(); edge.kill(); server.close();
}
