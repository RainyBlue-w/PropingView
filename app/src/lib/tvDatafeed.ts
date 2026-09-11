import type { Bar, FeedAdapter, SymbolInfo } from '@/types/market';
import { filterSymbols } from './symbolSearch';

/** TradingView 周期字符串 -> 秒 */
export function resolutionToSeconds(resolution: string): number {
  if (resolution.endsWith('S')) return Math.max(1, parseInt(resolution, 10));
  if (resolution.endsWith('D')) return Math.max(1, parseInt(resolution, 10)) * 86400;
  if (resolution.endsWith('W')) return Math.max(1, parseInt(resolution, 10)) * 604800;
  return Math.max(1, parseInt(resolution, 10)) * 60;
}

const SUPPORTED_RESOLUTIONS = [
  '15S', '1', '2', '3', '5', '10', '15', '30', '60', '120', '240', '1D', '1W',
];

const EXCHANGE = 'NT8';

/** 懒加载:单次 getBars 最多返回的 K 线根数;向左滚动时库会自动分页继续请求 */
const MAX_BARS_PER_REQUEST = 500;
const ADAPTER_CHANGED_MESSAGE = '数据源已切换，请重新请求行情。';

function pricescaleOf(tickSize: number | undefined): { minmov: number; pricescale: number } {
  if (!tickSize || tickSize <= 0) return { minmov: 1, pricescale: 100 };
  // 找到能让 tickSize 表示为整数的最小十进制位数:
  // 0.25 -> pricescale=100, minmov=25(两位小数、按 0.25 步进)
  // 0.01 -> 100/1; 0.1 -> 10/1; 1 -> 1/1; 0.0001 -> 10000/1
  let decimals = 0;
  while (
    decimals < 8 &&
    Math.abs(tickSize * 10 ** decimals - Math.round(tickSize * 10 ** decimals)) > 1e-9
  ) {
    decimals++;
  }
  const pricescale = 10 ** decimals;
  const minmov = Math.max(1, Math.round(tickSize * pricescale));
  return { minmov, pricescale };
}

function toTvBar(bar: Bar) {
  return {
    time: bar.time * 1000,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 调试追踪:记录 datafeed 各方法调用,浏览器控制台执行 window.__dfLog 可查看 */
function trace(method: string, detail?: unknown): void {
  try {
    const w = window as any;
    if (!w.__dfLog) w.__dfLog = [];
    w.__dfLog.push({
      m: method,
      t: new Date().toISOString(),
      d: detail === undefined ? null : JSON.parse(JSON.stringify(detail, (_k, v) => (typeof v === 'function' ? '[fn]' : v))),
    });
    if (w.__dfLog.length > 500) w.__dfLog.shift();
  } catch {
    /* ignore */
  }
}

/**
 * TradingView Charting Library 自定义 datafeed(JS API)。
 * 内部委托给 FeedAdapter:NT8 数据桥或本地模拟,可运行时热切换。
 */
export class TvDatafeed {
  private adapter: FeedAdapter;
  /** 切换后旧请求及迟到流帧不能再写入新会话的行情缓存。 */
  private adapterGeneration = 0;
  private subscriptions = new Map<string, () => void>();
  /** 各合约最新价(subscribeBars 的 tick 与 getBars 的末根 bar 收盘价) */
  private lastPrices = new Map<string, number>();
  /** 最新价变化监听(tick 驱动,供订单线浮盈等即时刷新) */
  private priceListeners = new Set<(symbol: string, price: number) => void>();
  /** 各 合约|周期 已送出的最新 bar 时间(秒),用于丢弃乱序流帧 */
  private lastBarTimes = new Map<string, number>();
  /** 各 合约|周期 getBars 返回的末根 bar,用于回填桥端同桶快照帧的 OHLC */
  private lastBars = new Map<string, Bar>();
  /** 适配器切换后回调,宿主应调用 chart.resetData() */
  onAdapterSwapped: (() => void) | null = null;

  constructor(adapter: FeedAdapter) {
    this.adapter = adapter;
    try {
      (window as any).__tvDatafeed = this;
    } catch {
      /* ignore */
    }
  }

  /** 合约最新价;还没有任何数据时返回 null */
  getLastPrice(symbol: string): number | null {
    const v = this.lastPrices.get(symbol);
    return v != null && v > 0 ? v : null;
  }

  /** 订阅最新价变化(subscribeBars 的 tick 驱动);返回退订函数 */
  onPriceChange(fn: (symbol: string, price: number) => void): () => void {
    this.priceListeners.add(fn);
    return () => {
      this.priceListeners.delete(fn);
    };
  }

  setAdapter(adapter: FeedAdapter): void {
    // 必须先失效：部分适配器的退订函数仍可能同步派发最后一帧。
    this.adapterGeneration += 1;
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
    this.adapter = adapter;
    // 旧适配器的最新价/末根 bar 标记作废——回放游标会把时间轴回拨到历史,
    // 不清掉的话:① getLastPrice 仍是实盘价,模拟市价单会按错价成交;
    // ② lastBarTimes 守卫会挡住回放历史页(时间早于实盘末根)更新最新价
    this.lastPrices.clear();
    this.lastBarTimes.clear();
    this.lastBars.clear();
    this.onAdapterSwapped?.();
  }

  async listSymbols(searchOnly = false): Promise<SymbolInfo[]> {
    // UI 调用没有取消回调；切换期间重新读取当前源，不能返回旧合约元数据。
    for (;;) {
      const generation = this.adapterGeneration;
      const adapter = this.adapter;
      try {
        const symbols = await (searchOnly && adapter.getSearchSymbols ? adapter.getSearchSymbols() : adapter.getSymbols());
        if (generation === this.adapterGeneration) return symbols;
      } catch (err) {
        if (generation === this.adapterGeneration) throw err;
      }
    }
  }

  /** 搜索栏的完整名称解析；切换来源后丢弃旧桥返回的结果。 */
  async lookupSymbol(symbol: string): Promise<SymbolInfo | null> {
    const generation = this.adapterGeneration;
    const adapter = this.adapter;
    const resolve = adapter.searchResolve ?? adapter.resolve;
    if (!resolve) return null;
    try {
      const result = await resolve.call(adapter, symbol.trim());
      return generation === this.adapterGeneration ? result : null;
    } catch {
      return null;
    }
  }

  private assertAdapterGeneration(generation: number): void {
    if (generation !== this.adapterGeneration) throw new Error(ADAPTER_CHANGED_MESSAGE);
  }

  onReady(callback: (config: any) => void): void {
    trace('onReady');
    setTimeout(
      () =>
        callback({
          supported_resolutions: SUPPORTED_RESOLUTIONS,
          supports_search: true,
          supports_group_request: false,
          supports_marks: false,
          supports_timescale_marks: false,
          supports_time: false,
          exchanges: [{ value: this.adapter.exchange || EXCHANGE, name: this.adapter.exchange || EXCHANGE, desc: `${this.adapter.exchange || EXCHANGE} 数据桥` }],
          symbols_types: [
            { name: '期货', value: 'futures' },
            { name: '其他', value: 'other' },
          ],
        }),
      0,
    );
  }

  async searchSymbols(
    userInput: string,
    _exchange: string,
    _symbolType: string,
    onResult: (items: any[]) => void,
  ): Promise<void> {
    const generation = this.adapterGeneration;
    const adapter = this.adapter;
    const query = userInput.trim().toLowerCase();
    let symbols: SymbolInfo[];
    try {
      symbols = await (adapter.getSearchSymbols ? adapter.getSearchSymbols() : adapter.getSymbols());
      this.assertAdapterGeneration(generation);
    } catch {
      onResult([]);
      return;
    }
    const matched = filterSymbols(symbols, userInput).slice(0, 30);

    // 搜索补查遵守候选目录限制；普通图表 resolveSymbol 仍能精确打开历史合约。
    const resolve = adapter.searchResolve ?? adapter.resolve;
    if (matched.length === 0 && query && resolve) {
      try {
        const resolved = await resolve.call(adapter, userInput.trim());
        if (resolved) matched.push(resolved);
      } catch {
        /* 未解析到则返回空 */
      }
    }

    if (generation !== this.adapterGeneration) {
      onResult([]);
      return;
    }

    onResult(
      matched.map((s) => ({
        symbol: s.symbol,
        full_name: s.symbol,
        description: s.name,
        exchange: s.exchange || this.adapter.exchange || EXCHANGE,
        ticker: s.symbol,
        type: s.type ?? 'futures',
      })),
    );
  }

  async resolveSymbol(
    symbolName: string,
    onResolve: (info: any) => void,
    onError: (reason: string) => void,
  ): Promise<void> {
    const generation = this.adapterGeneration;
    const adapter = this.adapter;
    trace('resolveSymbol:start', symbolName);
    try {
      const symbols = await adapter.getSymbols();
      this.assertAdapterGeneration(generation);
      let found = symbols.find((s) => s.symbol === symbolName);
      // 不在列表时,向后端按名解析(支持 Watchlist 之外的合约)
      if (!found && adapter.resolve) {
        found = (await adapter.resolve(symbolName)) ?? undefined;
        this.assertAdapterGeneration(generation);
      }
      if (!found) {
        trace('resolveSymbol:notFound', symbolName);
        onError(`未知合约:${symbolName}`);
        return;
      }
      trace('resolveSymbol:ok', found);
      const { minmov, pricescale } = pricescaleOf(found.tickSize);
      onResolve({
        name: found.symbol,
        ticker: found.symbol,
        description: found.name,
        type: found.type ?? 'futures',
        session: '24x7',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC',
        exchange: found.exchange || this.adapter.exchange || EXCHANGE,
        listed_exchange: found.exchange || this.adapter.exchange || EXCHANGE,
        minmov,
        pricescale,
        has_intraday: true,
        has_seconds: true,
        seconds_multipliers: ['15'],
        has_daily: true,
        has_weekly_and_monthly: true,
        supported_resolutions: SUPPORTED_RESOLUTIONS,
        volume_precision: 0,
        data_status: 'streaming',
        format: 'price',
        currency_code: 'USD',
      });
    } catch (err) {
      trace('resolveSymbol:error', String(err));
      onError(generation !== this.adapterGeneration ? ADAPTER_CHANGED_MESSAGE : err instanceof Error ? err.message : '合约解析失败');
    }
  }

  async getBars(
    symbolInfo: any,
    resolution: string,
    periodParams: any,
    onResult: (bars: any[], meta?: any) => void,
    onError: (reason: string) => void,
  ): Promise<void> {
    const generation = this.adapterGeneration;
    const adapter = this.adapter;
    const { from, to } = periodParams;
    trace('getBars:start', { symbol: symbolInfo?.ticker, resolution, from, to });
    try {
      const intervalSec = resolutionToSeconds(resolution);
      // 回放会话(ReplaySession)暴露 getCursor:数据右边界在游标处。
      // 请求窗口必须先钳到游标再取数——否则"游标右侧全空"会触发空页跳窗逻辑,
      // 初始加载在历史分页上空转(慢且可能跳过游标页)
      const cursor = (adapter as { getCursor?: () => number }).getCursor?.() ?? null;
      const effectiveTo = cursor != null ? Math.min(to, cursor) : to;
      // 懒加载:单次最多拉 MAX_BARS_PER_REQUEST 根,向左滚动时库会自动分页再调
      const clampedFrom = Math.max(from, effectiveTo - MAX_BARS_PER_REQUEST * intervalSec);
      const raw = await adapter.getHistory(symbolInfo.ticker, intervalSec, clampedFrom, effectiveTo);
      this.assertAdapterGeneration(generation);
      // NT8 桥按整天/会话取整返回,可能含请求区间之外的 bar;
      // 库校验 "returned data should be in the requested range" 失败会升级
      // 为全量更新并反复重试(超大下载量的根因)——这里严格过滤到 [from,to]
      const bars = [...new Map(raw.filter((b) => b.time >= clampedFrom && b.time < to && b.time <= effectiveTo)
        .map(b => [b.time, b])).values()].sort((a, b) => a.time - b.time).slice(-MAX_BARS_PER_REQUEST);
      trace('getBars:done', { count: bars.length, rawCount: raw.length });
      if (!bars.length) {
        if (cursor != null) {
          // 回放:空窗口 = 游标右侧区域。原先给周末空窗设计的 10 天向后探针
          // 够不到远期游标(会误判 EOD 导致整图空白),改为直接取游标前一页
          const pageFrom = Math.max(0, cursor - MAX_BARS_PER_REQUEST * intervalSec);
          const page = await adapter.getHistory(symbolInfo.ticker, intervalSec, pageFrom, cursor);
          this.assertAdapterGeneration(generation);
          const pageBars = page.filter((b) => b.time >= pageFrom && b.time <= cursor);
          trace('getBars:emptyPageReplay', { pageBars: pageBars.length });
          if (pageBars.length) onResult([], { nextTime: pageBars[pageBars.length - 1].time });
          else onResult([], { noData: true });
          return;
        }
        // 空窗口(多为周末/节假日无交易):绝不能直接 noData:true——库会判定
        // 数据尽头(EOD)并永久停止向左分页。找窗口之前最近的一根 bar,用
        // nextTime 告诉库"下一页从这里继续",跳过空窗;确实更老也没有时才 EOD
        const olderTo = clampedFrom - 1;
        const olderFrom = Math.max(0, olderTo - 10 * 86400);
        const older = await adapter.getHistory(symbolInfo.ticker, intervalSec, olderFrom, olderTo);
        this.assertAdapterGeneration(generation);
        const olderBars = older.filter((b) => b.time >= olderFrom && b.time <= olderTo);
        trace('getBars:emptyPage', { older: olderBars.length });
        if (olderBars.length) onResult([], { nextTime: olderBars[olderBars.length - 1].time });
        else onResult([], { noData: true });
        return;
      }
      // 分页回填的是更老的数据:不许把最新价/最新 bar 标记往回拨
      const key = `${symbolInfo.ticker}|${intervalSec}`;
      const lastBar = bars[bars.length - 1];
      if (lastBar.time >= (this.lastBarTimes.get(key) ?? 0)) {
        this.lastPrices.set(symbolInfo.ticker, lastBar.close);
        this.lastBarTimes.set(key, lastBar.time);
        this.lastBars.set(key, lastBar);
      }
      onResult(bars.map(toTvBar), { noData: false });
    } catch (err) {
      trace('getBars:error', String(err));
      // 旧 widget 仍收到终止回调，避免其请求永远处于 loading；不交付旧源 bars。
      onError(generation !== this.adapterGeneration ? ADAPTER_CHANGED_MESSAGE : err instanceof Error ? err.message : '历史数据加载失败');
    }
  }

  subscribeBars(
    symbolInfo: any,
    resolution: string,
    onTick: (bar: any) => void,
    listenerGuid: string,
  ): void {
    trace('subscribeBars', { symbol: symbolInfo?.ticker, resolution, listenerGuid });
    this.unsubscribeBars(listenerGuid);
    const generation = this.adapterGeneration;
    let closed = false;
    const intervalSec = resolutionToSeconds(resolution);
    const key = `${symbolInfo.ticker}|${intervalSec}`;
    // 单调性守卫:桥端快照/乱序 tick 可能带来时间倒退的 bar,库会报
    // "time order violation" 并丢弃;这里直接拦下(种子=历史末根 bar 时间)
    let lastSec = this.lastBarTimes.get(key) ?? 0;
    const seed = this.lastBars.get(key);
    const unsubscribe = this.adapter.subscribe(symbolInfo.ticker, intervalSec, (bar) => {
      if (closed || generation !== this.adapterGeneration) return;
      if (bar.time < lastSec) return;
      // 桥端每次新订阅会用最近成交价造一帧同桶快照(open/high/low 全是切换时刻
      // 的最新价),直接把历史末根 bar 覆盖掉。同桶帧用历史末根回填开盘价,
      // 高低价取两者极值,保证当前未成型的 bar OHLC 正确
      if (seed && bar.time === seed.time) {
        bar = {
          time: bar.time,
          open: seed.open,
          high: Math.max(seed.high, bar.high),
          low: Math.min(seed.low, bar.low),
          close: bar.close,
          volume: Math.max(seed.volume, bar.volume),
        };
      }
      lastSec = bar.time;
      this.lastBarTimes.set(key, bar.time);
      this.lastBars.set(key, bar);
      this.lastPrices.set(symbolInfo.ticker, bar.close);
      for (const fn of this.priceListeners) fn(symbolInfo.ticker, bar.close);
      onTick(toTvBar(bar));
    });
    this.subscriptions.set(listenerGuid, () => {
      closed = true;
      unsubscribe();
    });
  }

  unsubscribeBars(listenerGuid: string): void {
    trace('unsubscribeBars', listenerGuid);
    const unsub = this.subscriptions.get(listenerGuid);
    if (unsub) {
      unsub();
      this.subscriptions.delete(listenerGuid);
    }
  }
}
