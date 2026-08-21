/** 草稿模式:止盈止损金额 <-> 价格 换算,以及合约每点美元价值兜底表 */

/** 常见 CME 合约每 1.00 点的美元价值(pointValue),桥未返回时兜底 */
export const POINT_VALUE_TABLE: Record<string, number> = {
  ES: 50, MES: 5,
  NQ: 20, MNQ: 2,
  YM: 5, MYM: 0.5,
  RTY: 50, M2K: 5,
  CL: 1000, MCL: 100,
  GC: 100, MGC: 10,
  SI: 5000, SIL: 1000,
  HG: 25000,
  '6E': 125000, '6B': 62500, '6J': 12500000, '6A': 100000,
  ZN: 1000, ZB: 1000,
};

/** 从合约名解析品种根('ES 09-26' -> 'ES') */
export function symbolRoot(symbol: string): string {
  return symbol.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
}

/** 每 1.00 点的美元价值:优先数据源返回的 pointValue,否则查表,最后兜底 1 */
export function resolvePointValue(symbol: string, pointValue?: number): number {
  if (pointValue && pointValue > 0) return pointValue;
  return POINT_VALUE_TABLE[symbolRoot(symbol)] ?? 1;
}

export type DraftSide = 'BUY' | 'SELL';

/** LMT/STP 自动判定:买单价低于市价=限价单、高于市价=止损单;卖单相反。无市价时兜底限价 */
export function detectOrderType(
  side: DraftSide,
  price: number,
  market: number | null,
): 'LIMIT' | 'STOPMARKET' {
  if (market == null || !(market > 0)) return 'LIMIT';
  if (side === 'BUY') return price <= market ? 'LIMIT' : 'STOPMARKET';
  return price >= market ? 'LIMIT' : 'STOPMARKET';
}

/** 方向系数:买入 TP 在基准价上方(+1)、SL 在下方(-1);卖出相反 */
function dirOf(side: DraftSide, isTp: boolean): number {
  return (side === 'BUY' ? 1 : -1) * (isTp ? 1 : -1);
}

/** 吸附到 tick(0.25 -> 2 位小数,0.00005 -> 5 位) */
export function roundToTick(price: number, tick: number): number {
  if (!tick || tick <= 0) return Math.round(price * 10000) / 10000;
  const decimals = Math.max(0, Math.ceil(-Math.log10(tick)));
  return Number((Math.round(price / tick) * tick).toFixed(decimals + 1));
}

/** 按 tick 推小数位数(0.25 -> 2 位,0.1 -> 1 位,0.0001 -> 4 位) */
export function tickDecimals(tick: number): number {
  if (!tick || tick <= 0) return 2;
  let d = 0;
  while (d < 8 && Math.abs(tick * 10 ** d - Math.round(tick * 10 ** d)) > 1e-9) d++;
  return d;
}

/**
 * 金额(美元) -> 目标价:ticks = amount / (tickSize × pointValue × qty)。
 * 返回 null 表示输入不足,无法计算。
 */
export function amountToPrice(
  side: DraftSide,
  isTp: boolean,
  amount: number,
  refPrice: number,
  tickSize: number,
  pointValue: number,
  qty: number,
): number | null {
  if (!(amount > 0) || !(refPrice > 0) || !(qty > 0) || !(pointValue > 0)) return null;
  const tick = tickSize > 0 ? tickSize : 0.01;
  const ticks = amount / (tick * pointValue * qty);
  return roundToTick(refPrice + dirOf(side, isTp) * ticks * tick, tick);
}

/**
 * 目标价 -> 金额(美元),拖拽草稿线时反算。
 * 拖到错误方向(如买单 TP 拖到基准价下方)钳为 0,由调用方清掉该线。
 */
export function priceToAmount(
  side: DraftSide,
  isTp: boolean,
  price: number,
  refPrice: number,
  pointValue: number,
  qty: number,
): number {
  if (!(price > 0) || !(refPrice > 0) || !(qty > 0) || !(pointValue > 0)) return 0;
  const raw = (price - refPrice) * dirOf(side, isTp) * pointValue * qty;
  return Math.max(0, Math.round(raw * 100) / 100);
}
