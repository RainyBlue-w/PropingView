// Real v32.1 chart UI against an isolated fixture; no request reaches the NT8 bridge.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const root = path.resolve('app/dist');
const output = path.resolve('.tmp-webbridge');
fs.mkdirSync(output, { recursive: true });
const symbols = ['NQ SEP26', 'ES SEP26'];
const prices = [24000, 6500];
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://local').pathname;
  const file = path.resolve(root, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
  if (req.method !== 'GET' || !file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end(); return;
  }
  const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const debugPort = 10100 + process.pid % 150;
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${path.join(output, `context-menu-profile-${Date.now()}`)}`,
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
    for (let i = 0; i < 120; i++) { if (await evaluate(`(()=>{try{return (${expression})}catch{return false}})()`)) return; await pause(200); }
    await shot('context-menu-failure');
    console.log('Context menu failure', await evaluate(`({text:document.body.innerText.slice(-2000),frames:Array.from(document.querySelectorAll('iframe')).map(f=>f.contentDocument?.body.innerText.slice(-3000)),post:sessionStorage.getItem('fixture-unexpected-post')})`));
    throw new Error(`Timed out: ${label}`);
  };
  const click = label => evaluate(`document.querySelector('button[aria-label=${JSON.stringify(label)}]')?.click()`);
  const setQty = async qty => {
    await evaluate(`(()=>{const input=document.querySelector('#trading-page-trade input[type="number"][min="1"]');if(!input)throw new Error('Missing quantity input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(String(qty))});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(`document.querySelector('#trading-page-trade').innerText.includes('买入 +${qty}')`, `ticket quantity ${qty}`);
    await pause(80);
  };
  const frameDoc = pane => `document.querySelector('[data-chart-pane="${pane}"] iframe').contentDocument`;
  // Match only the actual custom menu labels, never ancestor elements or built-in actions.
  const menuLabels = pane => `Array.from(${frameDoc(pane)}.querySelectorAll('*')).filter(e=>e.children.length===0&&/^(买入|卖出)(限价|止损) @ .* ×\\d+$/.test(e.textContent.trim()))`;
  const dismiss = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await pause(80);
  };
  const openMenu = async (pane, qty, level = 0.7) => {
    await dismiss();
    // Future whitespace avoids opening a candle/indicator-specific context menu.
    const point = await evaluate(`(()=>{const r=document.querySelector('[data-chart-pane="${pane}"] iframe').getBoundingClientRect();return {x:r.right-110,y:r.y+r.height*${level}};})()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'right', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'right', clickCount: 1 });
    await until(`${menuLabels(pane)}.length>0`, `pane ${pane} native context menu`);
    const labels = await evaluate(`${menuLabels(pane)}.map(e=>e.textContent.trim())`);
    assert.equal(labels.length, 2, `exactly two custom order choices after changing quantity: ${labels.join(' | ')}`);
    assert.ok(labels.every(label => label.endsWith(`×${qty}`)), `only latest quantity ${qty}: ${labels.join(' | ')}`);
    assert.equal(labels.filter(label => label.startsWith('买入')).length, 1, 'one buy menu item');
    assert.equal(labels.filter(label => label.startsWith('卖出')).length, 1, 'one sell menu item');
    return labels;
  };
  const chooseAccount = async name => {
    await evaluate(`Array.from(document.querySelectorAll('#trading-page-trade button')).find(b=>b.querySelector('span.font-mono'))?.click()`);
    await until(`Array.from(document.querySelectorAll('#trading-page-trade button')).some(b=>b.textContent.trim()===${JSON.stringify(name)})`, 'account dropdown');
    await evaluate(`Array.from(document.querySelectorAll('#trading-page-trade button')).find(b=>b.textContent.trim()===${JSON.stringify(name)}).click()`);
    await until(`document.querySelector('#trading-page-trade button span.font-mono')?.textContent.startsWith(${JSON.stringify(name)})`, `selected account ${name}`);
    await pause(80);
  };

  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
    if(window.top!==window)return;
    for(const [key,value] of Object.entries({'symbol':'NQ SEP26','interval':'1','chart-count':'1','theme':'dark','show-trades':'0','trading-panel-open':'1','account-panel-open':'0','panel-width':'300'}))localStorage.setItem('nt8-terminal-'+key,value);
    const names=${JSON.stringify(symbols)},prices=${JSON.stringify(prices)};
    const instruments=names.map((symbol,i)=>({symbol,name:['E-mini Nasdaq','E-mini S&P 500'][i],tickSize:0.25,pointValue:[20,50][i],type:'futures'}));
    window.__fixture={calls:[],mutations:[],time:Math.floor(Date.now()/60000)*60};
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      const method=(init?.method||input?.method||'GET').toUpperCase();
      if(!url.pathname.startsWith('/api/')){
        if(method!=='GET'||url.origin!==location.origin)throw new Error('Fixture forbids unmocked network request '+url.href);
        return originalFetch(input,init);
      }
      if(method!=='GET'){
        const body=JSON.parse(init?.body||'null'),expected=window.__fixture.expectedMutation;
        if(method==='POST'&&expected&&url.pathname===expected.path&&JSON.stringify(body)===JSON.stringify(expected.body)){
          window.__fixture.mutations.push({path:url.pathname,body});window.__fixture.expectedMutation=null;
          return new Response(JSON.stringify({ok:true,orderId:'fixture-menu-'+window.__fixture.mutations.length}),{status:200,headers:{'Content-Type':'application/json'}});
        }
        sessionStorage.setItem('fixture-unexpected-post',JSON.stringify({url:url.href,method,body}));
        throw new Error('Context menu test forbids unexpected mutation');
      }
      window.__fixture.calls.push(url.pathname+url.search);
      const q=url.searchParams;let data;
      switch(url.pathname){
        case '/api/status':data={connected:true,connectionName:'Context-menu fixture',historyWindowVersion:1,executionArchiveVersion:1};break;
        case '/api/symbols':data={symbols:instruments};break;
        case '/api/resolve':data=instruments.find(s=>s.symbol===q.get('symbol'));if(!data)throw new Error('Unknown symbol');break;
        case '/api/accounts':data={accounts:[{name:'Sim101',connection:'Simulation',currency:'USD',cashValue:100000,netLiquidation:100000},{name:'Fixture-02',connection:'Test Broker',currency:'USD',cashValue:50000,netLiquidation:50000}]};break;
        case '/api/positions':data={positions:[]};break;
        case '/api/orders':data={orders:[]};break;
        case '/api/brackets':data={brackets:[]};break;
        case '/api/executions':data={executions:[],total:0,nextOffset:null,archive:{version:1,state:'ready',recordCount:0,pendingCount:0}};break;
        case '/api/history':{
          const index=names.indexOf(q.get('symbol'));if(index<0)throw new Error('Unknown history symbol');
          const from=Number(q.get('from')),to=Math.min(Number(q.get('to')),window.__fixture.time),step=Number(q.get('interval'))||60,bars=[];
          for(let t=Math.ceil(Math.max(from,to-864000)/step)*step;t<=to;t+=step){const p=prices[index]+Math.sin(t/600)*12;bars.push({time:t,open:p-1,high:p+3,low:p-3,close:p,volume:100});}
          data={bars};break;
        }
        default:throw new Error('Unexpected fixture endpoint '+url.pathname);
      }
      return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
    };
    window.EventSource=class{constructor(){setTimeout(()=>this.onopen?.(),0);}close(){}};
    window.alert=message=>{throw new Error('Unexpected app alert: '+message)};
  })();` });
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await until(`!!window.__lastWidget && document.querySelector('#trading-page-trade')?.innerText.includes('下单 · NQ SEP26') && window.__tvDatafeed?.getLastPrice('NQ SEP26')>23000`, 'chart and trading panel ready');
  await evaluate(`new Promise(resolve=>window.__lastWidget.onChartReady(resolve))`);
  await evaluate(`window.__testWidgets=[window.__lastWidget];true`);
  for (const qty of [1, 2, 5, 3, 8, 2]) { await setQty(qty); await openMenu(1, qty); }
  await shot('context-menu-latest-quantity');

  // Selecting a visible native menu entry uses its exact account, symbol, quantity and price.
  const clickOrder = async (pane, qty, account, side, level) => {
    const labels = await openMenu(pane, qty, level);
    const label = labels.find(text => text.startsWith(side === 'BUY' ? '买入' : '卖出'));
    const price = Number(label.match(/ @ ([\d.]+) ×/)[1]);
    const market = await evaluate(`window.__tvDatafeed.getLastPrice(${JSON.stringify(symbols[pane - 1])})`);
    const orderType = (side === 'BUY' ? price <= market : price >= market) ? 'LIMIT' : 'STOPMARKET';
    assert.ok(label.includes(orderType === 'LIMIT' ? '限价' : '止损'), 'native label agrees with order price and market');
    const body = { account, symbol: symbols[pane - 1], action: side, orderType, quantity: qty, ...(orderType === 'LIMIT' ? { limitPrice: price } : { stopPrice: price }) };
    const before = await evaluate('window.__fixture.mutations.length');
    await evaluate(`window.__fixture.expectedMutation=${JSON.stringify({ path: '/api/order/place', body })}`);
    await evaluate(`${menuLabels(pane)}.find(e=>e.textContent.trim()===${JSON.stringify(label)}).click()`);
    await until(`window.__fixture.mutations.length===${before + 1}`, 'exact mocked native menu order');
    return orderType;
  };
  const types = [await clickOrder(1, 2, 'Sim101', 'BUY', 0.15), await clickOrder(1, 2, 'Sim101', 'BUY', 0.9)];
  assert.deepEqual(types.sort(), ['LIMIT', 'STOPMARKET'], 'both buy limit and buy stop routes are exercised');

  // Keep the native menu open while updating React state, then click the old DOM action.
  await openMenu(1, 2);
  await evaluate(`window.__staleMenuLabel=${menuLabels(1)}[0];true`);
  const beforeStale = await evaluate('window.__fixture.mutations.length');
  await setQty(7);
  await evaluate('window.__staleMenuLabel.click()');
  await pause(250);
  assert.equal(await evaluate('window.__fixture.mutations.length'), beforeStale, 'stale menu never submits old or changed quantity');
  assert.equal(await evaluate(`sessionStorage.getItem('fixture-unexpected-post')`), null, 'stale menu made no unapproved mutation');
  await openMenu(1, 7);

  await dismiss(); await click('关闭交易面板'); await click('交易面板');
  await until(`document.querySelector('#trading-page-trade').getBoundingClientRect().width>0`, 'reopened trading panel');
  await openMenu(1, 7);
  await dismiss(); await chooseAccount('Fixture-02');
  for (const qty of [4, 9, 3]) { await setQty(qty); await openMenu(1, qty); }
  await clickOrder(1, 3, 'Fixture-02', 'SELL', 0.3);

  await dismiss(); await click('双图');
  await until(`document.querySelectorAll('[data-chart-pane] iframe').length===2 && !document.querySelector('button[aria-label="选择图表 2"]').disabled`, 'second native chart ready');
  await click('选择图表 2');
  await until(`window.__lastWidget.activeChart().symbol()==='ES SEP26' && window.__tvDatafeed.getLastPrice('ES SEP26')>6000`, 'second chart symbol and market data');
  await evaluate(`window.__testWidgets[1]=window.__lastWidget;true`);
  for (const qty of [1, 6, 4]) { await setQty(qty); await openMenu(2, qty); await openMenu(1, qty); }
  await clickOrder(2, 4, 'Fixture-02', 'BUY', 0.3);
  await clickOrder(1, 4, 'Fixture-02', 'SELL', 0.7);
  await dismiss(); await click('单图'); await setQty(5); await click('双图');
  await openMenu(2, 5); await openMenu(1, 5);
  assert.ok(await evaluate(`window.__testWidgets.map(w=>w.activeChart().symbol()).join('|')==='NQ SEP26|ES SEP26'`), 'native charts retain separate symbols');
  await shot('context-menu-two-charts');
  assert.equal(await evaluate(`sessionStorage.getItem('fixture-unexpected-post')`), null, 'all mutations matched exact fixture expectations');
  assert.equal(await evaluate('window.__fixture.mutations.length'), 5, 'only five explicit native menu clicks submitted orders');
  assert.deepEqual(runtimeErrors, [], 'no browser runtime errors');
  assert.deepEqual(failedResources.filter(url => !url.endsWith('/favicon.ico')), [], 'all required assets load');
  console.log('PASS context-menu browser: repeated quantity changes show exactly one buy and one sell choice; exact mocked limit/stop prices, quantities, accounts and symbols; stale menu quantity click is inert; panel reopen/account switch/two charts/grid hide-show do not accumulate choices; no real bridge requests');
} finally {
  ws?.close(); edge.kill(); server.close();
}
