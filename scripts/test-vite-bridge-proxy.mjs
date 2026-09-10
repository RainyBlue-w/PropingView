// Exercise both Vite entry points against an isolated mock, never the real NT8 bridge.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createServer, loadConfigFromFile, preview } from '../app/node_modules/vite/dist/node/index.js';

const sockets = new Set();
const streams = new Set();
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
  res.end(JSON.stringify({ url: req.url, method: req.method, body: Buffer.concat(chunks).toString('utf8') }));
});
mock.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
const target = `http://127.0.0.1:${mock.address().port}`;
const { config } = await loadConfigFromFile({ command: 'serve', mode: 'test' }, path.resolve('app/vite.config.ts'));
function options(mode) {
  const proxy = Object.fromEntries(Object.entries(config[mode].proxy).map(([key, value]) => [key, { ...value, target }]));
  return {
    ...config, configFile: false, root: path.resolve('app'), logLevel: 'silent',
    cacheDir: path.resolve('.tmp-webbridge', `vite-proxy-${process.pid}-${mode}`),
    [mode]: { ...config[mode], host: '127.0.0.1', port: 0, strictPort: false, proxy },
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
    const response = await fetch(base + '/api/stream?symbol=NQ%20SEP26', { signal: AbortSignal.timeout(2500) });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const frame = await reader.read();
    assert.match(new TextDecoder().decode(frame.value), /data:.*"close":100/);
    await reader.cancel();
    for (let i = 0; i < 40 && streams.size; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(streams.size, 0, 'closing the browser stream must release the bridge subscription');
    console.log(`PASS Vite ${name}: query strings, UTF-8 POST body, error status and live SSE forwarding`);
  }
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => mock.close(resolve));
  for (const [name, service] of [['dev', dev], ['preview', production]]) {
    const response = await fetch(`http://127.0.0.1:${service.httpServer.address().port}/api/status`);
    assert.equal(response.status, 502);
    assert.ok((await response.json()).error);
    console.log(`PASS Vite ${name}: offline bridge returns a JSON error`);
  }
} finally {
  for (const socket of sockets) socket.destroy();
  mock.close();
  if (production) {
    production.httpServer.closeAllConnections();
    await new Promise(resolve => production.httpServer.close(resolve));
  }
  await dev?.close();
}
