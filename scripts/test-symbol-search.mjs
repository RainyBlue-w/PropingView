// Pure fixture test: no network or trading platform access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from '../app/node_modules/typescript/lib/typescript.js';

const compiled = ts.transpileModule(fs.readFileSync('app/src/lib/symbolSearch.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const exports = {};
vm.runInNewContext(compiled, { exports });
const { filterSymbols } = exports;
const future = (symbol, name = symbol) => Object.freeze({ symbol, name, type: 'futures' });
const atas = future('NQU6@CME#atas-id=ContractIdentifier(33251:)', 'E-mini NASDAQ 100 September 2026');
const ambiguous = future('NQU6@CME#atas-id=ContractIdentifier(99999:)', 'E-mini NASDAQ 100 September 2026');
const micro = future('MNQU6@CME', 'Micro E-mini NASDAQ 100 September 2026');
const nextDecade = future('NQU6@CME#atas-id=ContractIdentifier(2036:)', 'E-mini NASDAQ 100 September 2036');
const december = future('NQZ6@CME', 'E-mini NASDAQ 100 December 2026');
const nt8 = future('NQ 09-26', 'E-mini NASDAQ 100');
const named = future('NQ SEP26', 'E-mini NASDAQ 100');
const compact = future('NQU26', 'E-mini NASDAQ 100');
const unknownYear = future('NQU6@CME#atas-id=ContractIdentifier(7:)', 'E-mini NASDAQ 100 September');
const fixtures = Object.freeze([micro, nextDecade, december, atas, ambiguous, nt8, named, compact, unknownYear]);
let passed = 0;
function test(name, run) { run(); passed++; console.log(`PASS ${name}`); }
const search = (rows, text) => Array.from(filterSymbols(rows, text));
const exact2026 = [atas, ambiguous, nt8, named, compact];
const sameMembers = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  for (const row of expected) assert.ok(actual.includes(row), `missing original ${row.symbol}`);
};

test('numeric, named and compact month aliases find the same exact root and expiry', () => {
  for (const query of ['NQ 09-26', 'nq09-26', 'NQ SEP26', 'NQU26', ' NQ   sep 26 ']) {
    sameMembers(search(fixtures, query), exact2026);
  }
});
test('single-year native codes require an explicit description year before expanding', () => {
  assert.deepEqual(search([unknownYear], 'NQ 09-26'), []);
  assert.deepEqual(search([unknownYear], 'NQU26'), []);
  assert.deepEqual(search([unknownYear], 'NQU6'), [unknownYear]);
  assert.deepEqual(search([atas, nextDecade], 'NQU26'), [atas]);
  assert.deepEqual(search([atas, nextDecade], 'NQU36'), [nextDecade]);
});
test('a short year query shows all matching known decades without choosing one', () => {
  sameMembers(search(fixtures, 'NQU6'), [...exact2026, nextDecade, unknownYear]);
});
test('explicit month and year reject micro contracts and other expiries', () => {
  assert.deepEqual(search([micro, december, nextDecade], 'NQ09-26'), []);
  assert.deepEqual(search([micro, atas], 'MNQ 09-26'), [micro]);
  assert.deepEqual(search([december, atas], 'NQ DEC26'), [december]);
});
test('root code prefix ranks above micro-symbol substring matches', () => {
  const rows = search(fixtures, 'nq');
  assert.equal(rows.at(-1), micro);
  assert.ok(rows.slice(0, -1).every(row => row.symbol.startsWith('NQ')));
});
test('native symbols and conflicting identifiers remain independent original objects', () => {
  const rows = search([ambiguous, atas], 'NQ 09-26');
  assert.deepEqual(rows, [ambiguous, atas]);
  assert.deepEqual(search(fixtures, atas.symbol), [atas]);
  assert.equal(rows[0].symbol, ambiguous.symbol);
});
test('case-insensitive literal product descriptions and native suffixes still match', () => {
  sameMembers(search(fixtures, 'nasdaq'), [...fixtures]);
  sameMembers(search([atas, ambiguous], '@cme'), [atas, ambiguous]);
  assert.deepEqual(search(fixtures, 'ContractIdentifier(33251:)'), [atas]);
});
test('only futures receive expiry aliases', () => {
  for (const type of ['stock', 'forex', undefined]) {
    const row = { ...atas, type };
    assert.deepEqual(search([row], 'NQ 09-26'), []);
    assert.deepEqual(search([row], 'nqu6'), [row]);
  }
});
test('descriptions with conflicting full years do not guess a decade', () => {
  const conflict = future('NQU6@CME', 'Comparison of September 2026 and 2036');
  assert.deepEqual(search([conflict], 'NQ 09-26'), []);
  assert.deepEqual(search([conflict], 'NQ 09-36'), []);
  assert.deepEqual(search([conflict], 'NQU6'), [conflict]);
});
test('full-year searches require a full year instead of inventing a century', () => {
  assert.deepEqual(search([nt8, atas, nextDecade], 'NQ 09-2026'), [atas]);
  assert.deepEqual(search([atas, nextDecade], 'NQU2036'), [nextDecade]);
});
test('other roots and all standard futures months use the same bounded mapping', () => {
  const names = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  for (const [index, letter] of Array.from('FGHJKMNQUVXZ').entries()) {
    const row = future(`6E${letter}26`, `Euro ${names[index]} 2026`);
    assert.deepEqual(search([row], `6E ${String(index + 1).padStart(2, '0')}-26`), [row]);
    assert.deepEqual(search([row], `6E ${names[index]}26`), [row]);
  }
});
test('empty queries preserve source ordering and searches never mutate the input', () => {
  assert.deepEqual(search(fixtures, '  '), [...fixtures]);
  const before = JSON.stringify(fixtures);
  search(fixtures, 'NQU26');
  assert.equal(JSON.stringify(fixtures), before);
});

console.log(`${passed} symbol-search checks passed.`);
