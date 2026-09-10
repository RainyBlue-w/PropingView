import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import ts from '../app/node_modules/typescript/lib/typescript.js';

const out = path.resolve('.tmp-webbridge/trade-records');
fs.mkdirSync(out, { recursive: true });
for (const name of ['tradeAnalytics', 'tradeHistoryFilters', 'tradeRecords']) {
  const source = fs.readFileSync(`app/src/lib/${name}.ts`, 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/from '(\.\/\w+)'/g, "from '$1.mjs'");
  fs.writeFileSync(path.join(out, `${name}.mjs`), js);
}
const { buildTradeRecords, filterTradeRecords, summarizeTradeRecords } = await import(pathToFileURL(path.join(out, 'tradeRecords.mjs')));
const { analyzeTrades } = await import(pathToFileURL(path.join(out, 'tradeAnalytics.mjs')));
const { UNKNOWN_ACCOUNT_GROUP } = await import(pathToFileURL(path.join(out, 'tradeHistoryFilters.mjs')));
const make = (id, side, qty, price, extra = {}) => ({ executionId: id, orderId: id, account: 'A', instrument: 'NQ SEP26', time: 100 + Number(id.replace(/\D/g, '') || 0), side, qty, price, pointValue: 20, commission: qty, currency: 'UsDollar', ...extra });
const dated = (date, extra = {}) => ({ time: Math.floor(new Date(date).getTime() / 1000), timeMs: new Date(date).getTime(), ...extra });
const groups = new Map([['A', 'Broker One'], ['B', 'Broker One'], ['C', 'Broker Two']]);
const filters = { group: '', account: '', symbol: '', startDate: '', endDate: '' };
const select = (records, fields = {}) => filterTradeRecords(records, { ...filters, ...fields }, groups);
let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }

test('a long round trip becomes one record with both original fills and realized PnL', () => {
  const entry = make('1', 'Buy', 2, 100);
  const exit = make('2', 'Sell', 2, 110);
  const records = buildTradeRecords([exit, entry]);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.status, 'closed');
  assert.equal(record.entry, entry);
  assert.equal(record.exit, exit);
  assert.equal(record.qty, 2);
  assert.equal(record.gross, 400);
  assert.equal(record.commission, 4);
  assert.equal(record.net, 396);
  assert.equal(record.currency, 'USD');
  assert.equal(record.pair.entry, entry);
});

test('short round trips preserve entry direction and compute the opposite price move', () => {
  const record = buildTradeRecords([make('1', 'Sell', 1, 110), make('2', 'Buy', 1, 100)])[0];
  assert.equal(record.entry.side, 'Sell');
  assert.equal(record.gross, 200);
  assert.equal(record.net, 198);
});

test('partial exits produce one row per allocation and preserve the residual quantity', () => {
  const entry = make('1', 'Buy', 4, 100, { commission: 8 });
  const records = buildTradeRecords([entry, make('2', 'Sell', 1, 110, { commission: 3 }), make('3', 'Sell', 2, 105, { commission: 6 })]);
  assert.deepEqual(records.map(row => [row.status, row.qty, row.entry.price, row.exit?.price, row.net]), [
    ['closed', 2, 100, 105, 190], ['closed', 1, 100, 110, 195], ['unpaired', 1, 100, undefined, undefined],
  ]);
  assert.equal(records[2].commission, 2);
  assert.equal(new Set(records.map(row => row.id)).size, records.length);
  assert.equal(summarizeTradeRecords(records).summaries[0].fees, 17);
});

test('one exit can close multiple FIFO entries without losing their prices or identities', () => {
  const rows = [make('1', 'Buy', 1, 100), make('2', 'Buy', 2, 110), make('3', 'Sell', 3, 120)];
  const records = buildTradeRecords(rows);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(row => [row.entry.price, row.exit.price, row.qty, row.gross]), [[110, 120, 2, 400], [100, 120, 1, 400]]);
  assert.equal(new Set(records.map(row => row.id)).size, 2);
  assert.deepEqual(records.map(row => row.id), buildTradeRecords([...rows].reverse()).map(row => row.id));
});

test('a reversal is divided into the closing allocation and an unpaired new direction', () => {
  const rows = [make('1', 'Buy', 1, 100), make('2', 'Sell', 3, 110, { commission: 6 })];
  const records = buildTradeRecords(rows);
  const closed = records.find(row => row.status === 'closed');
  const open = records.find(row => row.status === 'unpaired');
  assert.equal(closed.qty, 1);
  assert.equal(closed.commission, 3);
  assert.equal(open.entry.side, 'Sell');
  assert.equal(open.qty, 2);
  assert.equal(open.commission, 4);
  assert.equal(open.exit, undefined);
  assert.equal(open.gross, undefined);
  assert.equal(open.net, undefined);
  assert.equal(summarizeTradeRecords(records).summaries[0].fees, 7);
  assert.equal(summarizeTradeRecords([closed]).summaries[0].fees, 3);
  assert.equal(summarizeTradeRecords([open]).summaries[0].fees, 4);
});

test('accounts, contracts and currencies remain separate FIFO queues', () => {
  const rows = [make('1', 'Buy', 1, 100), make('2', 'Sell', 1, 110, { account: 'B' }), make('3', 'Sell', 1, 110, { instrument: 'ES SEP26' }), make('4', 'Sell', 1, 110, { currency: 'EUR' })];
  const records = buildTradeRecords(rows);
  assert.equal(records.length, 4);
  assert.ok(records.every(row => row.status === 'unpaired'));
  assert.equal(summarizeTradeRecords(records).summaries.length, 2);
});

test('date filtering keeps the original cross-day entry and filters by the closed exit', () => {
  const entry = make('1', 'Buy', 2, 100, dated('2026-09-08T23:00:00', { commission: 4 }));
  const firstExit = make('2', 'Sell', 1, 110, dated('2026-09-09T12:00:00', { commission: 3 }));
  const secondExit = make('3', 'Sell', 1, 120, dated('2026-09-10T12:00:00', { commission: 3 }));
  const records = buildTradeRecords([entry, firstExit, secondExit]);
  const selected = select(records, { startDate: '2026-09-09', endDate: '2026-09-09' });
  assert.equal(selected.dateError, '');
  assert.equal(selected.records.length, 1);
  assert.equal(selected.records[0].entry, entry);
  assert.equal(selected.records[0].exit, firstExit);
  const stats = summarizeTradeRecords(selected.records);
  assert.equal(stats.trades.length, 1);
  assert.equal(stats.openLots.length, 0);
  assert.equal(stats.summaries[0].net, 195);
  assert.equal(stats.summaries[0].fees, 5);
  assert.equal(select(records, { endDate: '2026-09-08' }).records.length, 0);
});

test('date selection cannot rematch later exits to an incorrect entry', () => {
  const rows = [make('1', 'Buy', 1, 100, dated('2026-09-07T12:00:00')), make('2', 'Buy', 1, 110, dated('2026-09-08T12:00:00')), make('3', 'Sell', 1, 120, dated('2026-09-09T12:00:00')), make('4', 'Sell', 1, 130, dated('2026-09-10T12:00:00'))];
  const selected = select(buildTradeRecords(rows), { startDate: '2026-09-10', endDate: '2026-09-10' }).records;
  assert.equal(selected.length, 1);
  assert.equal(selected[0].entry.price, 110);
  assert.equal(selected[0].exit.price, 130);
  assert.equal(summarizeTradeRecords(selected).summaries[0].net, 398);
});

test('group, account and contract conditions intersect and archived unknown accounts remain visible', () => {
  const records = buildTradeRecords([make('1', 'Buy', 1, 100), make('2', 'Buy', 1, 100, { account: 'B' }), make('3', 'Buy', 1, 100, { account: 'C' }), make('4', 'Buy', 1, 100, { instrument: 'ES SEP26' }), make('5', 'Buy', 1, 100, { account: 'Archived' })]);
  assert.equal(select(records, { group: 'Broker One', account: 'A', symbol: 'NQ SEP26' }).records.length, 1);
  assert.equal(select(records, { group: 'Broker One', account: 'C' }).records.length, 0);
  assert.equal(select(records, { group: UNKNOWN_ACCOUNT_GROUP }).records[0].entry.account, 'Archived');
});

test('incomplete executions stay visible without fabricated entry-exit pairs or PnL', () => {
  const rows = [make('1', 'Unknown', 1, 100), make('2', 'Sell', 1, 100, { account: undefined }), make('3', 'Buy', Infinity, 100), make('4', 'Buy', 1, NaN)];
  const records = buildTradeRecords(rows);
  assert.equal(records.length, rows.length);
  assert.ok(records.every(row => row.status === 'invalid' && row.exit === undefined && row.gross === undefined && row.net === undefined));
  assert.equal(summarizeTradeRecords(records).invalid, rows.length);
  assert.equal(select(records, { account: '未知账户' }).records.length, 1);
});

test('unknown metadata preserves known gross or known fee portions without fabricating net PnL', () => {
  const rows = [make('1', 'Buy', 2, 100, { commission: undefined }), make('2', 'Sell', 1, 110, { commission: 3 }), make('3', 'Sell', 1, 120, { pointValue: undefined, commission: 3 })];
  const records = buildTradeRecords(rows);
  assert.ok(records.every(row => row.net === undefined && row.commission === undefined));
  assert.equal(records.find(row => row.exit.executionId === '2').gross, 200);
  assert.equal(records.find(row => row.exit.executionId === '3').gross, undefined);
  const stats = summarizeTradeRecords(records).summaries[0];
  assert.equal(stats.fees, 6);
  assert.equal(stats.missingFees, 1);
  assert.equal(stats.missing, 2);
  const filteredStats = summarizeTradeRecords([records[0]]).summaries[0];
  assert.equal(filteredStats.fees, 3);
  assert.equal(filteredStats.missingFees, 1);
});

test('latest-first rows retain chronological drawdown calculations and match full archive statistics', () => {
  const rows = [make('1', 'Buy', 1, 100), make('2', 'Sell', 1, 110), make('3', 'Buy', 1, 110), make('4', 'Sell', 1, 100), make('5', 'Buy', 1, 100, { currency: 'EUR' }), make('6', 'Sell', 1, 102, { currency: 'EUR' }), make('7', 'Buy', 1, 100), make('8', 'Unknown', 1, 100, { commission: undefined })];
  const records = buildTradeRecords(rows);
  const summary = summarizeTradeRecords(records);
  const original = analyzeTrades(rows);
  assert.deepEqual(summary.summaries, original.summaries);
  assert.deepEqual(summary.trades, original.trades);
  assert.deepEqual(summary.openLots, original.openLots);
  assert.equal(summary.invalid, original.invalid);
  assert.equal(summary.summaries.find(row => row.currency === 'USD').maxDrawdown, 202);
});

test('same-second milliseconds and sequence control pairing and displayed chronology', () => {
  const records = buildTradeRecords([make('a', 'Sell', 1, 110, { time: 100, timeMs: 100200, sequence: 3 }), make('z', 'Buy', 1, 100, { time: 100, timeMs: 100100, sequence: 1 }), make('x', 'Buy', 1, 120, { time: 100, timeMs: 100200, sequence: 4 }), make('b', 'Sell', 1, 130, { time: 100, timeMs: 100200, sequence: 5 })]);
  assert.deepEqual(records.map(row => [row.entry.executionId, row.exit.executionId]), [['x', 'b'], ['z', 'a']]);
  assert.deepEqual(summarizeTradeRecords(records).trades.map(row => row.exit.executionId), ['a', 'b']);
});

test('inclusive local date boundaries use milliseconds and unpaired execution time', () => {
  const records = buildTradeRecords([make('1', 'Buy', 1, 100, dated('2026-09-08T23:59:59.999')), make('2', 'Buy', 1, 100, dated('2026-09-09T00:00:00')), make('3', 'Buy', 1, 100, dated('2026-09-09T23:59:59.999')), make('4', 'Buy', 1, 100, dated('2026-09-10T00:00:00'))]);
  assert.deepEqual(select(records, { startDate: '2026-09-09', endDate: '2026-09-09' }).records.map(row => row.entry.executionId), ['3', '2']);
});

test('invalid date ranges return an explicit error and no matched rows', () => {
  const records = buildTradeRecords([make('1', 'Buy', 1, 100)]);
  for (const fields of [{ startDate: '2026-09-10', endDate: '2026-09-09' }, { startDate: '2026-02-30' }]) {
    const result = select(records, fields);
    assert.equal(result.records.length, 0);
    assert.ok(result.dateError);
  }
});

test('building, filtering and summarizing never mutate stored execution objects', () => {
  const rows = [Object.freeze(make('2', 'Sell', 1, 110)), Object.freeze(make('1', 'Buy', 2, 100))];
  const original = structuredClone(rows);
  Object.freeze(rows);
  const records = buildTradeRecords(rows);
  const ids = records.map(row => row.id);
  Object.freeze(records);
  summarizeTradeRecords(select(records).records);
  assert.deepEqual(rows, original);
  assert.deepEqual(records.map(row => row.id), ids);
  assert.deepEqual(buildTradeRecords([]), []);
  assert.deepEqual(summarizeTradeRecords([]), { trades: [], openLots: [], invalid: 0, summaries: [] });
});

console.log(`Passed ${passed} paired trade record scenarios.`);
