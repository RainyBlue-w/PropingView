// Phone/tablet and desktop panels against the real v32.1 chart runtime.
// Every bridge request is mocked; this test never submits an order.
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
const debugPort = 10700 + process.pid % 150;
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${path.join(output, `mobile-panels-profile-${Date.now()}`)}`,
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
  let sequence = 0, stage = 'startup';
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
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout ${method} during ${stage}`)); }, 30000);
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
    await shot('mobile-panels-failure');
    console.log('Mobile panels failure', await evaluate(`({text:document.body.innerText.slice(-2000),frames:Array.from(document.querySelectorAll('iframe')).map(f=>f.contentDocument?.body.innerText.slice(-3000)),post:sessionStorage.getItem('fixture-unexpected-post')})`));
    throw new Error(`Timed out: ${label}`);
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled:true, maxTouchPoints:1 });
  const protocol = await fetch(`http://127.0.0.1:${debugPort}/json/protocol`).then(response => response.json());
  const safeAreaSupported = protocol.domains.find(domain => domain.domain === 'Emulation')?.commands.some(command => command.name === 'setSafeAreaInsetsOverride');
  if (safeAreaSupported) await send('Emulation.setSafeAreaInsetsOverride', { insets: { top:44, left:0, right:0, bottom:0 } });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
    if(window.top!==window)return;
    for(const [key,value] of Object.entries({'symbol':'YM SEP26','interval':'1','chart-count':'4','theme':'dark','show-trades':'0','trading-panel-open':'1','account-panel-open':'1','panel-width':'300'}))localStorage.setItem('nt8-terminal-'+key,value);
    localStorage.setItem('nt8-terminal-chart-workspace',JSON.stringify({active:2,panes:${JSON.stringify(symbols)}.map(symbol=>({symbol,interval:'1'}))}));
    localStorage.setItem('nt8-terminal-fav-symbols',JSON.stringify(['NQ SEP26','ES SEP26',...Array.from({length:12},(_,i)=>'Favorite-'+String(i+1).padStart(2,'0'))]));
    const names=${JSON.stringify(symbols)},prices=${JSON.stringify(prices)};
    const instruments=names.map((symbol,i)=>({symbol,name:['E-mini Nasdaq','E-mini S&P 500','E-mini Dow','E-mini Russell'][i],tickSize:[.25,.25,1,.1][i],pointValue:[20,50,5,50][i],type:'futures'}));
    window.__fixture={calls:[],mutations:[],time:Math.floor(Date.now()/60000)*60};
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      const method=(init?.method||input?.method||'GET').toUpperCase();
      if(url.port==='8091'||url.pathname.startsWith('/atas/api/')){
        if(method!=='GET')throw new Error('Mobile panel test forbids ATAS mutations');
        const endpoint=url.pathname.startsWith('/atas/')?url.pathname.slice(5):url.pathname;
        const data=endpoint==='/api/status'?{connected:false}:endpoint==='/api/accounts'?{accounts:[]}:endpoint==='/api/executions'?{executions:[],total:0,nextOffset:null}:{error:'ATAS fixture offline'};
        return new Response(JSON.stringify(data),{status:endpoint==='/api/status'||endpoint==='/api/accounts'||endpoint==='/api/executions'?200:503,headers:{'Content-Type':'application/json'}});
      }
      if(!url.pathname.startsWith('/api/')){
        if(method!=='GET'||url.origin!==location.origin)throw new Error('Fixture forbids unmocked network request '+url.href);
        return originalFetch(input,init);
      }
      if(method!=='GET'){
        const body=JSON.parse(init?.body||'null');
        sessionStorage.setItem('fixture-unexpected-post',JSON.stringify({url:url.href,method,body}));
        throw new Error('Mobile panel test forbids mutations');
      }
      window.__fixture.calls.push(url.pathname+url.search);
      const q=url.searchParams;let data;
      switch(url.pathname){
        case '/api/status':data={connected:true,connectionName:'Mobile fixture',historyWindowVersion:1,executionArchiveVersion:1};break;
        case '/api/symbols':data={symbols:instruments};break;
        case '/api/resolve':data=instruments.find(s=>s.symbol===q.get('symbol'));if(!data)throw new Error('Unknown symbol');break;
        case '/api/accounts':data={accounts:[{name:'Sim101',connection:'Simulation',currency:'USD',cashValue:100000,netLiquidation:100000},{name:'Fixture-02',connection:'Test Broker',currency:'USD',cashValue:50000,netLiquidation:50000},...Array.from({length:12},(_,i)=>({name:'Mobile-'+String(i+1).padStart(2,'0'),connection:'Test Broker',currency:'USD',cashValue:25000+i*1000,netLiquidation:26000+i*1000}))]};break;
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
  await until(`window.__lastWidget?.activeChart().symbol()==='YM SEP26' && document.querySelector('#trading-page-trade')?.textContent.includes('YM SEP26') && window.__tvDatafeed?.getLastPrice('YM SEP26')>43000`, 'saved active chart and trading panel ready');
  await evaluate(`new Promise(resolve=>window.__lastWidget.onChartReady(resolve))`);
  if (safeAreaSupported) {
    const safeTop = await evaluate(`(()=>{const probe=document.createElement('div');probe.style.cssText='position:fixed;padding-top:env(safe-area-inset-top)';document.body.appendChild(probe);const value=parseFloat(getComputedStyle(probe).paddingTop);probe.remove();return value;})()`);
    assert.equal(safeTop, 44, 'browser safe-area fixture really applies a 44px top inset');
  }
  const rect = selector => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};})()`);
  const visible = selector => `(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e?.getBoundingClientRect();return !!r&&r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'&&!e.closest('[inert]')})()`;
  const tap = async label => {
    stage = `tap ${label}`;
    const selector = `button[aria-label=${JSON.stringify(label)}]`;
    const r = await rect(selector);
    const viewport = await evaluate('({width:innerWidth,height:innerHeight})');
    assert.ok(r && r.width > 0 && r.height > 0 && r.x >= 0 && r.right <= viewport.width + 1 && r.y >= 0 && r.bottom <= viewport.height + 1, `${label} reachable in viewport: ${JSON.stringify(r)}`);
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(selector)}).contains(document.elementFromPoint(${x},${y}))`), `${label} is not covered`);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await pause(150);
  };
  const viewport = async (width, height, mobile = true) => {
    stage = `viewport ${width}x${height}`;
    await send('Emulation.setTouchEmulationEnabled', { enabled:mobile, maxTouchPoints:1 });
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    if (safeAreaSupported) await send('Emulation.setSafeAreaInsetsOverride', { insets: { top:mobile ? 44 : 0, left:0, right:0, bottom:0 } });
    await pause(350);
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth'), `no page horizontal overflow ${width}x${height}`);
  };
  const panel = async (id, otherId, width, label) => {
    await until(visible(`#${id}`), `${label} visible`);
    const r = await rect(`#${id}`);
    assert.ok(r.x >= 0 && r.right <= width + 1 && r.width >= width - 2, `${label} uses phone content width: ${JSON.stringify(r)}`);
    assert.ok(await evaluate(`(()=>{const e=document.querySelector('#${id}');return e.scrollWidth<=e.clientWidth&&e.lastElementChild.scrollWidth<=e.lastElementChild.clientWidth})()`), `${label} has no internal horizontal overflow`);
    assert.equal(await evaluate(visible(`#${otherId}`)), false, 'only one phone panel visible');
    assert.equal(await evaluate(visible('[data-chart-workspace]')), true, 'chart remains visible and interactive above open panel');
    const chart = await rect('[data-chart-workspace]');
    assert.ok(chart.bottom <= r.y + 1 && chart.height >= 100 && r.height >= 100, `${label} is below a usable chart: ${JSON.stringify({chart,panel:r})}`);
    assert.ok(await evaluate(`(()=>{const f=Array.from(document.querySelectorAll('[data-chart-pane] iframe')).find(e=>e.getBoundingClientRect().width>0);if(!f||f.closest('[inert]'))return false;const r=f.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===f;})()`), 'visible chart iframe receives pointer input while panel is open');
  };
  const scrollBottom = async (id, selector = `#${id} > div:last-child`) => {
    stage = `scroll ${id}`;
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollTop=0`);
    const r = await rect(selector);
    const before = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return {height:e.clientHeight,scrollHeight:e.scrollHeight};})()`);
    assert.ok(before.scrollHeight > before.height, `${id} fixture requires scrolling`);
    // Touch scrolling must work within the panel rather than moving the page.
    const originalChart = await rect('[data-chart-workspace]');
    for (let i = 0; i < 30; i++) {
      const x = r.x + r.width / 2, start = Math.min(r.bottom - 20, r.y + r.height * .8), end = r.y + Math.min(30, r.height * .2);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
      for (let step = 1; step <= 6; step++) {
        await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: start + (end - start) * step / 6 }] });
        await pause(16);
      }
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await pause(120);
      if (await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e.scrollTop+e.clientHeight>=e.scrollHeight-2;})()`)) break;
    }
    assert.ok(await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e.scrollTop+e.clientHeight>=e.scrollHeight-2;})()`), `${id} bottom reachable by touch`);
    const last = await rect(`${selector} > :last-child`);
    assert.ok(last.bottom <= r.bottom + 2 && last.bottom > r.y, `${id} final content visible: ${JSON.stringify(last)}`);
    assert.deepEqual(await rect('[data-chart-workspace]'), originalChart, 'scrolling panel does not scroll the chart or page');
  };
  const setQty = async qty => {
    await evaluate(`(()=>{const input=document.querySelector('#trading-page-trade input[type="number"][min="1"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(String(qty))});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(`document.querySelector('#trading-page-trade').textContent.includes('买入 +${qty}')`, 'mobile quantity update');
  };
  const formMetrics = () => evaluate(`(()=>{
    const panel=document.querySelector('#trading-page-trade');
    const measure=e=>({text:e.textContent.trim(),height:e.getBoundingClientRect().height,fontSize:parseFloat(getComputedStyle(e).fontSize)});
    const inputs=['数量','止盈价（可选）','止损价（可选）'].map(label=>{const e=panel.querySelector('input[aria-label="'+label+'"]');return {...measure(e),label,inputMode:e.inputMode}});
    const buttons=Array.from(panel.querySelectorAll('button')).filter(e=>['交易','草稿','MKT','LMT/STP'].includes(e.textContent.trim())||['买入 +','卖出 -'].some(prefix=>e.textContent.trim().startsWith(prefix))).map(measure);
    let ticket=panel.querySelector('input[aria-label="数量"]').parentElement;
    while(ticket&&!Array.from(ticket.querySelectorAll('button')).some(e=>e.textContent.trim()==='MKT'))ticket=ticket.parentElement;
    return {inputs,buttons,account:measure(panel.querySelector('[aria-label="选择交易账户"]')),headerHeight:panel.firstElementChild.getBoundingClientRect().height,ticketHeight:ticket.getBoundingClientRect().height};
  })()`);
  const assertSmallPhoneForm = async label => {
    const metrics = await formMetrics();
    assert.ok(metrics.inputs.every(input => input.fontSize === 12 && input.height >= 24 && input.height <= 28), `${label} inputs use 12px text and 24–28px height: ${JSON.stringify(metrics.inputs)}`);
    assert.equal(metrics.buttons.length, 6, 'all mode, order type and buy/sell controls measured');
    assert.ok(metrics.buttons.every(button => button.fontSize <= 11 && button.height >= 24 && button.height <= 28), `${label} primary buttons are compact: ${JSON.stringify(metrics.buttons)}`);
    assert.ok(metrics.headerHeight <= 28 && metrics.account.height <= 28, `${label} heading and account selector stay compact`);
    assert.ok(metrics.ticketHeight < 200, `${label} ticket is shorter than the prior approximately 215px screenshot: ${metrics.ticketHeight}px`);
    console.log(`Phone form ${label}: ${JSON.stringify(metrics)}`);
    return metrics;
  };
  const resizeState = async () => ({
    panel: await rect('[data-sidebar]'),
    chart: await rect('[data-chart-workspace]'),
    divider: await rect('[data-mobile-panel-resizer]'),
  });
  const dragPanel = async delta => {
    stage = `resize panel ${delta}`;
    const before = await resizeState();
    assert.ok(before.divider && before.divider.height >= 12 && before.divider.width > 0, 'phone exposes a touch divider');
    const x = before.divider.x + before.divider.width / 2;
    const y = before.divider.y + before.divider.height / 2;
    const limit = await evaluate('({top:document.querySelector("nav").getBoundingClientRect().bottom+2,bottom:innerHeight-2})');
    const target = Math.min(limit.bottom, Math.max(limit.top, y + delta));
    assert.ok(await evaluate(`document.querySelector('[data-mobile-panel-resizer]').contains(document.elementFromPoint(${x},${y}))`), 'divider receives touch');
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{x,y}] });
    for (let i = 1; i <= 6; i++) {
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{x,y:y+(target-y)*i/6}] });
      await pause(16);
    }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await pause(200);
    const after = await resizeState();
    if (after.chart.height < 100 || after.panel.height < 120) await shot('mobile-panels-resize-minimum-failure');
    assert.ok(after.chart.height >= 100 && after.panel.height >= 120, `drag preserves usable minimum chart and panel heights: ${JSON.stringify(after)}`);
    assert.ok(Math.abs((after.panel.height-before.panel.height)+(after.chart.height-before.chart.height)) <= 3, 'chart height follows panel resize');
    assert.ok(after.chart.bottom <= after.divider.y + 1 && after.divider.bottom <= after.panel.y + 1, 'divider separates chart and panel without overlap');
    return {before,after};
  };
  const favorites = async label => {
    const state = await evaluate(`(()=>{const box=document.querySelector('[aria-label="搜索合约"]').parentElement.parentElement,row=box.querySelector(':scope > .overflow-x-auto'),r=row.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,boxHeight:box.getBoundingClientRect().height,scrollWidth:row.scrollWidth,tops:Array.from(row.children).map(e=>e.getBoundingClientRect().y)}})()`);
    assert.ok(state.height <= 38 && state.boxHeight <= 80 && state.scrollWidth > state.width, `${label} favorites keep one compact scrollable row`);
    assert.ok(state.tops.every(top => Math.abs(top - state.tops[0]) < 1), 'favorite chips never wrap');
    const x = state.x + state.width - 25, y = state.y + state.height / 2;
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let i = 1; i <= 6; i++) {
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - (state.width - 60) * i / 6, y }] });
      await pause(16);
    }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // Wait for the horizontal fling to settle before testing a separate tap.
    let previous = -1, stable = 0;
    for (let i = 0; i < 30 && stable < 3; i++) {
      await pause(100);
      const current = await evaluate(`document.querySelector('[aria-label="搜索合约"]').parentElement.parentElement.querySelector(':scope > .overflow-x-auto').scrollLeft`);
      stable = Math.abs(current - previous) < 1 ? stable + 1 : 0; previous = current;
    }
    assert.ok(await evaluate(`document.querySelector('[aria-label="搜索合约"]').parentElement.parentElement.querySelector(':scope > .overflow-x-auto').scrollLeft>0`), 'favorites scroll horizontally by touch');
    assert.ok(await evaluate(`document.documentElement.scrollWidth<=innerWidth&&document.querySelector('[data-chart-workspace]').getBoundingClientRect().height>100`), `${label} chart retains usable height without page overflow`);
  };
  const menuOpen = `document.querySelector('[aria-label="页面菜单"]')?.getAttribute('aria-expanded')==='true'`;
  const menuAction = async label => {
    if (!await evaluate(menuOpen)) await tap('页面菜单');
    await until(menuOpen, 'page menu open');
    stage = `menu ${label}`;
    const find = `Array.from(document.querySelectorAll('[role="menuitem"]')).find(e=>e.getAttribute('aria-label')===${JSON.stringify(label)}||e.textContent.trim()===${JSON.stringify(label)})`;
    await until(`!!(${find})`, `menu action ${label}`);
    await evaluate(`(${find}).scrollIntoView({block:'nearest'})`);
    const point = await evaluate(`(()=>{const e=${find},r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    assert.ok(await evaluate(`(${find}).contains(document.elementFromPoint(${point.x},${point.y}))`), `menu action ${label} receives touch`);
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await until(`!(${menuOpen})`, `menu closes after ${label}`);
    await until(`!document.querySelector('[role="menu"]')`, `menu exit animation completes after ${label}`);
  };
  const visibleCount = `Array.from(document.querySelectorAll('[data-chart-pane]')).filter(e=>e.getBoundingClientRect().width>0&&getComputedStyle(e).visibility!=='hidden'&&!e.closest('[inert]')).length`;
  const phoneLayout = async label => {
    assert.equal(await evaluate(visibleCount), 1, `${label} shows only the saved active chart`);
    assert.ok(await evaluate(`document.querySelector('[data-chart-pane="3"]').getBoundingClientRect().width>0&&document.querySelector('[data-chart-pane="3"]').dataset.active==='true'`), 'phone preserves saved third chart');
    assert.ok(await evaluate(`['单图','双图','四图'].every(label=>{const e=document.querySelector('button[aria-label="'+label+'"]');return !e||e.getBoundingClientRect().width===0})`), 'phone hides chart layout controls');
    const nav = await rect('nav[aria-label="主导航"]');
    assert.ok(nav.height <= 44 && nav.width <= await evaluate('innerWidth'), `${label} main navigation stays one compact row: ${JSON.stringify(nav)}`);
    assert.equal(nav.y, 0, `${label} navigation starts at viewport top without blank padding`);
    assert.equal(await evaluate(`localStorage.getItem('nt8-terminal-chart-count')`), '4', 'phone keeps desktop four-chart preference');
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('nt8-terminal-chart-workspace')).active`), 2, 'phone keeps desktop active chart preference');
  };

  // Saved desktop four-chart state becomes a single mobile chart without altering it.
  await until(visible('[data-chart-workspace]'), 'phone opens on chart');
  await evaluate('window.__mobileOriginalWidget=window.__lastWidget;true');
  await viewport(390, 844);
  await phoneLayout('390px phone');
  assert.equal(await evaluate(`document.querySelectorAll('[data-chart-pane] iframe').length`), 1, 'fresh phone creates only the active chart widget');
  await favorites('portrait');
  await shot('mobile-panels-chart-390x844');
  await tap('页面菜单');
  await until(menuOpen, 'menu opens');
  await shot('mobile-panels-page-menu');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(`!(${menuOpen})`, 'Escape dismisses menu');
  await until(`!document.querySelector('[role="menu"]')`, 'Escape exit animation completes');
  await tap('页面菜单');
  await until(menuOpen, 'menu reopens');
  const outside = await evaluate('({x:innerWidth-2,y:innerHeight-2})');
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [outside] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await until(`!(${menuOpen})`, 'outside touch dismisses menu');
  await until(`!document.querySelector('[role="menu"]')`, 'outside dismissal animation completes');
  await menuAction('账户总览');
  await until(`document.querySelector('h1')?.textContent==='账户总览'`, 'menu navigates to account overview');
  await menuAction('交易图表');
  await until(visible('[data-chart-workspace]'), 'menu returns to chart');
  assert.ok(await evaluate('window.__mobileOriginalWidget===window.__lastWidget'), 'menu navigation preserves current widget');
  if (!await evaluate(visible('#trading-page-trade'))) await tap('交易面板');
  await panel('trading-page-trade', 'trading-page-accounts', 390, 'phone trading panel');
  assert.ok(await evaluate(`(()=>{const e=document.querySelector('[data-mobile-panel-resizer]');return e.getAttribute('role')==='separator'&&e.getAttribute('aria-orientation')==='horizontal'&&e.tabIndex===0})()`), 'mobile resize separator supports keyboard access');
  const enlarged = await dragPanel(-90);
  assert.ok(enlarged.after.panel.height >= enlarged.before.panel.height + 60, 'dragging divider up enlarges the panel');
  const reduced = await dragPanel(40);
  assert.ok(reduced.after.panel.height <= reduced.before.panel.height - 25, 'dragging divider down shrinks the panel');
  await evaluate(`document.querySelector('[data-mobile-panel-resizer]').focus()`);
  const keyboardBefore = (await resizeState()).panel.height;
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
  await pause(150);
  const resizedHeight = (await resizeState()).panel.height;
  assert.ok(resizedHeight > keyboardBefore, 'ArrowUp also enlarges panel');
  const savedRatio = await evaluate(`Number(localStorage.getItem('tv-nt8-mobile-panel-ratio'))`);
  assert.ok(savedRatio > .44 && savedRatio < 1, 'resized proportion saved separately from desktop preferences');
  const compactForm = await assertSmallPhoneForm('390px portrait');
  assert.deepEqual(compactForm.inputs.map(input => input.inputMode), ['numeric', 'decimal', 'decimal'], 'quantity and price fields request suitable keyboards');
  await evaluate(`document.querySelector('#trading-page-trade input[aria-label="数量"]').focus({preventScroll:true})`);
  assert.equal(await evaluate(`parseFloat(getComputedStyle(document.querySelector('#trading-page-trade input[aria-label="数量"]')).fontSize)`), 16, 'focused phone input retains 16px text');
  await evaluate(`document.querySelector('#trading-page-trade input[aria-label="数量"]').blur()`);
  await setQty(7);
  await shot('mobile-panels-trade-390x844');
  await menuAction('账户信息');
  await panel('trading-page-accounts', 'trading-page-trade', 390, 'phone accounts panel');
  assert.ok(Math.abs((await resizeState()).panel.height-resizedHeight) <= 2, 'account panel uses the resized trading panel height');
  await scrollBottom('trading-page-accounts');
  await shot('mobile-panels-accounts-390x844');
  await tap('交易面板');
  assert.equal(await evaluate(`document.querySelector('#trading-page-trade input[type="number"][min="1"]').value`), '7', 'ticket quantity survives account panel switch');
  assert.ok(Math.abs((await resizeState()).panel.height-resizedHeight) <= 2, 'switching back retains panel height');
  await tap('关闭交易面板');
  await until(`!(${visible('#trading-page-trade')})`, 'close hides lower trading panel');
  assert.ok(await evaluate('window.__mobileOriginalWidget===window.__lastWidget'), 'return reuses chart instance');
  await tap('交易面板'); await tap('交易面板');
  await until(visible('[data-chart-workspace]'), 'toolbar button toggles phone panel off');

  await viewport(320, 568);
  await phoneLayout('320px phone');
  await tap('交易面板');
  await panel('trading-page-trade', 'trading-page-accounts', 320, 'small phone trading panel');
  await assertSmallPhoneForm('320px portrait');
  await evaluate(`document.querySelector('#trading-page-trade > div:last-child').scrollTop=0`);
  await shot('mobile-panels-form-top-320x568');
  await scrollBottom('trading-page-trade');
  await shot('mobile-panels-trade-320x568');
  await tap('关闭交易面板');
  await menuAction('账户信息');
  await panel('trading-page-accounts', 'trading-page-trade', 320, 'small phone accounts panel');
  await scrollBottom('trading-page-accounts');
  await tap('关闭账户信息');

  // Rotation must keep controls and form content reachable with little height.
  await viewport(844, 390);
  await phoneLayout('landscape phone');
  await favorites('landscape');
  await shot('mobile-panels-chart-landscape');
  await tap('交易面板');
  await panel('trading-page-trade', 'trading-page-accounts', 844, 'landscape trading panel');
  await assertSmallPhoneForm('844px landscape');
  await evaluate(`document.querySelector('#trading-page-trade > div:last-child').scrollTop=0`);
  await shot('mobile-panels-form-top-landscape');
  const clampedLarge = await dragPanel(-1000);
  assert.ok(clampedLarge.after.chart.height >= 100 && clampedLarge.after.chart.height < clampedLarge.before.chart.height, 'landscape upward drag clamps before hiding chart');
  const clampedSmall = await dragPanel(1000);
  assert.ok(clampedSmall.after.panel.height >= 120 && clampedSmall.after.panel.height <= 122, 'landscape downward drag clamps to usable panel minimum');
  await scrollBottom('trading-page-trade');
  await shot('mobile-panels-landscape-844x390');
  await tap('关闭交易面板');

  await viewport(1440, 900, false);
  assert.equal(await evaluate(visible('[data-mobile-panel-resizer]')), false, 'desktop does not show phone height divider');
  await until(`${visible('#trading-page-trade')}&&${visible('#trading-page-accounts')}`, 'desktop restores both saved panels');
  await until(`${visibleCount}===4 && !!document.querySelector('button[aria-label="选择图表 4"]') && !document.querySelector('button[aria-label="选择图表 4"]').disabled`, 'desktop restores all four chart widgets');
  const restored = await evaluate(`({same:window.__mobileOriginalWidget===window.__lastWidget,current:window.__lastWidget.activeChart().symbol(),original:window.__mobileOriginalWidget.activeChart().symbol(),saved:JSON.parse(localStorage.getItem('nt8-terminal-chart-workspace')).active,panes:Array.from(document.querySelectorAll('[data-chart-pane]')).map(e=>({pane:e.dataset.chartPane,active:e.dataset.active}))})`);
  assert.ok(restored.same, `desktop restoration keeps active third chart widget: ${JSON.stringify(restored)}`);
  const trade = await rect('#trading-page-trade'), accounts = await rect('#trading-page-accounts'), chart = await rect('[data-chart-workspace]');
  assert.ok(trade.width >= 250 && accounts.width >= 250 && accounts.x >= trade.right && Math.abs(accounts.y - trade.y) < 2, 'desktop panels remain side by side');
  assert.ok(chart.width >= 500 && chart.right <= trade.x + 1, 'desktop chart remains usable next to panels');
  assert.equal(await evaluate(`document.querySelector('#trading-page-trade input[type="number"][min="1"]').value`), '7', 'rotation preserves ticket values');
  const desktopForm = await formMetrics();
  assert.ok(desktopForm.inputs.every(input => input.height === 32 && input.fontSize === 14), `desktop inputs retain 32px height and 14px text: ${JSON.stringify(desktopForm.inputs)}`);
  const desktopOrderButtons = desktopForm.buttons.filter(button => !['交易','草稿'].includes(button.text));
  assert.ok(desktopOrderButtons.length === 4 && desktopOrderButtons.every(button => button.fontSize === 14 && button.height === 36), `desktop MKT and buy/sell controls retain 14px text and 36px height: ${JSON.stringify(desktopOrderButtons)}`);
  assert.ok(desktopForm.buttons.filter(button => ['交易','草稿'].includes(button.text)).every(button => button.height === 24 && button.fontSize === 12), 'desktop trading/draft tabs retain original dimensions');
  assert.ok(desktopForm.headerHeight === 36 && desktopForm.account.height === 32, 'desktop heading and account selector retain original dimensions');
  await evaluate(`document.querySelector('#trading-page-trade > div:last-child').scrollTop=0`);
  console.log(`Desktop form preserved: ${JSON.stringify(desktopForm)}`);
  await shot('mobile-panels-desktop-1440x900');
  assert.deepEqual(await evaluate(`['trading-panel-open','account-panel-open'].map(key=>localStorage.getItem('nt8-terminal-'+key))`), ['1', '1'], 'phone toggles did not alter desktop panel preferences');
  assert.equal(await evaluate(`document.querySelector('button[aria-label="四图"]').getAttribute('aria-pressed')`), 'true', 'desktop layout selector restores four charts');

  // Only create/close a local replay session to exercise its mobile controls;
  // no order matching, playback, or bridge mutation is needed here.
  await viewport(844, 390);
  await phoneLayout('desktop-to-mobile return');
  await menuAction('回放模拟');
  await until(`!!document.querySelector('[aria-label="回放模拟工作台"]')`, 'replay dashboard');
  await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='创建并开始').click()`);
  await until(`window.__replay?.status().active && !!window.__lastWidget`, 'local replay session ready');
  await menuAction('回放控制');
  await until(visible('[data-replay-panel]'), 'mobile replay controls open');
  const replay = await rect('[data-replay-panel]');
  assert.ok(replay.x >= 0 && replay.right <= 845 && replay.width >= 842, 'replay controls use full phone width');
  const replayChart = await rect('[data-chart-workspace]');
  assert.ok(replayChart.height >= 100 && replayChart.bottom <= replay.y + 1, 'replay controls remain below a visible chart');
  assert.equal(await evaluate(visible('#trading-page-trade')), false, 'replay controls replace trading panel');
  await scrollBottom('replay controls', '[data-replay-panel]');
  await shot('mobile-panels-replay-landscape');
  await tap('关闭回放控制');
  await until(visible('[data-chart-workspace]'), 'closing replay controls returns to chart');
  await tap('交易面板');
  await until(visible('#trading-page-trade'), 'replay trading panel opens');
  await menuAction('回放控制');
  await until(visible('[data-replay-panel]'), 'switch replay trading to controls');
  assert.equal(await evaluate(visible('#trading-page-trade')), false, 'only replay controls visible after switch');
  await evaluate(`Array.from(document.querySelectorAll('[data-replay-panel] button')).find(b=>b.textContent.trim()==='保存并返回会话列表').click()`);
  await until(`!window.__replay?.status().active && !!document.querySelector('[aria-label="回放模拟工作台"]')`, 'local replay saved and closed');

  // A new page load restores the independent phone ratio after all widget
  // preservation checks above have finished.
  await viewport(390, 844);
  await menuAction('交易图表');
  await until(visible('[data-chart-workspace]'), 'live chart returns before reload');
  if (!await evaluate(visible('#trading-page-trade'))) await tap('交易面板');
  const beforeReload = await resizeState();
  const ratioBeforeReload = await evaluate(`localStorage.getItem('tv-nt8-mobile-panel-ratio')`);
  await send('Page.reload');
  await until(`window.__lastWidget?.activeChart().symbol()==='YM SEP26' && window.__tvDatafeed?.getLastPrice('YM SEP26')>43000`, 'fresh page chart ready');
  if (!await evaluate(visible('#trading-page-trade'))) await tap('交易面板');
  await until(visible('[data-mobile-panel-resizer]'), 'reloaded phone panel visible');
  assert.equal(await evaluate(`localStorage.getItem('tv-nt8-mobile-panel-ratio')`), ratioBeforeReload, 'phone proportion survives reload');
  assert.ok(Math.abs((await resizeState()).panel.height-beforeReload.panel.height) <= 2, 'reloaded panel restores its resized height');
  await phoneLayout('reloaded phone');
  await shot('mobile-panels-resized-restored');
  assert.equal(await evaluate(`sessionStorage.getItem('fixture-unexpected-post')`), null, 'no order or other bridge mutation attempted');
  assert.deepEqual(runtimeErrors, [], 'no browser runtime errors');
  assert.deepEqual(failedResources.filter(url => !url.endsWith('/favicon.ico')), [], 'all required assets load');
  console.log('PASS compact mobile panels: 390/320px portrait and 844px landscape menu/navigation/touch controls; no top gap; touch/keyboard panel height resize, shared height and landscape limits; one saved active chart above independently scrolling compact trade/account/replay panels; preserved quantity/widgets/desktop four-chart layout and horizontal panels; no real bridge requests');
} finally { ws?.close(); edge.kill(); server.close(); }
