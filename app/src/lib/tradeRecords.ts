import type { Nt8Execution } from './nt8Trading';
import { analyzeTrades, compareExecutions, executionKey, isValidTradeExecution, normalizeCurrency, summarizeMatchedTrades, type MatchedTrade } from './tradeAnalytics';
import { filterTradeHistory, type TradeAccountGroups, type TradeHistoryFilters } from './tradeHistoryFilters';

export interface TradeRecord {
  id: string;
  entry: Nt8Execution;
  exit?: Nt8Execution;
  qty: number;
  currency: string;
  gross?: number;
  net?: number;
  commission?: number;
  status: 'closed' | 'unpaired' | 'invalid';
  pair?: MatchedTrade;
}

function compareRecords(a: TradeRecord, b: TradeRecord): number {
  return compareExecutions(b.exit ?? b.entry, a.exit ?? a.entry)
    || compareExecutions(b.entry, a.entry) || a.id.localeCompare(b.id);
}

/** Pair the complete archive before filtering so an earlier entry is available to a later exit. */
export function buildTradeRecords(rows: Nt8Execution[]): TradeRecord[] {
  const { trades, openLots } = analyzeTrades(rows);
  const records: TradeRecord[] = trades.map(pair => ({
    ...pair, status: 'closed', pair,
    id: JSON.stringify(['closed', executionKey(pair.entry), executionKey(pair.exit)]),
  }));
  for (const { row, remaining } of openLots) {
    records.push({
      id: JSON.stringify(['unpaired', executionKey(row)]), status: 'unpaired',
      entry: row, qty: remaining, currency: normalizeCurrency(row.currency),
      commission: Number.isFinite(row.commission) ? row.commission! * remaining / row.qty : undefined,
    });
  }
  for (const row of rows) {
    if (!isValidTradeExecution(row)) {
      records.push({
        id: JSON.stringify(['invalid', executionKey(row)]), status: 'invalid',
        entry: row, qty: row.qty, currency: normalizeCurrency(row.currency), commission: row.commission,
      });
    }
  }
  return records.sort(compareRecords);
}

/** Closed rows use their exit time; unpaired/invalid rows use their original execution time. */
export function filterTradeRecords(records: TradeRecord[], filters: TradeHistoryFilters, groups: TradeAccountGroups) {
  const { rows, dateError } = filterTradeHistory(records.map(record => record.exit ?? record.entry), filters, groups);
  const selected = new Set(rows);
  return { records: records.filter(record => selected.has(record.exit ?? record.entry)).sort(compareRecords), dateError };
}

/** Summarize the selected FIFO allocations without matching a reduced set of executions again. */
export function summarizeTradeRecords(records: TradeRecord[]): ReturnType<typeof analyzeTrades> {
  const trades = records.flatMap(record => record.status === 'closed' && record.pair ? [record.pair] : [])
    .sort((a, b) => compareExecutions(a.exit, b.exit) || compareExecutions(a.entry, b.entry));
  const openLots = records.filter(record => record.status === 'unpaired').map(record => ({ row: record.entry, remaining: record.qty }));
  const invalid = records.filter(record => record.status === 'invalid').length;
  // A fill may span multiple closed records and a residual lot. Charge only each selected portion.
  const allocations = new Map<Nt8Execution, number>();
  const allocate = (row: Nt8Execution, fraction: number) => allocations.set(row, (allocations.get(row) ?? 0) + fraction);
  for (const record of records) {
    if (record.status === 'invalid') allocate(record.entry, 1);
    else {
      allocate(record.entry, record.qty / record.entry.qty);
      if (record.exit) allocate(record.exit, record.qty / record.exit.qty);
    }
  }
  const costs = [...allocations].map(([row, fraction]) => ({
    currency: row.currency,
    commission: Number.isFinite(row.commission) ? row.commission! * fraction : undefined,
  }));
  return { trades, openLots, invalid, summaries: summarizeMatchedTrades(trades, costs) };
}
