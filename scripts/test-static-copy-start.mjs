// Only launches temporary mock executables on random ports. Does not load the
// production copy service or connect to any NT8/ATAS account.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = path.join(root, '.tmp-webbridge');
await mkdir(tempRoot, { recursive: true });
const work = await mkdtemp(path.join(tempRoot, 'copy-start-'));
const compiler = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = async () => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  assert(![8090, 8091, 8092].includes(port));
  return port;
};
const compile = (source, output) => {
  const result = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${output}`, source], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stdout + result.stderr);
};
const waitFor = async condition => {
  for (let i = 0; i < 100; i++) {
    try { if (await condition()) return; } catch { /* startup */ }
    await pause(50);
  }
  throw new Error('Temporary mock service did not reach the expected state');
};
const servers = [];
const stopFiles = [];
const closedFiles = [];
const stopServer = async child => {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise(resolve => child.once('exit', resolve));
  }
};
try {
  for (const layout of ['packaged', 'workspace']) {
    const directory = path.join(work, layout);
    const serviceDirectory = path.join(directory, 'copy-trading', ...(layout === 'workspace' ? ['dist'] : []));
    await mkdir(serviceDirectory, { recursive: true });
    await mkdir(path.join(directory, 'dist'));
    await writeFile(path.join(directory, 'dist/index.html'), 'isolated copy autostart fixture');
    const port = await freePort();
    const marker = path.join(directory, 'service.pid');
    const stop = path.join(directory, 'stop-mock');
    const closed = path.join(directory, 'closed-mock');
    stopFiles.push(stop);
    closedFiles.push(closed);
    const literal = value => JSON.stringify(value.replaceAll('\\', '/'));
    const fake = `using System; using System.IO; using System.Net; using System.Net.Sockets; using System.Threading;
class Mock { static void Main() { var listener = new TcpListener(IPAddress.Loopback, ${port}); listener.Start();
File.WriteAllText(${literal(marker)}, System.Diagnostics.Process.GetCurrentProcess().Id.ToString());
while (!File.Exists(${literal(stop)})) Thread.Sleep(50); listener.Stop(); File.WriteAllText(${literal(closed)}, "closed"); } }`;
    const fakeSource = path.join(directory, 'Mock.cs');
    await writeFile(fakeSource, fake);
    compile(fakeSource, path.join(serviceDirectory, 'CopyTrading.exe'));
    const source = (await readFile(path.join(root, 'server/StaticServer.cs'), 'utf8'))
      .replace('private const string CopyServiceOrigin = "http://127.0.0.1:8092";', `private const string CopyServiceOrigin = "http://127.0.0.1:${port}";`);
    assert(!source.includes('private const string CopyServiceOrigin = "http://127.0.0.1:8092";'));
    const serverSource = path.join(directory, 'StaticServer.cs');
    const executable = path.join(directory, 'TestStaticServer.exe');
    await writeFile(serverSource, source);
    compile(serverSource, executable);
    const launch = async () => {
      const webPort = await freePort();
      const child = spawn(executable, [String(webPort), '--no-browser'], { windowsHide: true, stdio: 'ignore' });
      servers.push(child);
      await waitFor(async () => (await fetch(`http://127.0.0.1:${webPort}`)).ok);
      return child;
    };
    const first = await launch();
    await waitFor(async () => Number(await readFile(marker, 'utf8')) > 0);
    const firstId = await readFile(marker, 'utf8');
    const second = await launch();
    await pause(300);
    assert.equal(await readFile(marker, 'utf8'), firstId, 'second terminal must preserve the running copy service');
    await stopServer(first);
    await stopServer(second);
    assert.doesNotThrow(() => process.kill(Number(firstId), 0), 'closing the web server must leave the copy service running');
    await writeFile(stop, 'stop this temporary mock');
    await waitFor(async () => (await readFile(closed, 'utf8')) === 'closed');
    console.log(`PASS static copy service ${layout}: automatic start, existing process preserved, independent lifecycle`);
  }
} finally {
  for (const child of servers) await stopServer(child);
  for (const stop of stopFiles) await writeFile(stop, 'test cleanup');
  for (const closed of closedFiles) {
    try { await waitFor(async () => (await readFile(closed, 'utf8')) === 'closed'); } catch { /* failed before launch */ }
  }
  // Wait for the mock's executable handle to close after it writes its marker.
  await pause(150);
  const resolved = path.resolve(work);
  assert(resolved.startsWith(path.resolve(tempRoot) + path.sep));
  await rm(resolved, { recursive: true, force: true });
}
