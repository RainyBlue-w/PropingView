// Isolated proxy regression: compiles only a temporary executable and replaces its
// upstream with a random-port mock. Never connects to the real NT8 bridge (8090).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(root, '.tmp-webbridge');
await mkdir(tempRoot, { recursive: true });
const work = await mkdtemp(path.join(tempRoot, 'static-proxy-'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => server.close(resolve));
const requestWithHost = (url, headers, method = 'GET') => new Promise((resolve, reject) => {
  const request = http.request(url, { method, headers }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
  });
  request.on('error', reject);
  request.end();
});
const sockets = new Set();
let openEvents = 0;
let receivedPosts = 0;
const bridge = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/events')) {
    openEvents++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: {"ready":true}\n\n');
    const timer = setTimeout(() => res.write('data: {"later":true}\n\n'), 1200);
    res.once('close', () => { openEvents--; clearTimeout(timer); });
    return;
  }
  if (req.url === '/api/timeout') return;
  if (req.url === '/api/error') {
    res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '2' });
    res.end(JSON.stringify({ ok: false, error: '订单已变更' }));
    return;
  }
  if (req.url === '/api' || req.url === '/api/missing') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"API not found"}');
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  if (req.method === 'POST') receivedPosts++;
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ provider: res.getHeader('X-Mock-Provider') ?? 'nt8', method: req.method, url: req.url, body, contentType: req.headers['content-type'], lastEventId: req.headers['last-event-id'], origin: req.headers.origin, fetchSite: req.headers['sec-fetch-site'] }));
});
bridge.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
const atasBridge = http.createServer((req, res) => {
  res.setHeader('X-Mock-Provider', 'atas');
  bridge.emit('request', req, res);
});
atasBridge.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
const copyService = http.createServer((req, res) => {
  res.setHeader('X-Mock-Provider', 'copy');
  bridge.emit('request', req, res);
});
copyService.on('connection', (socket) => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
let process;
const eventRequests = [];
try {
  const bridgePort = await listen(bridge);
  const atasPort = await listen(atasBridge);
  const copyPort = await listen(copyService);
  assert.notEqual(bridgePort, 8090);
  assert.notEqual(atasPort, 8091);
  assert.notEqual(copyPort, 8092);
  const reservation = net.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const source = (await readFile(path.join(root, 'server/StaticServer.cs'), 'utf8'))
    .replace('private const string BridgeOrigin = "http://127.0.0.1:8090";', `private const string BridgeOrigin = "http://127.0.0.1:${bridgePort}";`)
    .replace('private const string AtasBridgeOrigin = "http://127.0.0.1:8091";', `private const string AtasBridgeOrigin = "http://127.0.0.1:${atasPort}";`)
    .replace('private const string CopyServiceOrigin = "http://127.0.0.1:8092";', `private const string CopyServiceOrigin = "http://127.0.0.1:${copyPort}";`)
    .replace('private const int BridgeTimeoutMs = 30000;', 'private const int BridgeTimeoutMs = 800;');
  assert(!source.includes('private const string BridgeOrigin = "http://127.0.0.1:8090";'));
  assert(!source.includes('private const string AtasBridgeOrigin = "http://127.0.0.1:8091";'));
  assert(!source.includes('private const string CopyServiceOrigin = "http://127.0.0.1:8092";'));
  const sourceFile = path.join(work, 'StaticServer.cs');
  const executable = path.join(work, 'TestStaticServer.exe');
  await writeFile(sourceFile, source);
  await mkdir(path.join(work, 'dist'));
  await writeFile(path.join(work, 'dist/index.html'), '<html>isolated SPA fixture</html>');
  const outsideFile = path.join(work, 'outside.txt');
  await writeFile(outsideFile, 'MUST NOT BE SERVED');
  const bigAsset = Buffer.alloc(6 * 1024 * 1024, 'proxy-static-integrity');
  await writeFile(path.join(work, 'dist/large.js'), bigAsset);
  const compiler = path.join(globalThis.process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const compile = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${executable}`, sourceFile], { encoding: 'utf8', windowsHide: true });
  assert.equal(compile.status, 0, compile.stdout + compile.stderr);
  process = spawn(executable, [String(port), '--host', '127.0.0.1', '--no-browser'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  process.stdout.on('data', (chunk) => { output += chunk; });
  process.stderr.on('data', (chunk) => { output += chunk; });
  const origin = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch { /* startup */ }
    await pause(100);
  }
  assert(ready, output);

  const query = '/api/status?account=Sim%20%E4%B8%AD%E6%96%87&symbol=NQ%2009-26&n=1';
  const status = await fetch(origin + query, { headers: { 'Last-Event-ID': 'event-23' } }).then((r) => r.json());
  assert.equal(status.url, query);
  assert.equal(status.method, 'GET');
  assert.equal(status.lastEventId, 'event-23');

  const payload = JSON.stringify({ account: '模拟账户', text: '中文数量测试'.repeat(400), qty: 3 });
  const post = await fetch(origin + '/api/mock-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }).then((r) => r.json());
  assert.equal(post.body, payload);
  assert.equal(post.contentType, 'application/json');

  // First packet deliberately contains the header and only part of a UTF-8 code
  // point. The rest arrives in separate TCP writes after header parsing finishes.
  const body = Buffer.from(JSON.stringify({ note: '中文分片订单', qty: 7 }), 'utf8');
  const segmentedResponse = await new Promise((resolve, reject) => {
    const connection = net.connect(port, '127.0.0.1');
    const response = [];
    connection.on('data', (part) => response.push(part));
    connection.on('error', reject);
    connection.on('end', () => resolve(Buffer.concat(response).toString('utf8')));
    connection.on('connect', async () => {
      connection.write(Buffer.concat([Buffer.from(`POST /api/mock-order HTTP/1.1\r\nHost: remote.example\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`), body.subarray(0, 10)]));
      for (let offset = 10; offset < body.length; offset += 3) {
        await pause(10);
        connection.write(body.subarray(offset, offset + 3));
      }
    });
  });
  assert(segmentedResponse.startsWith('HTTP/1.1 200'));
  assert.equal(JSON.parse(segmentedResponse.split('\r\n\r\n')[1]).body, body.toString('utf8'));
  assert.equal(receivedPosts, 2);

  const atasStatus = await fetch(origin + '/atas' + query).then(r => r.json());
  assert.equal(atasStatus.provider, 'atas');
  assert.equal(atasStatus.url, query, 'strip only ATAS proxy prefix and retain encoded query');
  const atasOrder = await fetch(origin + '/atas/api/mock-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }).then(r => r.json());
  assert.equal(atasOrder.provider, 'atas');
  assert.equal(atasOrder.body, payload, 'ATAS receives original UTF-8 body');
  assert.equal((await fetch(origin + query).then(r => r.json())).provider, 'nt8', 'NT8 keeps its independent upstream');
  assert.equal((await fetch(origin + '/atas/api/error')).status, 409);
  const copyStatus = await fetch(origin + '/copy' + query).then(r => r.json());
  assert.equal(copyStatus.provider, 'copy');
  assert.equal(copyStatus.url, query, 'strip only copy service prefix and retain encoded query');
  const copyRule = await fetch(origin + '/copy/api/mock-rule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }).then(r => r.json());
  assert.equal(copyRule.provider, 'copy');
  assert.equal(copyRule.body, payload, 'copy service receives original UTF-8 body');
  assert.equal((await fetch(origin + '/copy/api/error')).status, 409);
  const postsBeforeRejections = receivedPosts;
  for (const headers of [
    { Origin: 'https://foreign.example' },
    { Origin: 'null' },
    { Origin: `http://127.0.0.1:${port + 1}` },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    assert.equal((await fetch(origin + '/copy/api/stop-all', { method: 'POST', headers, body: 'form' })).status, 403);
  }
  assert.equal(receivedPosts, postsBeforeRejections, 'rejected cross-site requests must never reach the copy service');
  const sameOrigin = await fetch(origin + '/copy/api/mock-rule', { method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } }).then(r => r.json());
  assert.equal(sameOrigin.provider, 'copy');
  assert.equal(sameOrigin.origin, undefined);
  assert.equal(sameOrigin.fetchSite, undefined);
  const remoteOrigin = await requestWithHost(origin + '/copy/api/mock-rule', { Host: 'terminal.example.test:7443', Origin: 'https://terminal.example.test:7443' }, 'POST');
  assert.equal(remoteOrigin.data.provider, 'copy', 'public remote host and origin are compared before forwarding to loopback');
  const standardHttps = await requestWithHost(origin + '/copy/api/status', { Host: 'terminal.example.test', Origin: 'https://terminal.example.test:443' });
  assert.equal(standardHttps.status, 200, 'normalise default HTTPS ports');

  const failure = await fetch(origin + '/api/error');
  assert.equal(failure.status, 409);
  assert.equal(failure.headers.get('retry-after'), '2');
  assert.deepEqual(await failure.json(), { ok: false, error: '订单已变更' });
  for (const apiPath of ['/api', '/api/missing', '/atas/api', '/atas/api/missing', '/copy/api', '/copy/api/missing']) {
    const missing = await fetch(origin + apiPath);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'API not found' });
  }
  const unsupported = await fetch(origin + '/api/status', { method: 'DELETE' });
  assert.equal(unsupported.status, 405);
  assert.equal((await unsupported.json()).ok, false);
  const escaped = await fetch(origin + '/' + outsideFile.replaceAll('\\', '%5c'));
  assert.equal(escaped.status, 403);
  assert(!((await escaped.text()).includes('MUST NOT BE SERVED')));

  // Four simultaneous EventSource connections must not exhaust the Framework's
  // default two-connection pool or buffer the first event until the stream ends.
  const laterEvents = [];
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const request = http.get(origin + `${i % 2 ? '/atas' : ''}/api/events?id=${i}`, (res) => {
        assert.equal(res.headers['content-type'], 'text/event-stream');
        assert.equal(res.headers['x-accel-buffering'], 'no');
        let text = '';
        let readyEvent = false;
        res.on('data', (chunk) => {
          text += chunk;
          if (!readyEvent && text.includes('"ready":true')) {
            readyEvent = true;
            assert(Date.now() - start < 700, 'First SSE event should arrive immediately');
            resolve();
          }
          if (text.includes('"later":true')) laterEvents[i] = true;
        });
      });
      request.on('error', reject);
      eventRequests.push(request);
    });
  }
  assert.equal((await fetch(origin + '/api/status')).status, 200);
  await pause(1500);
  assert.equal(laterEvents.filter(Boolean).length, 4, 'SSE streams should survive the normal response timeout');
  for (const request of eventRequests) request.destroy();
  for (let i = 0; i < 30 && openEvents > 0; i++) await pause(100);
  assert.equal(openEvents, 0, 'Disconnect must close upstream even without another event');

  const timeout = await fetch(origin + '/api/timeout');
  assert.equal(timeout.status, 504);
  assert.equal((await timeout.json()).ok, false);
  const asset = Buffer.from(await fetch(origin + '/large.js').then((r) => r.arrayBuffer()));
  assert.equal(createHash('sha256').update(asset).digest('hex'), createHash('sha256').update(bigAsset).digest('hex'));
  assert.match(await fetch(origin + '/nested/page').then((r) => r.text()), /isolated SPA fixture/);

  for (const socket of sockets) socket.destroy();
  await close(bridge);
  const offline = await fetch(origin + '/api/status');
  // .NET Framework may retry a refused Windows socket until the deliberately
  // shortened test timeout; both gateway responses correctly describe offline.
  assert([502, 504].includes(offline.status));
  assert.match(offline.headers.get('content-type'), /application\/json/);
  assert.equal((await offline.json()).ok, false);
  assert.equal((await fetch(origin + '/atas/api/status')).status, 200, 'NT8 offline does not disconnect ATAS');
  assert.equal((await fetch(origin + '/copy/api/status')).status, 200, 'NT8 offline does not disconnect copy service');
  await close(atasBridge);
  assert([502, 504].includes((await fetch(origin + '/atas/api/status')).status));
  await close(copyService);
  const copyOffline = await fetch(origin + '/copy/api/status');
  assert([502, 504].includes(copyOffline.status));
  assert.match((await copyOffline.json()).error, /Copy trading/);
  console.log('PASS static proxy: independent NT8/ATAS/copy routing, GET/query, UTF-8 POST, segmented body, HTTP errors, API no-SPA, method/path guards, concurrent SSE, disconnect cleanup, timeout/offline JSON, complete static assets');
} finally {
  for (const request of eventRequests) request.destroy();
  for (const socket of sockets) socket.destroy();
  if (bridge.listening) await close(bridge);
  if (atasBridge.listening) await close(atasBridge);
  if (copyService.listening) await close(copyService);
  if (process && process.exitCode === null) {
    process.kill();
    await new Promise((resolve) => process.once('exit', resolve));
  }
  const resolved = path.resolve(work);
  assert(resolved.startsWith(path.resolve(tempRoot) + path.sep), 'Temporary cleanup must stay under workspace .tmp-webbridge');
  await rm(resolved, { recursive: true, force: true });
}
