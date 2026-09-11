// Exercise both Vite entry points against an isolated mock, never the real NT8 bridge.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createServer, loadConfigFromFile, preview } from '../app/node_modules/vite/dist/node/index.js';

const sockets = new Set();
const streams = new Set();
const requestWithHost = (url, headers, method = 'GET') => new Promise((resolve, reject) => {
  const request = http.request(url, { method, headers }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
  });
  request.on('error', reject);
  request.end();
});
let copyPosts = 0;
const mock = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/stream')) {
    streams.add(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: {"time":123,"close":100}\n\n');
    const timer = setInterval(() => res.write(': heartbeat\n\n'), 100);
    res.on('close', () => { clearInterval(timer); streams.delete(res); });
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  res.writeHead(req.url === '/api/rejected' ? 409 : 200, { 'Content-Type': 'application/json' });
  if (res.getHeader('X-Mock-Provider') === 'copy' && req.method === 'POST') copyPosts++;
  res.end(JSON.stringify({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString('utf8'), origin: req.headers.origin, fetchSite: req.headers['sec-fetch-site'] }));
});
mock.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
const atasMock = http.createServer((req, res) => {
  res.setHeader('X-Mock-Provider', 'atas');
  mock.emit('request', req, res);
});
atasMock.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
const copyMock = http.createServer((req, res) => {
  res.setHeader('X-Mock-Provider', 'copy');
  mock.emit('request', req, res);
});
copyMock.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => atasMock.listen(0, '127.0.0.1', resolve));
await new Promise(resolve => copyMock.listen(0, '127.0.0.1', resolve));
const target = `http://127.0.0.1:${mock.address().port}`;
const atasTarget = `http://127.0.0.1:${atasMock.address().port}`;
const copyTarget = `http://127.0.0.1:${copyMock.address().port}`;
const { config } = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.resolve('app/vite.config.ts'));
function options(mode) {
  assert.ok(config[mode].proxy['/atas/api'], 'ATAS proxy must be registered');
  assert.ok(config[mode].proxy['/copy/api'], 'Copy trading proxy must be registered');
  const proxy = Object.fromEntries(Object.entries(config[mode].proxy).map(([key, value]) => [key, { ...value, target: key === '/copy/api' ? copyTarget : key === '/atas/api' ? atasTarget : target }]));
  return {
    ...config, configFile: false, root: path.resolve('app'), logLevel: 'silent',
    cacheDir: path.resolve('.tmp-webbridge', `vite-proxy-${process.pid}-${mode}`),
    [mode]: { ...config[mode], host: '127.0.0.1', port: 0, strictPort: false, allowedHosts: ['terminal.example.test'], proxy },
  };
}
let dev, production;
try {
  dev = await createServer(options('server'));
  await dev.listen();
  production = await preview(options('preview'));
  for (const [name, service] of [['dev', dev], ['preview', production]]) {
    const base = `http://127.0.0.1:${service.httpServer.address().port}`;
    const query = '/api/history?symbol=NQ%20SEP26&interval=60&from=1&to=2';
    assert.equal((await fetch(base + query).then(r => r.json())).url, query);
    const payload = JSON.stringify({ account: '模拟账户', symbol: 'NQ SEP26', quantity: 2 });
    const echoed = await fetch(base + '/api/order/place', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }).then(r => r.json());
    assert.equal(echoed.method, 'POST');
    assert.equal(echoed.body, payload);
    assert.equal((await fetch(base + '/api/rejected')).status, 409);
    const atas = await fetch(base + '/atas' + query);
    assert.equal(atas.headers.get('x-mock-provider'), 'atas');
    assert.equal((await atas.json()).url, query);
    const atasOrder = await fetch(base + '/atas/api/order/place', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
    assert.equal(atasOrder.headers.get('x-mock-provider'), 'atas');
    assert.equal((await atasOrder.json()).body, payload);
    assert.equal((await fetch(base + '/atas/api/rejected')).status, 409);
    const copy = await fetch(base + '/copy' + query);
    assert.equal(copy.headers.get('x-mock-provider'), 'copy');
    assert.equal((await copy.json()).url, query);
    const copyRule = await fetch(base + '/copy/api/mock-rule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
    assert.equal(copyRule.headers.get('x-mock-provider'), 'copy');
    assert.equal((await copyRule.json()).body, payload);
    assert.equal((await fetch(base + '/copy/api/rejected')).status, 409);
    const beforeRejections = copyPosts;
    for (const headers of [
      { Origin: 'https://foreign.example' },
      { Origin: 'null' },
      { Origin: `http://127.0.0.1:${service.httpServer.address().port + 1}` },
      { 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      assert.equal((await fetch(base + '/copy/api/stop-all', { method: 'POST', headers, body: 'form' })).status, 403);
    }
    assert.equal(copyPosts, beforeRejections, 'rejected cross-site requests never reach upstream');
    const sameOrigin = await fetch(base + '/copy/api/mock-rule', { method: 'POST', headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } }).then(r => r.json());
    assert.equal(sameOrigin.origin, undefined);
    assert.equal(sameOrigin.fetchSite, undefined);
    const remote = await requestWithHost(base + '/copy/api/mock-rule', { Host: 'terminal.example.test:7443', Origin: 'https://terminal.example.test:7443' }, 'POST');
    assert.equal(remote.status, 200, 'public remote origins are accepted against the original host');
    assert.equal(remote.data.origin, undefined, 'public origin is not forwarded to the loopback service');
    assert.equal((await requestWithHost(base + '/copy/api/status', { Host: 'terminal.example.test', Origin: 'https://terminal.example.test:443' })).status, 200);
    for (const prefix of ['', '/atas', '/copy']) {
    const response = await fetch(base + prefix + '/api/stream?symbol=NQ%20SEP26', { signal: AbortSignal.timeout(2500) });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const frame = await reader.read();
    assert.match(new TextDecoder().decode(frame.value), /data:.*"close":100/);
    await reader.cancel();
    for (let i = 0; i < 40 && streams.size; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(streams.size, 0, 'closing the browser stream must release the bridge subscription');
    }
    console.log(`PASS Vite ${name}: independent NT8/ATAS/copy routes, query strings, UTF-8 POST body, error status and live SSE forwarding`);
  }
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => mock.close(resolve));
  for (const [name, service] of [['dev', dev], ['preview', production]]) {
    const response = await fetch(`http://127.0.0.1:${service.httpServer.address().port}/api/status`);
    assert.equal(response.status, 502);
    assert.ok((await response.json()).error);
    assert.equal((await fetch(`http://127.0.0.1:${service.httpServer.address().port}/atas/api/status`)).status, 200, 'ATAS remains available with NT8 offline');
    assert.equal((await fetch(`http://127.0.0.1:${service.httpServer.address().port}/copy/api/status`)).status, 200, 'Copy service remains available with NT8 offline');
    console.log(`PASS Vite ${name}: offline bridge returns a JSON error`);
  }
  await new Promise(resolve => copyMock.close(resolve));
  for (const service of [dev, production]) {
    const response = await fetch(`http://127.0.0.1:${service.httpServer.address().port}/copy/api/status`);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /复制交易/);
  }
} finally {
  for (const socket of sockets) socket.destroy();
  mock.close();
  atasMock.close();
  copyMock.close();
  if (production) {
    production.httpServer.closeAllConnections();
    await new Promise(resolve => production.httpServer.close(resolve));
  }
  await dev?.close();
}
