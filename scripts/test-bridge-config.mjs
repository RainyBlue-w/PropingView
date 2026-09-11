import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import ts from '../app/node_modules/typescript/lib/typescript.js';

const source = ts.transpileModule(fs.readFileSync('app/src/lib/config.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function load(page, saved, blocked = false) {
  const storage = new Map(saved == null ? [] : [['nt8-bridge-url', saved]]);
  const context = vm.createContext({
    exports: {}, URL,
    ...(page ? { window: { location: new URL(page) } } : {}),
    localStorage: {
      getItem: key => { if (blocked) throw new Error('Storage denied'); return storage.get(key) ?? null; },
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  });
  vm.runInContext(source, context);
  return context.exports;
}
const local = 'http://127.0.0.1:8090';
for (const page of ['http://127.0.0.1:7200/', 'http://localhost:7100/', 'http://[::1]:7100/']) {
  assert.equal(load(page).getBridgeUrl(), local, 'local HTTP remains compatible with the direct bridge');
}
for (const page of ['http://192.168.1.20:7100/', 'https://terminal.example.com/', 'https://localhost:7200/']) {
  const origin = new URL(page).origin;
  for (const saved of [undefined, '', local, local + '/', 'http://localhost:8090', 'http://[::1]:8090/']) {
    assert.equal(load(page, saved).getBridgeUrl(), origin, 'remote/HTTPS requests use the same origin, including legacy defaults');
  }
  assert.equal(load(page, undefined, true).getBridgeUrl(), origin, 'storage denial must not restore the wrong loopback address');
  assert.equal(load(page).DEFAULT_BRIDGE_URL_DISPLAY, origin);
}
for (const saved of ['https://bridge.example.com/nt8', '/nt8', 'http://127.0.0.1:9000', 'http://192.168.1.20:8090']) {
  assert.equal(load('https://terminal.example.com/', saved).getBridgeUrl(), saved, 'intentional custom endpoints are preserved');
}
const config = load('http://192.168.1.20:7100/');
config.setBridgeUrl('  https://bridge.example.com/nt8///  ');
assert.equal(config.getBridgeUrl(), 'https://bridge.example.com/nt8');
config.setBridgeUrl('');
assert.equal(config.getBridgeUrl(), 'http://192.168.1.20:7100');
assert.equal(load().getBridgeUrl(), local, 'non-browser imports remain supported');
const dual = load('https://terminal.example.com/');
assert.equal(dual.getBridgeUrl('atas'), 'https://terminal.example.com/atas');
assert.equal(load('http://localhost:7100/').getBridgeUrl('atas'), 'http://127.0.0.1:8091');
dual.setBridgeUrl('https://atas.example.com', 'atas');
assert.equal(dual.getBridgeUrl('nt8'), 'https://terminal.example.com');
assert.equal(dual.getBridgeUrl('atas'), 'https://atas.example.com');
dual.setProvider('atas');
assert.equal(dual.getProvider(), 'atas');
assert.equal(dual.getBridgeUrl(), 'https://atas.example.com');
dual.setBridgeUrl('http://127.0.0.1:8091', 'atas');
assert.equal(dual.getBridgeUrl('atas'), 'https://terminal.example.com/atas');
assert.notEqual(dual.bridgeStorageKey('nt8-terminal-chart-workspace', 'atas'), dual.bridgeStorageKey('nt8-terminal-chart-workspace', 'nt8'));
console.log('PASS bridge configuration: local HTTP, remote IP, HTTPS, legacy settings, custom endpoints, reset and unavailable storage');
