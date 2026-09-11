/** K 线数据,time 为 Unix 秒 */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SymbolInfo {
  symbol: string;
  name: string;
  exchange?: string;
  /** 最小跳动,如 ES=0.25;缺省按 0.01 */
  tickSize?: number;
  /** 每 1.00 点的美元价值,如 ES=50;桥未返回时前端按品种兜底 */
  pointValue?: number;
  /** 品种类型,如 futures / forex / index */
  type?: string;
}

/**
 * 数据适配器:对上统一供 TradingView datafeed 调用,
 * 对下分别由 NT8 数据桥(REST+SSE)或本地模拟数据实现。
 */
export interface FeedAdapter {
  exchange?: string;
  getSymbols(): Promise<SymbolInfo[]>;
  /** 搜索候选目录；可限制为主力合约，普通图表及历史解析仍使用 getSymbols。 */
  getSearchSymbols?(): Promise<SymbolInfo[]>;
  /** from/to 为 Unix 秒 */
  getHistory(
    symbol: string,
    intervalSec: number,
    from: number,
    to: number,
  ): Promise<Bar[]>;
  /** 订阅实时K线(成型中的当前 bar 随 tick 更新),返回取消函数 */
  subscribe(
    symbol: string,
    intervalSec: number,
    onBar: (bar: Bar) => void,
  ): () => void;
  /** 按原生名称精确解析，包括已保存图表和历史交易的旧合约。 */
  resolve?(symbol: string): Promise<SymbolInfo | null>;
  /** 搜索栏的名称解析，使用与搜索候选目录相同的限制。 */
  searchResolve?(symbol: string): Promise<SymbolInfo | null>;
}
