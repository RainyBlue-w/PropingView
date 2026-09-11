// Isolated API and React-state fixtures. No real server, browser or trading account is contacted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from '../app/node_modules/typescript/lib/typescript.js';

function compile(filename, imports = {}, globals = {}) {
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: name => { assert.ok(name in imports, `unexpected import ${name}`); return imports[name]; },
    console, Error, structuredClone, setTimeout, clearTimeout, AbortController, ...globals });
  return exports;
}
const calls = [];
let reply = { ok: true, status: 200, data: { version: 1, rules: [], logs: [] } };
const client = compile('app/src/lib/copyTrading.ts', {}, { fetch: async (url, options) => {
  assert.ok(url.startsWith('/copy/api/'), 'copy commands must use their dedicated same-origin service');
  calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
  return { ok: reply.ok, status: reply.status, json: async () => reply.data };
} });
const leader = { provider: 'nt8', name: 'Shared/@ 账户' };
const follower = { provider: 'atas', name: 'stable-id:Shared/@ 账户' };
const config = { id: 'rule/@ 1', name: '复制组', leader,
  followers: [{ account: follower, multiplier: 0.5, maxOrderQuantity: 2,
    mappings: [{ sourceSymbol: 'NQ SEP26', targetSymbol: 'NQU6@CME#atas-id=ContractIdentifier(123:)' }] }] };
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await test('same-named accounts remain distinct by provider and raw account identity', () => {
  assert.notEqual(client.copyAccountKey(leader), client.copyAccountKey({ ...leader, provider: 'atas' }));
  assert.equal(client.validateCopyRule(config), null);
  assert.match(client.validateCopyRule({ ...config, followers: [{ ...config.followers[0], account: leader }] }), /重复/);
});
await test('cross-bridge mappings and risk quantities are validated without rewriting native symbols', () => {
  const change = patch => ({ ...config, followers: [{ ...config.followers[0], ...patch }] });
  assert.match(client.validateCopyRule(change({ mappings: [] })), /跨桥/);
  assert.match(client.validateCopyRule(change({ multiplier: 0 })), /倍率/);
  assert.match(client.validateCopyRule(change({ maxOrderQuantity: 0.5 })), /正整数/);
  assert.match(client.validateCopyRule(change({ mappings: [{ sourceSymbol: 'NQ SEP26', targetSymbol: '' }] })), /映射/);
  assert.equal(client.validateCopyRule(change({ account: { provider: 'nt8', name: 'Follower' }, mappings: [] })), null);
});
await test('reads and all configuration mutations route to the copier and preserve raw account tuples', async () => {
  await client.copyTrading.getStatus(); await client.copyTrading.getAccounts();
  await client.copyTrading.saveRule(config);
  assert.deepEqual(calls.at(-1).body, config);
  await client.copyTrading.startRule(config.id); await client.copyTrading.stopRule(config.id);
  await client.copyTrading.deleteRule(config.id); await client.copyTrading.stopAll();
  assert.deepEqual(calls.map(call => call.url), ['/copy/api/status', '/copy/api/accounts', '/copy/api/rules',
    ...['start', 'stop', 'delete'].map(operation => `/copy/api/rules/${encodeURIComponent(config.id)}/${operation}`), '/copy/api/stop-all']);
  assert.ok(calls.slice(0, 2).every(call => call.method === 'GET'));
  assert.ok(calls.slice(2).every(call => call.method === 'POST'));
  assert.equal(calls[2].body.followers[0].mappings[0].targetSymbol, config.followers[0].mappings[0].targetSymbol);
});
await test('service rejections retain the original reason and do not resolve as success', async () => {
  reply = { ok: false, status: 409, data: { error: '跟随账户存在持仓，未启动。' } };
  await assert.rejects(client.copyTrading.startRule(config.id), /跟随账户存在持仓，未启动/);
});

// Small hook runner exercises real component handlers and late asynchronous responses.
const slots = [];
let cursor = 0;
const effects = [];
const effectSlots = [];
const timers = new Map();
let timerId = 0;
const react = {
  useState(initial) {
    const index = cursor++;
    if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
    return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
  },
  useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
  useMemo(callback) { cursor++; return callback(); },
  useEffect(callback, deps) {
    const index = cursor++;
    const old = effectSlots[index];
    if (!old || deps.some((dep, i) => dep !== old.deps[i])) effects.push(() => {
      old?.cleanup?.(); effectSlots[index] = { deps, cleanup: callback() };
    });
  },
};
const runtime = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
const accountRows = [{ ...leader, displayName: '共享账户', group: '模拟' }, { ...follower, displayName: '共享账户', group: 'TDL' }];
const stopped = { config, status: 'stopped', copiedOrders: 0 };
let server = { version: 1, rules: [stopped], logs: [] };
let pendingPoll, pendingStart;
const pageCalls = [];
const api = {
  getStatus: () => pendingPoll || Promise.resolve(structuredClone(server)),
  getAccounts: async () => ({ accounts: accountRows }),
  startRule: id => { pageCalls.push(['start', id]); return pendingStart || Promise.resolve(server); },
  stopRule: async id => { pageCalls.push(['stop', id]); return server; },
  deleteRule: async id => { pageCalls.push(['delete', id]); return server; },
  stopAll: async () => { pageCalls.push(['stopAll']); return server; },
  saveRule: async value => { pageCalls.push(['save', structuredClone(value)]); return server; },
};
const Page = compile('app/src/sections/CopyTradingPage.tsx', {
  react, 'react/jsx-runtime': runtime,
  'lucide-react': Object.fromEntries(['Copy', 'Plus', 'RefreshCw', 'Square', 'Trash2', 'X'].map(name => [name, () => null])),
  '@/lib/config': { bridgeProviderName: provider => provider === 'nt8' ? 'NT8' : 'ATAS X' },
  '@/lib/copyTrading': { ...client, copyTrading: api },
}, { setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id) }).default;
let tree;
function render() { cursor = 0; tree = Page(); while (effects.length) effects.shift()(); return tree; }
function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(value => nodes(value));
  if (node == null || typeof node !== 'object') return [];
  if (typeof node.type === 'function') return nodes(node.type(node.props));
  return [node, ...nodes(node.props?.children)];
}
function text(node) {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  if (typeof node.type === 'function') return text(node.type(node.props));
  return text(node.props?.children);
}
const button = name => { const node = nodes(tree).find(node => node.type === 'button' && text(node) === name); assert.ok(node, `missing button ${name}`); return node; };
const field = name => { const node = nodes(tree).find(node => ['input', 'select'].includes(node.type) && node.props['aria-label'] === name); assert.ok(node, `missing field ${name}`); return node; };
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); render(); };
const poll = () => { const [id, callback] = [...timers].at(-1); timers.delete(id); callback(); };
render(); await settle();

await test('page displays grouped source identities and editing is not overwritten by background snapshots', async () => {
  button('编辑').props.onClick(); render();
  field('复制规则名称').props.onChange({ target: { value: '尚未保存的名称' } }); render();
  assert.equal(field('主账户').props.value, client.copyAccountKey(leader));
  assert.equal(field('跟随账户 1').props.value, client.copyAccountKey(follower));
  assert.ok(nodes(tree).some(node => node.type === 'option' && node.props.value === client.copyAccountKey(follower) && text(node) === 'ATAS X · 共享账户'));
  assert.ok(nodes(tree).some(node => node.type === 'optgroup' && node.props.label === 'ATAS X · TDL'));
  server = { ...server, rules: [{ ...stopped, config: { ...config, name: '其他浏览器更新' } }] };
  poll(); await settle();
  assert.equal(field('复制规则名称').props.value, '尚未保存的名称');
});
await test('starting waits for acknowledgment and a late older poll cannot revert running state', async () => {
  let releasePoll, releaseStart;
  pendingPoll = new Promise(resolve => { releasePoll = resolve; });
  pendingStart = new Promise(resolve => { releaseStart = resolve; });
  poll();
  button('启用跟随').props.onClick(); render();
  assert.match(text(tree), /已停用/);
  assert.equal(pageCalls.at(-1)[0], 'start');
  server = { ...server, rules: [{ ...stopped, status: 'running', copiedOrders: 2 }] };
  releaseStart(server); await settle();
  assert.ok(button('停止跟随'));
  assert.ok(nodes(tree).some(node => node.type === 'fieldset' && node.props.disabled === true));
  releasePoll({ version: 1, rules: [stopped], logs: [] }); await settle();
  assert.ok(button('停止跟随'));
  pendingPoll = null; pendingStart = null;
});
await test('action failure remains visible across successful polls and does not claim stopped', async () => {
  api.stopRule = async () => { throw new Error('后台拒绝停止：状态正在更新'); };
  button('停止跟随').props.onClick(); await settle();
  assert.match(text(tree), /后台拒绝停止：状态正在更新/);
  assert.ok(button('停止跟随'));
  poll(); await settle();
  assert.match(text(tree), /后台拒绝停止：状态正在更新/);
});
await test('opening and polling the page never starts rules automatically', () => {
  assert.deepEqual(pageCalls, [['start', config.id]]);
  assert.match(text(tree), /不会平仓/);
  assert.match(text(tree), /关闭网页后/);
  assert.match(text(tree), /服务重启后规则停用/);
});
for (const effect of effectSlots) effect?.cleanup?.();
console.log(`${passed} copy-trading API and UI-state checks passed.`);
