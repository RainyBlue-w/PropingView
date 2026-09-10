import { getBridgeUrl } from './config';

/** NT8 交易接口客户端(对应 TvBridgeAddOn 的交易端点) */

export interface Nt8Account {
  name: string;
  connection?: string;
  /** 以下财务字段依赖桥端升级(F5);旧版桥不返回,前端显 — */
  currency?: string;
  /** 现金价值 */
  cashValue?: number;
  /** 净清算价值 */
  netLiquidation?: number;
  /** 当日已实现盈亏 */
  realizedPnl?: number;
  /** 未实现盈亏(按持仓最新价合计) */
  unrealizedPnl?: number;
}

export interface Nt8Position {
  instrument: string;
  /** 带符号:多为正,空为负 */
  quantity: number;
  averagePrice: number;
  marketPosition: 'Long' | 'Short' | string;
}

export interface Nt8Order {
  orderId: string;
  instrument: string;
  action: 'Buy' | 'Sell' | string;
  orderType: 'Market' | 'Limit' | 'StopMarket' | 'StopLimit' | string;
  quantity: number;
  filled: number;
  limitPrice: number;
  stopPrice: number;
  averageFillPrice: number;
  state: string;
  oco: string;
  name: string;
  time: number;
}

export interface Nt8Bracket {
  entryOrderId: string;
  instrument: string;
  tp: number;
  sl: number;
}

/** 成交记录(图上交易历史 mark 用) */
export interface Nt8Execution {
  time: number;
  /** NT8 原始成交时间精度，FIFO 排序优先于整秒图表时间。 */
  timeMs?: number;
  /** 同一模拟行情时间内的实际撮合顺序。 */
  sequence?: number;
  price: number;
  qty: number;
  side: 'Buy' | 'Sell' | string;
  orderId: string;
  executionId?: string;
  instrument?: string;
  commission?: number;
  account?: string;
  pointValue?: number;
  currency?: string;
}

export interface ExecutionPage {
  executions: Nt8Execution[];
  total?: number;
  nextOffset?: number | null;
  archive?: ExecutionArchiveStatus;
}

export interface ExecutionArchiveStatus {
  version: number;
  state: 'ready' | 'loading' | 'error';
  path?: string;
  recordCount: number;
  pendingCount: number;
  lastSavedAt?: number;
  error?: string;
  warning?: string;
}

export interface PlaceOrderPayload {
  account: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT' | 'STOPMARKET' | 'STOPLIMIT';
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  tif?: 'DAY' | 'GTC';
  /** 止盈价(可选,入场单成交后自动挂 OCO 括号单) */
  tp?: number;
  /** 止损价(可选) */
  sl?: number;
  /** 止盈金额$(可选,仅市价单):成交后按实际成交均价换算止盈价,避免滑点偏移 */
  tpAmount?: number;
  /** 止损金额$(可选,仅市价单) */
  slAmount?: number;
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 10000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${getBridgeUrl()}${path}`, { ...init, signal: ctrl.signal });
    const data = (await resp.json()) as T & { error?: string };
    if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export const nt8Trading = {
  getAccounts: () => request<{ accounts: Nt8Account[] }>('/api/accounts'),

  getPositions: (account: string) =>
    request<{ positions: Nt8Position[] }>(
      `/api/positions?account=${encodeURIComponent(account)}`,
    ),

  getOrders: (account: string) =>
    request<{ orders: Nt8Order[] }>(
      `/api/orders?account=${encodeURIComponent(account)}`,
    ),

  getBrackets: (account: string) =>
    request<{ brackets: Nt8Bracket[]; syncError?: string }>(
      `/api/brackets?account=${encodeURIComponent(account)}`,
    ),

  getExecutions: (account: string, symbol: string, from: number, to: number) =>
    request<{ executions: Nt8Execution[] }>(
      `/api/executions?account=${encodeURIComponent(account)}&symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`,
    ),

  getExecutionPage: (account: string, symbol: string, from: number, to: number, offset = 0, limit = 100) =>
    request<ExecutionPage>(
      `/api/executions?account=${encodeURIComponent(account)}&symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&offset=${offset}&limit=${limit}`,
    ),

  placeOrder: (payload: PlaceOrderPayload) =>
    post<{ ok: boolean; orderId: string }>('/api/order/place', payload),

  cancelOrder: (account: string, orderId: string) =>
    post<{ ok: boolean }>('/api/order/cancel', { account, orderId }),

  changeOrder: (
    account: string,
    orderId: string,
    price: { limitPrice?: number; stopPrice?: number },
  ) => post<{ ok: boolean }>('/api/order/change', { account, orderId, ...price }),

  closePosition: (account: string, symbol: string) =>
    post<{ ok: boolean }>('/api/position/close', { account, symbol }),
};
