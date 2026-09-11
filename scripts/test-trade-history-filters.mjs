import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import ts from '../app/node_modules/typescript/lib/typescript.js';

const out = path.resolve('.tmp-webbridge/trade-history-filters');
fs.mkdirSync(out, { recursive: true });
for (const name of ['config', 'bridgeAccounts', 'tradeAnalytics', 'tradeHistoryFilters']) {
  const source = fs.readFileSync(`app/src/lib/${name}.ts`, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/from '(\.\/.+?)'/g, "from '$1.mjs'");
  fs.writeFileSync(path.join(out, `${name}.mjs`), js);
}
const storage = new Map();
let rejectStorage = false;
globalThis.localStorage = {
  getItem: key => { if (rejectStorage) throw new Error('Storage unavailable'); return storage.get(key) ?? null; },
  setItem: (key, value) => { if (rejectStorage) throw new Error('Storage unavailable'); storage.set(key, value); },
};
const moduleUrl = pathToFileURL(path.join(out, 'tradeHistoryFilters.mjs'));
const { filterTradeHistory, tradeHistoryDateRange, tradeHistoryFilterOptions, rememberTradeAccounts, getTradeAccountGroups, subscribeTradeAccountGroups } = await import(moduleUrl);
const groups = new Map([['A', 'Broker One'], ['B', 'Broker One'], ['C', 'Broker Two']]);
const empty = { group: '', account: '', symbol: '', startDate: '', endDate: '' };
const make = (id, date, extra = {}) => ({ executionId: id, orderId: id, account: 'A', instrument: 'NQ SEP26', time: Math.floor(new Date(date).getTime() / 1000), timeMs: new Date(date).getTime(), side: 'Buy', qty: 1, price: 100, ...extra });
const filter = (rows, fields = {}) => filterTradeHistory(rows, { ...empty, ...fields }, groups);
const ids = result => result.rows.map(row => row.executionId);
let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }

test('all conditions intersect and source rows retain original order', () => {
  const rows = [
    make('match', '2026-09-09T13:00:00'),
    make('other-account', '2026-09-09T13:00:00', { account: 'B' }),
    make('other-group', '2026-09-09T13:00:00', { account: 'C' }),
    make('other-symbol', '2026-09-09T13:00:00', { instrument: 'ES SEP26' }),
    make('before', '2026-09-08T23:59:59.999'),
    make('after', '2026-09-10T00:00:00'),
  ];
  const originalIds = rows.map(row => row.executionId);
  assert.deepEqual(ids(filter(rows, { group: 'Broker One', account: 'A', symbol: 'NQ SEP26', startDate: '2026-09-09', endDate: '2026-09-09' })), ['match']);
  assert.deepEqual(rows.map(row => row.executionId), originalIds);
  assert.equal(filter(rows).rows.length, rows.length);
});

test('inclusive local calendar days preserve millisecond end-of-day fills', () => {
  const rows = [make('before', '2026-09-08T23:59:59.999'), make('first', '2026-09-09T00:00:00'), make('last', '2026-09-09T23:59:59.999'), make('after', '2026-09-10T00:00:00')];
  assert.deepEqual(ids(filter(rows, { startDate: '2026-09-09', endDate: '2026-09-09' })), ['last', 'first']);
  assert.deepEqual(ids(filter(rows, { startDate: '2026-09-09' })), ['after', 'last', 'first']);
  assert.deepEqual(ids(filter(rows, { endDate: '2026-09-09' })), ['last', 'first', 'before']);
});

test('invalid or reversed date ranges explicitly match nothing', () => {
  const rows = [make('one', '2026-09-09T13:00:00')];
  for (const fields of [{ startDate: '2026-09-10', endDate: '2026-09-09' }, { startDate: '2026-02-30' }, { endDate: 'invalid' }]) {
    const result = filter(rows, fields);
    assert.equal(result.rows.length, 0);
    assert.ok(result.dateError);
  }
  assert.equal(tradeHistoryDateRange('2028-02-29', '').error, '');
});

test('date bounds follow daylight saving rather than fixed 24-hour intervals', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const spring = tradeHistoryDateRange('2026-03-08', '2026-03-08');
    const fall = tradeHistoryDateRange('2026-11-01', '2026-11-01');
    assert.equal((spring.until - spring.from) / 3600000, 23);
    assert.equal((fall.until - fall.from) / 3600000, 25);
  } finally {
    if (previous == null) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('archived unknown accounts stay filterable and group restricts account options', () => {
  const rows = [make('a', '2026-09-09T00:00:00'), make('b', '2026-09-09T00:00:00', { account: 'B' }), make('old', '2026-09-09T00:00:00', { account: 'RemovedAccount', instrument: 'ES SEP26' }), make('missing', '2026-09-09T00:00:00', { account: undefined })];
  const options = tradeHistoryFilterOptions(rows, groups, 'Broker One');
  assert.deepEqual(options.accounts, ['A', 'B']);
  assert.ok(options.groups.includes('未分组'));
  assert.ok(!options.groups.includes('Broker Two'));
  assert.deepEqual(options.symbols, ['ES SEP26', 'NQ SEP26']);
  assert.equal(filter(rows, { group: '未分组' }).rows.length, 2);
  assert.deepEqual(ids(filter(rows, { account: 'RemovedAccount' })), ['old']);
  assert.deepEqual(ids(filter(rows, { group: 'Broker One', account: 'RemovedAccount' })), []);
});

test('single-session options never include accounts from live metadata', () => {
  const rows = [make('sim', '2026-09-09T00:00:00', { account: 'Replay' })];
  const options = tradeHistoryFilterOptions(rows, groups);
  assert.deepEqual(options.accounts, ['Replay']);
  assert.deepEqual(options.groups, ['未分组']);
});

test('default sorting uses original milliseconds and filtering does not truncate at a page', () => {
  const rows = Array.from({ length: 230 }, (_, i) => make(`fill-${i}`, '2026-09-09T12:00:00', { timeMs: new Date('2026-09-09T12:00:00').getTime() + i }));
  const result = filter(rows, { startDate: '2026-09-09' });
  assert.equal(result.rows.length, 230);
  assert.equal(result.rows[0].executionId, 'fill-229');
  assert.equal(result.rows.at(-1).executionId, 'fill-0');
});

test('account metadata retains disconnected accounts and publishes only actual changes', () => {
  const first = getTradeAccountGroups();
  let calls = 0;
  const unsubscribe = subscribeTradeAccountGroups(() => { calls++; });
  rememberTradeAccounts([{ name: 'A', connection: 'Broker One' }, { name: 'Local' }]);
  assert.notEqual(getTradeAccountGroups(), first);
  const next = getTradeAccountGroups();
  rememberTradeAccounts([]);
  rememberTradeAccounts([{ name: 'A', connection: 'Broker One' }]);
  assert.equal(getTradeAccountGroups(), next);
  assert.equal(calls, 1);
  assert.equal(next.get('Local'), '本地账户');
  rememberTradeAccounts([{ name: 'A', connection: 'Broker Two' }]);
  assert.equal(getTradeAccountGroups().get('A'), 'Broker Two');
  assert.equal(getTradeAccountGroups().get('Local'), '本地账户');
  assert.equal(calls, 2);
  unsubscribe();
});

const restored = await import(`${moduleUrl.href}?reload`);
test('fresh module restores persisted connections for offline archived records', () => {
  const remembered = restored.getTradeAccountGroups();
  assert.equal(remembered.get('bridge:nt8:A'), 'NT8 · Broker Two');
  assert.equal(remembered.get('bridge:nt8:Local'), 'NT8 · 本地账户');
  const rows = [make('old', '2026-09-09T00:00:00', { account: 'bridge:nt8:A' })];
  assert.equal(filterTradeHistory(rows, { ...empty, group: 'NT8 · Broker Two' }, remembered).rows.length, 1);
});

test('storage failures leave current-session filters functional', () => {
  rejectStorage = true;
  try {
    rememberTradeAccounts([{ name: 'Offline', connection: 'Retained in memory' }]);
    assert.equal(getTradeAccountGroups().get('Offline'), 'Retained in memory');
  } finally { rejectStorage = false; }
});

storage.set('nt8-terminal-history-account-groups-v1', JSON.stringify([null, ['broken'], ['Valid', 'Connection'], [42, 'bad'], ['__proto__', 'Safe name']]));
const malformed = await import(`${moduleUrl.href}?malformed`);
test('invalid cached entries are ignored without losing valid accounts', () => {
  assert.deepEqual([...malformed.getTradeAccountGroups()], [['bridge:nt8:Valid', 'NT8 · Connection'], ['bridge:nt8:__proto__', 'NT8 · Safe name']]);
});

console.log(`Passed ${passed} trade history filter scenarios.`);
