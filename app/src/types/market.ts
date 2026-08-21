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
  getSymbols(): Promise<SymbolInfo[]>;
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
  /** 可选:按名称解析不在列表里的合约(用户在图表搜索框直接输入时触发) */
  resolve?(symbol: string): Promise<SymbolInfo | null>;
}
