// Real v32.1 chart in isolated Edge. Every bridge request is mocked and mutations are rejected.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const root = path.resolve('app/dist');
const output = path.resolve('.tmp-webbridge');
const testRatio = Number(process.argv[2] || 1);
assert.ok(testRatio === 1 || testRatio === 2, 'optional DPR must be 1 or 2');
fs.mkdirSync(output, { recursive: true });
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
const debugPort = 10900 + process.pid % 150;
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  `--force-device-scale-factor=${testRatio}`,
  `--user-data-dir=${path.join(output, `arrow-tip-profile-${Date.now()}`)}`,
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
    for (let i = 0; i < 100; i++) { if (await evaluate(`(()=>{try{return (${expression})}catch{return false}})()`)) return; await pause(200); }
    await shot('arrow-tip-failure');
    console.log('Arrow tip failure', await evaluate(`({text:document.body.innerText.slice(-1500),frames:Array.from(document.querySelectorAll('iframe')).map(f=>f.contentDocument?.body.innerText.slice(-1000)),post:sessionStorage.getItem('fixture-unexpected-post')})`));
    if(await evaluate('!!window.__measureIcon'))console.log('Last geometry',JSON.stringify(await evaluate(`window.__lastWidget.activeChart().getAllShapes().filter(s=>s.name==='icon').map(s=>window.__measureIcon(s.id))`),null,2));
    throw new Error(`Timed out: ${label}`);
  };
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: testRatio, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{
    if(window.top!==window)return;
    for(const [key,value] of Object.entries({'symbol':'NQ SEP26','interval':'5','chart-count':'1','theme':'dark','show-trades':'1','trading-panel-open':'0','account-panel-open':'0'}))localStorage.setItem('nt8-terminal-'+key,value);
    window.__fixture={calls:[],time:Math.floor(Date.now()/300000)*300};
    window.__fixture.executions=[
      {executionId:'tip-long-entry',time:window.__fixture.time-1800+137,price:23993.25,side:'Buy'},
      {executionId:'tip-long-exit',time:window.__fixture.time-1200+157,price:24005.50,side:'Sell'},
      {executionId:'tip-short-entry',time:window.__fixture.time-900+137,price:24011.75,side:'Sell'},
      {executionId:'tip-short-exit',time:window.__fixture.time-600+157,price:24000.25,side:'Buy'}
    ].map(e=>({...e,orderId:e.executionId,account:'Sim101',instrument:'NQ SEP26',timeMs:e.time*1000+123,qty:1,commission:2.25,pointValue:20,currency:'USD'}));
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      const method=(init?.method||input?.method||'GET').toUpperCase();
      if(!url.pathname.startsWith('/api/')){
        if(method!=='GET'||url.origin!==location.origin)throw new Error('Fixture forbids unmocked request '+url.href);
        return originalFetch(input,init);
      }
      if(method!=='GET'){
        sessionStorage.setItem('fixture-unexpected-post',JSON.stringify({url:url.href,method,body:init?.body}));
        throw new Error('Arrow-tip test forbids mutations');
      }
      window.__fixture.calls.push(url.pathname+url.search);
      const q=url.searchParams;let data;
      const instrument={symbol:'NQ SEP26',name:'E-mini Nasdaq',tickSize:0.25,pointValue:20,type:'futures'};
      switch(url.pathname){
        case '/api/status':data={connected:true,connectionName:'Arrow-tip fixture',historyWindowVersion:1,executionArchiveVersion:1};break;
        case '/api/symbols':data={symbols:[instrument]};break;
        case '/api/resolve':data=instrument;break;
        case '/api/accounts':data={accounts:[{name:'Sim101',connection:'Simulation',currency:'USD',cashValue:100000,netLiquidation:100000}]};break;
        case '/api/positions':data={positions:[]};break;
        case '/api/orders':data={orders:[]};break;
        case '/api/brackets':data={brackets:[]};break;
        case '/api/executions':data={executions:window.__fixture.executions,total:4,nextOffset:null,archive:{version:1,state:'ready',recordCount:4,pendingCount:0}};break;
        case '/api/history':{
          const from=Number(q.get('from')),to=Math.min(Number(q.get('to')),window.__fixture.time),step=Number(q.get('interval'))||60,bars=[];
          for(let t=Math.ceil(Math.max(from,to-864000)/step)*step;t<=to;t+=step){const p=24000+Math.sin(t/600)*12;bars.push({time:t,open:p-1,high:p+3,low:p-3,close:p,volume:100});}
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
  await until(`!!window.__lastWidget && window.__tvDatafeed?.getLastPrice('NQ SEP26')>23000`, 'chart ready');
  await evaluate(`new Promise(resolve=>window.__lastWidget.onChartReady(resolve))`);
  const icons = `window.__lastWidget.activeChart().getAllShapes().filter(s=>s.name==='icon'&&s.id!==window.__userIcon)`;
  await until(`(${icons}).length===4`, 'four execution icons');
  assert.match(await evaluate('window.TradingView.version()'), /^CL v32\.1\.0 /, 'real v32.1 runtime');
  // Inspect the actual renderer output, independently calculating the SVG path bounds
  // with the browser. Source coordinates remain the original price/time projection.
  await evaluate(`window.__measureIcon=id=>{
    const shape=window.__lastWidget.activeChart().getShapeById(id),source=shape._source;
    const view=source.paneViews().find(v=>v._iconRenderer),renderer=view?._iconRenderer;
    if(!renderer)return null;
    if(!renderer.__tipPaintHook){
      const draw=renderer._drawImpl;
      renderer._drawImpl=function(target){
        if(this._data)this.__tipPaint={data:{...this._data,center:{...this._data.center}},ratio:target.horizontalPixelRatio,verticalRatio:target.verticalPixelRatio};
        return draw.call(this,target);
      };
      renderer.__tipPaintHook=true;source._model.lightUpdate();
    }
    const painted=renderer.__tipPaint,data=painted?.data;
    if(!data?.svg)return null;
    const frame=document.querySelector('[data-chart-pane="1"] iframe'),doc=frame.contentDocument;
    const container=doc.createElement('div');container.style.cssText='position:fixed;left:-10000px;top:0;visibility:hidden';
    container.innerHTML=source.svgContent();doc.body.append(container);
    const svg=container.querySelector('svg'),b=svg.getBBox(),v=svg.viewBox.baseVal;
    const bbox={x:b.x,y:b.y,width:b.width,height:b.height},viewBox={x:v.x,y:v.y,width:v.width,height:v.height};container.remove();
    const props=shape.getProperties(),buy=props.icon===0xf062;
    const svgTipY=buy?bbox.y:bbox.y+bbox.height;
    const tip={x:data.center.x,y:data.center.y-data.height/2+(svgTipY-viewBox.y)*data.height/viewBox.height};
    const screen=source.pointToScreenPoint(source.points()[0]),ratio=painted.ratio,verticalRatio=painted.verticalRatio;
    const rounding=Math.floor(ratio)%2===0?0:0.5;
    const nativeCenter={x:Math.round(screen.x*ratio)+rounding,y:Math.round(screen.y*verticalRatio)+rounding};
    return {id,props,points:shape.getPoints(),screen,ratio,verticalRatio,nativeCenter,center:data.center,tip,width:data.width,height:data.height,bbox,viewBox};
  };true`);
  await until(`(${icons}).every(s=>!!window.__measureIcon(s.id))`, 'real SVG views loaded');
  const executions = await evaluate('window.__fixture.executions');
  const geometry = [];
  const measure = async (label, seconds, ratio = testRatio) => {
    await pause(150);
    await until(`(${icons}).length===4&&(${icons}).every(s=>{const m=window.__measureIcon(s.id);return m&&Math.abs(m.ratio-${ratio})<0.005})`, label+' rendered');
    const markers = await evaluate(`(${icons}).map(s=>window.__measureIcon(s.id)).sort((a,b)=>a.points[0].time-b.points[0].time)`);
    markers.forEach((m,i)=>{
      const e=executions[i],buy=e.side==='Buy';
      assert.equal(m.props.icon,buy?0xf062:0xf063,label+' upright icon');
      assert.equal(m.props.color,buy?'#26a69a':'#ef5350',label+' direction color');
      assert.equal(m.props.size,14,label+' small 14px icon setting');
      const parity=Math.floor(m.ratio)%2;
      const bitmapSize=r=>{const n=Math.round(14*r);return n%2===parity?n:n+1};
      assert.equal(m.width,bitmapSize(m.ratio),label+' native small raster width');
      assert.equal(m.height,bitmapSize(m.verticalRatio),label+' native small raster height');
      assert.equal(m.props.angle,Math.PI/2,label+' vertical arrow');
      assert.equal(m.points[0].time,Math.floor(e.time/seconds)*seconds,label+' original execution time reprojected');
      assert.equal(m.points[0].price,e.price,label+' original exact execution price');
      assert.ok(Math.abs(m.tip.x-m.nativeCenter.x)<0.01,label+' tip time coordinate');
      assert.ok(Math.abs(m.tip.y-m.nativeCenter.y)<0.01,`${label} tip price coordinate: ${JSON.stringify(m)}`);
      assert.ok((m.center.y-m.nativeCenter.y)*(buy?1:-1)>5*ratio,label+' arrow body remains behind tip');
      assert.ok(Math.abs(m.tip.y/m.verticalRatio-m.screen.y)<=1/m.verticalRatio,label+' only native raster rounding from raw execution point');
    });
    if(await evaluate('!!window.__userIcon')){
      const user=await evaluate('window.__measureIcon(window.__userIcon)');
      assert.ok(user,label+' ordinary user icon renders');
      assert.deepEqual(user.center,user.nativeCenter,label+' ordinary icon keeps native center anchoring');
    }
    geometry.push({label,markers:markers.map(m=>({time:m.points[0].time,price:m.points[0].price,screen:m.screen,center:m.center,tip:m.tip,ratio:m.ratio}))});
    return markers;
  };
  await measure('initial 5m',300);
  await evaluate(`window.__lastWidget.activeChart().setVisibleRange({from:window.__fixture.time-2400,to:window.__fixture.time+600})`);
  await evaluate(`(async()=>{window.__userIcon=await window.__lastWidget.activeChart().createMultipointShape([{time:window.__fixture.time-300,price:23989}],{shape:'icon',icon:0xf062,overrides:{size:14,color:'#f4cf56',angle:Math.PI/2}});return true})()`);
  await until(`!!window.__measureIcon(window.__userIcon)`, 'ordinary user icon');
  const zoomed=await measure('zoomed 5m with ordinary icon',300);
  await shot('execution-arrow-tip-5m-dpr'+testRatio);
  await evaluate(`window.__lastWidget.activeChart().setVisibleRange({from:window.__fixture.time-3000,to:window.__fixture.time})`);
  const panned=await measure('panned 5m',300);
  assert.notEqual(zoomed[0].screen.x,panned[0].screen.x,'time pan actually moves execution on screen');
  await evaluate(`(()=>{const scale=window.__lastWidget.activeChart().getPanes()[0].getMainSourcePriceScale();scale.setAutoScale(false);scale.setVisiblePriceRange({from:23960,to:24040});})()`);
  const rescaled=await measure('rescaled price axis',300);
  assert.notEqual(rescaled[0].screen.y,panned[0].screen.y,'price zoom actually moves execution on screen');
  // v32.1's setInverted/setMode APIs update properties; setting the current price
  // range afterwards requests the same redraw that a native scale-menu action does.
  await evaluate(`(()=>{const scale=window.__lastWidget.activeChart().getPanes()[0].getMainSourcePriceScale();scale.setInverted(true);scale.setVisiblePriceRange({from:23960,to:24040});})()`);
  await measure('inverted price axis',300);
  await evaluate(`(()=>{const scale=window.__lastWidget.activeChart().getPanes()[0].getMainSourcePriceScale();scale.setMode(1);scale.setVisiblePriceRange({from:23960,to:24040});})()`);
  await measure('inverted logarithmic price axis',300);
  const oldIds=await evaluate(`(${icons}).map(s=>s.id)`);
  await evaluate(`new Promise(resolve=>window.__lastWidget.activeChart().setResolution('1',resolve))`);
  await until(`(${icons}).length===4&&(${icons}).every(s=>!${JSON.stringify(oldIds)}.includes(s.id))`, 'new 1m markers replace 5m entities');
  await evaluate(`window.__lastWidget.activeChart().setVisibleRange({from:window.__fixture.time-2400,to:window.__fixture.time+600})`);
  await measure('1m exact execution minutes',60);
  await evaluate(`(()=>{const scale=window.__lastWidget.activeChart().getPanes()[0].getMainSourcePriceScale();scale.setInverted(false);scale.setMode(0);scale.setVisiblePriceRange({from:23960,to:24040});})()`);
  await measure('restored linear 1m',60);
  await shot('execution-arrow-tip-1m-dpr'+testRatio);
  await evaluate(`document.querySelector('[aria-label="隐藏交易历史"]').click()`);
  await until(`window.__lastWidget.activeChart().getAllShapes().length===1&&window.__lastWidget.activeChart().getAllShapes()[0].id===window.__userIcon`, 'history off removes all execution arrows and connectors only');
  await evaluate(`document.querySelector('[aria-label="显示交易历史"]').click()`);
  await measure('history reopened',60);
  fs.writeFileSync(path.join(output,'execution-arrow-tip-geometry-dpr'+testRatio+'.json'),JSON.stringify(geometry,null,2));
  assert.equal(await evaluate(`sessionStorage.getItem('fixture-unexpected-post')`), null, 'no order mutation');
  assert.deepEqual(runtimeErrors, [], 'no browser runtime errors');
  assert.deepEqual(failedResources.filter(url => !url.endsWith('/favicon.ico')), [], 'all required assets load');
  console.log('PASS execution arrow tip browser DPR'+testRatio+': real SVG tips coincide with original execution time/price pixels; small green up/red down; ordinary icons retain center anchor; zoom/pan/price scale/inverted/log axis/5m-to-1m/history cleanup and reopen; no real bridge requests');
} finally {
  ws?.close(); edge.kill(); server.close();
}
