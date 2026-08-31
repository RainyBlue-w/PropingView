import type { Bar, FeedAdapter, SymbolInfo } from '@/types/market';

/** 回放调试追踪:浏览器控制台执行 window.__rpLog 查看(同 __dfLog 约定) */
function rpTrace(method: string, detail?: unknown): void {
  try {
    if (typeof window === 'undefined') return;
    const w = window as unknown as { __rpLog?: { m: string; t: string; d: unknown }[] };
    if (!w.__rpLog) w.__rpLog = [];
    w.__rpLog.push({ m: method, t: new Date().toISOString(), d: detail ?? null });
    if (w.__rpLog.length > 300) w.__rpLog.shift();
  } catch {
    /* ignore */
  }
}

/** 每根新揭示 bar 的回调(symbol / intervalSec / bar) */
export type RevealListener = (symbol: string, intervalSec: number, bar: Bar) => void;

interface Subscription {
  symbol: string;
  intervalSec: number;
  onBar: (bar: Bar) => void;
}

interface ForwardCache {
  /** 排好序的待揭示 bar(已 emit 的会被移除) */
  bars: Bar[];
  /** 本缓存已覆盖到的右边界(下一次补货从这里继续) */
  loadedTo: number;
}

/**
 * 前向补货窗口:4 天。
 * 必须跨足周末/长休市(周五收盘→周日开盘约 62h);且 NT8 桥 BarsRequest
 * 按整天取整,实测窄窗(尤其同一天内)会被截断,宽窗(>1 个自然日)才完整。
 */
const FORWARD_PAGE_SEC = 4 * 86400;
/** 惰性探测数据尽头时回看的历史窗口 */
const DATA_END_LOOKBACK_SEC = 14 * 86400;

/**
 * 回放数据适配器(FeedAdapter):包装实盘/mock adapter,
 * getHistory 在游标处截断,step() 推进游标并把新揭示的 bar 当作"实时帧"
 * 推给订阅者——对 TvDatafeed 而言与实盘 SSE 帧同形,上层零改动。
 * 只读 inner 的 getHistory,不订阅其实时流(与实盘数据天然隔离)。
 *
 * 休市段(日内休市/隔夜/周末)由前向缓存自动跳过:游标直接落到下一段
 * 行情的第一根 bar,用户无感。
 */
export class ReplaySession implements FeedAdapter {
  /** 游标 = 最后一根已揭示 bar 的时间(unix 秒) */
  private cursor: number;
  /** step 重入守卫:播放提速/桥端延迟时上一次 step 可能未返回,跳过本次防并发重复 emit */
  private stepping = false;
  private subs = new Map<number, Subscription>();
  private subSeq = 0;
  private revealListeners = new Set<RevealListener>();
  /** 各 合约|周期 已 emit 的最大 bar 时间 */
  private lastEmitted = new Map<string, number>();
  /** 各 合约|周期 的数据尽头(最后一根 bar 时间),惰性探测 */
  private dataEnd = new Map<string, number>();
  /** 各 合约|周期 的前向待揭示缓存(宽窗拉取,窄窗会被桥截断) */
  private forwardCache = new Map<string, ForwardCache>();
  private inner: FeedAdapter;

  constructor(inner: FeedAdapter, startTime: number) {
    this.inner = inner;
    this.cursor = startTime;
  }

  getCursor(): number {
    return this.cursor;
  }

  getSymbols(): Promise<SymbolInfo[]> {
    return this.inner.getSymbols();
  }

  resolve(symbol: string): Promise<SymbolInfo | null> {
    return this.inner.resolve ? this.inner.resolve(symbol) : Promise.resolve(null);
  }

  async getHistory(symbol: string, intervalSec: number, from: number, to: number): Promise<Bar[]> {
    if (from > this.cursor) return [];
    return this.inner.getHistory(symbol, intervalSec, from, Math.min(to, this.cursor));
  }

  subscribe(symbol: string, intervalSec: number, onBar: (bar: Bar) => void): () => void {
    const id = ++this.subSeq;
    this.subs.set(id, { symbol, intervalSec, onBar });
    // 订阅时刻游标及之前的历史已由 getBars 加载,emit 只发游标之后的
    this.lastEmitted.set(`${symbol}|${intervalSec}`, this.cursor);
    return () => {
      this.subs.delete(id);
    };
  }

  /** 每根新揭示 bar 的订阅点(撮合引擎/UI 时钟用) */
  onBarRevealed(cb: RevealListener): () => void {
    this.revealListeners.add(cb);
    return () => {
      this.revealListeners.delete(cb);
    };
  }

  /**
   * 游标推进并向所有订阅 emit 新揭示的 bar;false = 已到数据尽头。
   * stepSec 省略时只揭示一根;给了则揭示 (cursor, cursor+stepSec] 行情时间
   * 窗口内的全部 bar(1min 图 + 5min 步长 = 每步 5 根);窗口内无 bar
   * (休市段)则直接落到之后的第一根(跳段)。
   */
  async step(stepSec?: number): Promise<boolean> {
    if (this.stepping) {
      rpTrace('step:busySkip', { cursor: this.cursor });
      return true; // 上一步未完成,跳过(不判尽头,避免误停播放)
    }
    this.stepping = true;
    try {
      const r = await this.stepInner(stepSec);
      rpTrace('step:done', { cursor: this.cursor, ok: r, stepSec: stepSec ?? 0 });
      return r;
    } finally {
      this.stepping = false;
    }
  }

  private async stepInner(stepSec?: number): Promise<boolean> {
    rpTrace('step:enter', { subs: this.subs.size, cursor: this.cursor, stepSec: stepSec ?? 0 });
    const limit = stepSec && stepSec > 0 ? this.cursor + stepSec : 0;
    // 逐订阅决定新游标:窗口内最后一根 bar;窗口为空(休市段)则为之后的第一根
    let newCursor = 0;
    for (const sub of this.subs.values()) {
      const fc = await this.ensureForward(sub.symbol, sub.intervalSec, this.cursor);
      let target: Bar | undefined;
      if (limit > 0) {
        // 窗口内最后一根
        for (const b of fc.bars) {
          if (b.time <= limit) target = b;
          else break;
        }
      }
      if (!target) target = fc.bars[0]; // 单根模式 / 窗口为空 → 下一根(跳休市段)
      rpTrace('step:nextBar', { symbol: sub.symbol, intervalSec: sub.intervalSec, found: target ? target.time : null });
      if (target && target.time > newCursor) newCursor = target.time;
    }
    if (!newCursor) return false;
    this.cursor = newCursor;
    // 各订阅从前向缓存取出 (lastEmitted, cursor] 区间内的 bar 发出(通常就一根)
    for (const sub of this.subs.values()) {
      const key = `${sub.symbol}|${sub.intervalSec}`;
      const last = this.lastEmitted.get(key) ?? 0;
      if (this.cursor <= last) continue;
      const revealed = this.drainForward(key, last, this.cursor);
      rpTrace('step:emit', { key, count: revealed.length, first: revealed[0]?.time ?? null });
      for (const bar of revealed) {
        sub.onBar(bar);
        for (const fn of this.revealListeners) fn(sub.symbol, sub.intervalSec, bar);
      }
      if (revealed.length) this.lastEmitted.set(key, revealed[revealed.length - 1].time);
    }
    return true;
  }

  /** 重设游标(宿主随后应 resetData 重新加载) */
  seekTo(timeSec: number): void {
    this.cursor = timeSec;
    this.lastEmitted.clear();
    this.forwardCache.clear();
  }

  /** 从缓存取出 (lastEmitted, cursor] 的 bar(消费掉) */
  private drainForward(key: string, lastEmitted: number, cursor: number): Bar[] {
    const fc = this.forwardCache.get(key);
    if (!fc) return [];
    const out: Bar[] = [];
    while (fc.bars.length && fc.bars[0].time > lastEmitted && fc.bars[0].time <= cursor) {
      out.push(fc.bars.shift() as Bar);
    }
    return out;
  }

  /**
   * 保证 key 的前向缓存有货:先发制人丢掉 ≤ after 的,空了/不够就
   * 从 loadedTo 继续按 4 天宽窗补货,直到拿到 bar 或到数据尽头。
   */
  private async ensureForward(symbol: string, intervalSec: number, after: number): Promise<ForwardCache> {
    const key = `${symbol}|${intervalSec}`;
    let fc = this.forwardCache.get(key);
    if (!fc) {
      fc = { bars: [], loadedTo: after };
      this.forwardCache.set(key, fc);
    }
    // 丢掉已消费/已过时(游标 seek 等)的
    if (fc.bars.length && fc.bars[0].time <= after) fc.bars = fc.bars.filter((b) => b.time > after);
    if (fc.bars.length) return fc;

    const end = await this.dataEndFor(symbol, intervalSec);
    let to = Math.max(fc.loadedTo, after);
    while (to < end) {
      const next = Math.min(to + FORWARD_PAGE_SEC, end);
      const page = (await this.inner.getHistory(symbol, intervalSec, Math.max(after, to) + 1, next))
        .filter((b) => b.time > after && b.time <= next)
        .sort((a, b) => a.time - b.time);
      fc.loadedTo = next;
      rpTrace('ensureForward:page', { key, to: next, count: page.length });
      if (page.length) {
        fc.bars = page;
        break;
      }
      to = next;
    }
    return fc;
  }

  /** 数据尽头(该合约最后一根 bar 时间);惰性探测并缓存 */
  private async dataEndFor(symbol: string, intervalSec: number): Promise<number> {
    const key = `${symbol}|${intervalSec}`;
    let end = this.dataEnd.get(key);
    if (end === undefined) {
      const now = Math.floor(Date.now() / 1000);
      const tail = await this.inner.getHistory(symbol, intervalSec, now - DATA_END_LOOKBACK_SEC, now);
      end = tail.length ? tail[tail.length - 1].time : now;
      this.dataEnd.set(key, end);
    }
    return end;
  }
}
