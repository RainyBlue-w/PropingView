import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from '../app/node_modules/typescript/lib/typescript.js';

const exports = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/src/lib/chartInstrument.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports });
const matches = exports.matchesChartInstrument;
const trade = 'MNQU6@CME#atas-id=ContractIdentifier(33268:)';
const chart = '#MNQU6@CME';
const delayed = 'MNQU6@CME#atas-id=ContractIdentifier(/MNQU26:XCME:Delayed15M)';
const row = { instrument: trade, chartSymbols: [trade, chart] };
assert(matches(row, trade), 'original native identity continues to match');
assert(matches(row, chart), 'an explicitly verified native chart alias can display the position');
assert(!matches({ instrument: trade }, chart), 'similar security IDs alone do not authorize a display alias');
assert(!matches(row, 'MNQU6@CME'), 'ambiguous bare symbols are not synthesized');
assert(!matches(row, chart.replace('MNQU6', 'MNQZ6')), 'other expiries remain separate');
assert(!matches(row, chart.replace('CME', 'OTHER')), 'other markets remain separate');
assert(matches({ instrument: 'NQ 09-26' }, 'NQ 09-26'), 'ordinary NT8 native symbols remain supported');
assert(!matches({ instrument: 'NQ 09-26' }, 'NQ 12-26'), 'NT8 expiries stay exact');
assert(!matches({ instrument: trade, chartSymbols: chart }, chart), 'malformed string metadata is not accepted as an alias list');
assert(matches(row, trade.toUpperCase()), 'TradingView uppercase full contract IDs match the original native position');
assert(matches({ instrument: 'other', chartSymbols: [trade] }, trade.toUpperCase()), 'explicit full-ID aliases accept TradingView uppercase spelling');
assert(!matches(row, delayed.toUpperCase()), 'a different delayed source never matches even after case normalization');
assert(!matches(row, trade.replace('33268', '99999').toUpperCase()), 'different native IDs remain separate after case normalization');
assert(!matches({ instrument: trade, chartSymbols: [null, 123] }, chart), 'malformed alias entries do not throw or match');
assert.equal(row.instrument, trade, 'display matching never rewrites the trading instrument');
assert.equal(row.chartSymbols[0], trade, 'case normalization does not modify native alias metadata');
console.log('PASS 16 native chart identity checks');
