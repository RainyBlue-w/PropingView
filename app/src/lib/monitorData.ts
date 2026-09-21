import type { Nt8Account, Nt8Bracket, Nt8Order, Nt8Position } from './nt8Trading';
import { matchesChartInstrument } from './chartInstrument';

/** 监控面板:单个账户的轮询快照 */
export interface MonitorSnapshot {
  account: Nt8Account;
  positions: Nt8Position[];
  orders: Nt8Order[];
  brackets: Nt8Bracket[];
  /** 桥端保护同步异常(非空时卡片提示) */
  syncError?: string;
}

export interface ProtectionLeg {
  price: number;
  qty: number;
}

/** 某合约当前的工作止盈 / 止损单(已挂出的真实保护单;未成交入场的 bracket 预览不在此列) */
export interface Protection {
  tp: ProtectionLeg[];
  sl: ProtectionLeg[];
}

/** 有数量非零的持仓 */
export function hasOpenPosition(positions: Nt8Position[]): boolean {
  return positions.some(p => Number.isFinite(p.quantity) && p.quantity !== 0);
}

export function openPositions(positions: Nt8Position[]): Nt8Position[] {
  return positions.filter(p => Number.isFinite(p.quantity) && p.quantity !== 0);
}

/** 合约切换器默认选项:绝对数量最大的持仓 */
export function defaultInstrument(positions: Nt8Position[]): string | null {
  const open = openPositions(positions);
  if (!open.length) return null;
  return open.reduce((a, b) => (Math.abs(b.quantity) > Math.abs(a.quantity) ? b : a)).instrument;
}

/**
 * 持仓浮动盈亏:(现价 - 均价) × 带符号手数 × 每点价值(多涨正、空跌正)。
 * 与主图持仓线公式一致;缺价格或点值返回 null,不伪造数值。
 */
export function positionPnl(
  pos: Nt8Position,
  lastPrice?: number | null,
  pointValue?: number | null,
): number | null {
  if (lastPrice == null || !Number.isFinite(lastPrice)) return null;
  if (pointValue == null || !Number.isFinite(pointValue) || !(pointValue > 0)) return null;
  if (!Number.isFinite(pos.averagePrice) || !Number.isFinite(pos.quantity)) return null;
  return (lastPrice - pos.averagePrice) * pos.quantity * pointValue;
}

/** 持仓线标签:`+2 | +375$`(带符号手数 | 浮动盈亏,缺数据只显示手数);与主图持仓线格式一致 */
export function positionLineTitle(pos: Nt8Position, lastPrice?: number | null, pointValue?: number | null): string {
  const qPart = `${pos.quantity > 0 ? '+' : ''}${pos.quantity}`;
  const pnl = positionPnl(pos, lastPrice, pointValue);
  if (pnl == null) return qPart;
  const rounded = Math.round(pnl * 100) / 100;
  return `${qPart} | ${rounded >= 0 ? '+' : ''}${rounded}$`;
}

/** 从账户工作单中取某合约的 TP/SL 腿:名称含 TP/SL,价格取 limitPrice || stopPrice,数量为未成交剩余 */
export function findProtection(orders: Nt8Order[], instrument: string): Protection {
  const tp: ProtectionLeg[] = [];
  const sl: ProtectionLeg[] = [];
  for (const order of orders) {
    if (!matchesChartInstrument(order, instrument)) continue;
    const remaining = order.quantity - order.filled;
    const price = order.limitPrice || order.stopPrice;
    if (!(remaining > 0) || !(price > 0)) continue;
    if (order.name.includes('TP')) tp.push({ price, qty: remaining });
    else if (order.name.includes('SL')) sl.push({ price, qty: remaining });
  }
  return { tp, sl };
}

export interface MonitorTotal {
  value: number | null;
  /** true 表示全部持仓都按实时价求和;false 表示回退桥端账户合计 */
  live: boolean;
}

/**
 * 账户浮动盈亏合计:所有持仓都有可用实时价与点值时按实时价求和;
 * 任一持仓缺数据时回退桥端 account.unrealizedPnl(仍可能缺失,显示 —)。
 * prices / pointValues 以 instrument 大写为键。
 */
export function totalUnrealized(
  positions: Nt8Position[],
  prices: ReadonlyMap<string, number>,
  pointValues: ReadonlyMap<string, number>,
  bridgeTotal?: number,
): MonitorTotal {
  const fallback: MonitorTotal = {
    value: typeof bridgeTotal === 'number' && Number.isFinite(bridgeTotal) ? bridgeTotal : null,
    live: false,
  };
  let sum = 0;
  for (const pos of openPositions(positions)) {
    const key = pos.instrument.toUpperCase();
    const pnl = positionPnl(pos, prices.get(key), pointValues.get(key));
    if (pnl == null) return fallback;
    sum += pnl;
  }
  return { value: sum, live: true };
}
