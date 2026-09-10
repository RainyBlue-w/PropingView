import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import ts from '../app/node_modules/typescript/lib/typescript.js';

const out = path.resolve('.tmp-webbridge/layout-store');
fs.mkdirSync(out, { recursive: true });
const source = fs.readFileSync('app/src/lib/tvLayoutStore.ts', 'utf8');
fs.writeFileSync(path.join(out, 'tvLayoutStore.mjs'), ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText);
const { createLayoutAdapter, getLastSavedLayout, getLayoutSavedData, rememberLayout, hasSavedLayout } = await import(pathToFileURL(path.join(out, 'tvLayoutStore.mjs')));
const LEGACY = 'nt8-terminal-tv-layout';
const CURRENT = 'nt8-terminal-tv-layouts-v2';
const data = new Map();
let quotaFailure = false;
let readFailure = false;
globalThis.localStorage = {
  getItem(key) { if (readFailure) throw new Error('Access denied'); return data.get(key) ?? null; },
  setItem(key, value) { if (quotaFailure) throw new Error('Quota exceeded'); data.set(key, String(value)); },
};
const state = (symbol = 'NQ SEP26', interval = '5') => ({ charts: [{ panes: [{ sources: [{ type: 'MainSeries', state: { symbol, interval } }] }] }] });
const chart = (name = 'Layout A', symbol = 'NQ SEP26', resolution = '5', timestamp = 100) => ({
  name, symbol, resolution, timestamp,
  content: JSON.stringify({ name, symbol, resolution, content: JSON.stringify(state(symbol, resolution)) }),
});
let passed = 0;
async function test(name, run) {
  data.clear(); quotaFailure = false; readFailure = false;
  await run(); passed++; console.log(`PASS ${name}`);
}

await test('empty storage contains no phantom layout', async () => {
  assert.equal(hasSavedLayout(), false);
  assert.equal(getLastSavedLayout(), null);
  assert.deepEqual(await createLayoutAdapter().getAllCharts(), []);
});
await test('legacy outer record migrates once and keeps its original backup', async () => {
  const saved = JSON.stringify({ ...JSON.parse(chart().content), id: 42, timestamp: 123 });
  data.set(LEGACY, saved);
  const old = getLastSavedLayout();
  assert.equal(old.id, '42'); assert.equal(old.name, 'Layout A'); assert.equal(old.timestamp, 123);
  assert.equal(old.symbol, 'NQ SEP26'); assert.equal(old.resolution, '5');
  assert.equal(data.get(LEGACY), saved);
  assert.equal(JSON.parse(data.get(CURRENT)).version, 2);
  const restored = getLayoutSavedData(old);
  assert.equal(restored.extendedData.uid, '42'); assert.equal(restored.extendedData.name, 'Layout A');
  assert.deepEqual(restored.charts, state().charts);
  await createLayoutAdapter().removeChart('42');
  assert.equal(hasSavedLayout(), false); assert.equal(getLastSavedLayout(), null);
  assert.equal(data.get(LEGACY), saved);
});
await test('legacy internal JSON is wrapped for native loading and extracts main series metadata', async () => {
  data.set(LEGACY, JSON.stringify(state('ES SEP26', '15')));
  const old = getLastSavedLayout();
  assert.equal(old.symbol, 'ES SEP26'); assert.equal(old.resolution, '15'); assert.equal(old.timestamp, 0);
  const native = JSON.parse(await createLayoutAdapter().getChartContent(old.id));
  assert.deepEqual(JSON.parse(native.content), state('ES SEP26', '15'));
});
await test('invalid legacy content is retained without creating a broken new store', async () => {
  for (const raw of ['{broken', '{}', JSON.stringify({ content: 'null' })]) {
    data.set(LEGACY, raw);
    assert.throws(() => getLastSavedLayout());
    assert.equal(data.get(LEGACY), raw); assert.equal(data.has(CURRENT), false);
  }
});
await test('new layouts have independent IDs and names, updates only affect their own record', async () => {
  const adapter = createLayoutAdapter();
  const a = await adapter.saveChart(chart());
  const b = await adapter.saveChart(chart('Layout B', 'ES SEP26', '1', 200));
  assert.notEqual(a, b);
  const beforeA = await adapter.getChartContent(a);
  await adapter.saveChart({ ...chart('Renamed B', 'ES SEP26', '1', 300), id: b });
  assert.equal(await adapter.getChartContent(a), beforeA);
  assert.deepEqual(await adapter.getAllCharts(), [
    { id: a, name: 'Layout A', symbol: 'NQ SEP26', resolution: '5', timestamp: 100 },
    { id: b, name: 'Renamed B', symbol: 'ES SEP26', resolution: '1', timestamp: 300 },
  ]);
  await adapter.removeChart(a);
  assert.equal((await adapter.getAllCharts()).length, 1);
  assert.equal(getLastSavedLayout().id, b);
});
await test('opening an older layout restores it next time without changing modification timestamps', async () => {
  const seen = [];
  const adapter = createLayoutAdapter({ onChartLoadRequested: (id) => seen.push(id) });
  const a = await adapter.saveChart(chart());
  const b = await adapter.saveChart(chart('Layout B', 'ES SEP26', '1', 200));
  const before = await adapter.getAllCharts();
  await adapter.getChartContent(a);
  assert.deepEqual(seen, [a]);
  assert.equal(getLastSavedLayout().id, b, 'reading alone does not imply a successful chart load');
  rememberLayout(a);
  assert.equal(getLastSavedLayout().id, a);
  assert.deepEqual(await adapter.getAllCharts(), before);
  await adapter.removeChart(a);
  assert.equal(getLastSavedLayout().id, b);
});
await test('unknown IDs never read, delete, or overwrite another layout', async () => {
  const adapter = createLayoutAdapter();
  await adapter.saveChart(chart());
  const before = data.get(CURRENT);
  await assert.rejects(adapter.getChartContent('missing'), /missing/);
  await assert.rejects(adapter.removeChart('missing'), /missing/);
  await assert.rejects(adapter.saveChart({ ...chart(), id: 'missing' }), /missing/);
  assert.throws(() => rememberLayout('missing'), /missing/);
  assert.equal(data.get(CURRENT), before);
});
await test('quota failure rejects updates and deletion while preserving every saved byte', async () => {
  const adapter = createLayoutAdapter();
  const a = await adapter.saveChart(chart());
  const b = await adapter.saveChart(chart('Layout B'));
  const before = data.get(CURRENT);
  quotaFailure = true;
  await assert.rejects(adapter.saveChart({ ...chart('Changed'), id: a }), /Quota/);
  await assert.rejects(adapter.saveChart(chart('New')), /Quota/);
  await assert.rejects(adapter.removeChart(b), /Quota/);
  assert.throws(() => rememberLayout(a), /Quota/);
  assert.equal(data.get(CURRENT), before);
});
await test('failed migration preserves legacy data and can retry after storage recovers', async () => {
  const saved = chart().content;
  data.set(LEGACY, saved); quotaFailure = true;
  assert.throws(() => getLastSavedLayout(), /Quota/);
  assert.equal(data.get(LEGACY), saved); assert.equal(data.has(CURRENT), false);
  quotaFailure = false;
  assert.equal(getLastSavedLayout().name, 'Layout A');
});
await test('corrupt new storage cannot silently fall back to legacy and overwrite it', async () => {
  for (const raw of ['{broken', '{}', JSON.stringify({ version: 2, charts: [], lastOpenedId: 'missing' })]) {
    data.set(CURRENT, raw); data.set(LEGACY, chart().content);
    assert.throws(() => getLastSavedLayout());
    assert.throws(() => hasSavedLayout());
    await assert.rejects(createLayoutAdapter().saveChart(chart('Replacement')));
    assert.equal(data.get(CURRENT), raw);
  }
});
await test('read failures and invalid new chart content are reported without writing', async () => {
  readFailure = true;
  await assert.rejects(createLayoutAdapter().getAllCharts(), /Access/);
  await assert.rejects(createLayoutAdapter().saveChart(chart()), /Access/);
  readFailure = false;
  await assert.rejects(createLayoutAdapter().saveChart({ ...chart(), content: '{}' }));
  assert.equal(data.size, 0);
});
console.log(`Passed ${passed} layout storage scenarios.`);
