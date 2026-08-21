import type { Nt8Execution } from '@/lib/nt8Trading';

/** 一次进出场往返(FIFO 配对结果) */
export interface RoundTrip {
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  qty: number;
  /** true = 先买后卖(多头往返) */
  long: boolean;
}

/**
 * FIFO 配对:把成交流水配成 进场->出场 往返。
 * 支持分批进出场与反手(出场超过持仓的部分开新方向批次);
 * 未平仓的批次不产出往返。
 */
export function pairRoundTrips(execs: Nt8Execution[]): RoundTrip[] {
  const sorted = [...execs].sort((a, b) => a.time - b.time);
  const lots: { time: number; price: number; qty: number; side: string }[] = [];
  const trips: RoundTrip[] = [];
  for (const e of sorted) {
    let remaining = e.qty;
    while (remaining > 0 && lots.length > 0 && lots[0].side !== e.side) {
      const lot = lots[0];
      const closeQty = Math.min(lot.qty, remaining);
      trips.push({
        entryTime: lot.time,
        entryPrice: lot.price,
        exitTime: e.time,
        exitPrice: e.price,
        qty: closeQty,
        long: lot.side === 'Buy',
      });
      lot.qty -= closeQty;
      remaining -= closeQty;
      if (lot.qty === 0) lots.shift();
    }
    if (remaining > 0) lots.push({ time: e.time, price: e.price, qty: remaining, side: e.side });
  }
  return trips;
}
