import type { Nt8Execution } from './nt8Trading';

export function normalizeCurrency(currency?: string): string {
  const value = currency?.trim() || 'USD';
  return ({ usdollar: 'USD', usd: 'USD', euro: 'EUR', britishpound: 'GBP', japaneseyen: 'JPY', canadiandollar: 'CAD', australiandollar: 'AUD', swissfranc: 'CHF' } as Record<string, string>)[value.toLowerCase()] || value.toUpperCase();
}

export function formatMoney(value?: number | null, currency?: string): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${normalizeCurrency(currency)}`;
}

export function executionKey(row: Nt8Execution): string {
  return JSON.stringify([row.account || '', row.instrument || '', row.executionId || [row.orderId, row.time, row.side, row.qty, row.price]]);
}

export function executionDirection(side: string): number {
  return /^buy/i.test(side) ? 1 : /^sell/i.test(side) ? -1 : 0;
}

export function executionTime(row: Nt8Execution): number {
  return Number.isFinite(row.timeMs) ? row.timeMs! / 1000 : row.time;
}

export function compareExecutions(a: Nt8Execution, b: Nt8Execution): number {
  return executionTime(a) - executionTime(b) || (a.sequence ?? 0) - (b.sequence ?? 0) || executionKey(a).localeCompare(executionKey(b));
}

export interface MatchedTrade {
  entry: Nt8Execution;
  exit: Nt8Execution;
  qty: number;
  currency: string;
  gross?: number;
  commission?: number;
  net?: number;
}

export function isValidTradeExecution(row: Nt8Execution): boolean {
  return !!executionDirection(row.side) && Number.isFinite(row.time) && Number.isFinite(row.price)
    && Number.isFinite(row.qty) && row.qty > 0 && !!row.account && !!row.instrument;
}

/** FIFO runs independently for each account, instrument and currency. Unknown metadata stays unknown. */
export function analyzeTrades(rows: Nt8Execution[]) {
  const groups = new Map<string, { row: Nt8Execution; remaining: number }[]>();
  const trades: MatchedTrade[] = [];
  let invalid = 0;
  for (const row of [...rows].sort(compareExecutions)) {
    const direction = executionDirection(row.side);
    if (!isValidTradeExecution(row)) { invalid++; continue; }
    const currency = normalizeCurrency(row.currency);
    const key = JSON.stringify([row.account, row.instrument, currency]);
    const lots = groups.get(key) || [];
    groups.set(key, lots);
    let remaining = row.qty;
    while (remaining > 0 && lots.length && executionDirection(lots[0].row.side) !== direction) {
      const lot = lots[0];
      const qty = Math.min(remaining, lot.remaining);
      const pv = lot.row.pointValue;
      const gross = pv != null && Number.isFinite(pv) && pv > 0 && row.pointValue === pv
        ? (row.price - lot.row.price) * executionDirection(lot.row.side) * qty * pv : undefined;
      const commission = Number.isFinite(lot.row.commission) && Number.isFinite(row.commission)
        ? lot.row.commission! * qty / lot.row.qty + row.commission! * qty / row.qty : undefined;
      trades.push({ entry: lot.row, exit: row, qty, currency, gross, commission, net: gross != null && commission != null ? gross - commission : undefined });
      remaining -= qty; lot.remaining -= qty;
      if (lot.remaining <= 0) lots.shift();
    }
    if (remaining > 0) lots.push({ row, remaining });
  }
  const openLots = [...groups.values()].flat();
  return { trades, openLots, invalid, summaries: summarizeMatchedTrades(trades, rows) };
}

/** Trades must be chronological; fees may be proportionally allocated to selected records. */
export function summarizeMatchedTrades(trades: MatchedTrade[], costs: { currency?: string; commission?: number }[]) {
  const currencies = [...new Set([...trades.map(trade => trade.currency), ...costs.map(row => normalizeCurrency(row.currency))])].sort();
  const summaries = currencies.map(currency => {
    const closed = trades.filter(t => t.currency === currency);
    const known = closed.filter(t => t.net != null);
    let equity = 0, peak = 0, maxDrawdown = 0;
    for (const trade of known) { equity += trade.net!; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); }
    const gains = known.reduce((sum, t) => sum + Math.max(0, t.net!), 0);
    const losses = -known.reduce((sum, t) => sum + Math.min(0, t.net!), 0);
    const wins = known.filter(t => t.net! > 0).length;
    return { currency, closed: closed.length, known: known.length, missing: closed.length - known.length,
      net: known.length ? equity : undefined, gross: closed.some(t => t.gross != null) ? closed.reduce((s, t) => s + (t.gross || 0), 0) : undefined,
      wins, winRate: known.length ? wins / known.length : undefined, profitFactor: losses > 0 ? gains / losses : gains > 0 ? Infinity : undefined,
      maxDrawdown: known.length ? maxDrawdown : undefined,
      fees: costs.filter(row => normalizeCurrency(row.currency) === currency && Number.isFinite(row.commission)).reduce((s, row) => s + row.commission!, 0),
      missingFees: costs.filter(row => normalizeCurrency(row.currency) === currency && !Number.isFinite(row.commission)).length,
    };
  });
  return summaries;
}
