import type { Bar, FeedAdapter, SymbolInfo } from '@/types/market';
import { getBridgeUrl } from './config';
import type { ExecutionArchiveStatus } from './nt8Trading';

export interface Nt8Status {
  connected: boolean;
  connectionName?: string;
  version?: string;
  time?: number;
  historyWindowVersion?: number;
  executionArchiveVersion?: number;
  archive?: ExecutionArchiveStatus;
}

async function fetchJson<T>(url: string, timeoutMs = 5000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return (await resp.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** 探测 NT8 数据桥是否在线,返回 null 表示不可达 */
export async function checkNt8Status(): Promise<Nt8Status | null> {
  try {
    return await fetchJson<Nt8Status>(`${getBridgeUrl()}/api/status`, 2000);
  } catch {
    return null;
  }
}

/**
 * NT8 数据桥适配器。
 * 约定接口(由 NinjaScript AddOn TvBridgeAddOn 实现):
 *   GET /api/status   -> { connected, connectionName, version, time }
 *   GET /api/symbols  -> { symbols: [{ symbol, name, tickSize, type }] }
 *   GET /api/history?symbol=&interval=&from=&to= -> { bars: Bar[] }  interval 秒,time Unix 秒
 *   GET /api/stream?symbol=&interval=            -> SSE,每条 data: 为一个 Bar JSON
 */
export function createNt8Adapter(status?: Nt8Status): FeedAdapter {
  // 旧桥把日内 from/to 直接传给按交易日取数的 BarsRequest,会丢掉整段行情。
  // 兼容旧桥时扩大到完整日期,缓存宽窗后再切片;新桥在服务端修正,只传输所需区间。
  const cache = new Map<string, { expires: number; data: Promise<Bar[]> }>();
  const adapter: FeedAdapter = {
    async getSymbols(): Promise<SymbolInfo[]> {
      const data = await fetchJson<{ symbols: SymbolInfo[] }>(
        `${getBridgeUrl()}/api/symbols`,
      );
      return data.symbols;
    },

    async resolve(symbol: string): Promise<SymbolInfo | null> {
      try {
        return await fetchJson<SymbolInfo>(
          `${getBridgeUrl()}/api/resolve?symbol=${encodeURIComponent(symbol)}`,
        );
      } catch {
        return null;
      }
    },

    async getHistory(symbol, intervalSec, from, to): Promise<Bar[]> {
      if (from > to) return [];
      const padded = !status?.historyWindowVersion;
      const start = new Date(from * 1000);
      const end = new Date(to * 1000);
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - 1);
      end.setHours(0, 0, 0, 0);
      end.setDate(end.getDate() + 1);
      const q = new URLSearchParams({
        symbol,
        interval: String(intervalSec),
        from: String(padded ? start.getTime() / 1000 : from),
        to: String(padded ? end.getTime() / 1000 : to),
      });
      const key = `${getBridgeUrl()}?${q}`;
      let entry = cache.get(key);
      if (!entry || entry.expires < Date.now()) {
        const data = fetchJson<{ bars: Bar[] }>(`${getBridgeUrl()}/api/history?${q}`, 30000)
          .then(d => [...new Map(d.bars.map(b => [b.time, b])).values()].sort((a, b) => a.time - b.time));
        entry = { expires: Date.now() + (to < Date.now() / 1000 - 86400 ? 300000 : 5000), data };
        cache.set(key, entry);
        if (cache.size > 8) cache.delete(cache.keys().next().value!);
        void data.catch(() => { if (cache.get(key)?.data === data) cache.delete(key); });
      }
      return (await entry.data).filter(b => b.time >= from && b.time <= to);
    },

    subscribe(symbol, intervalSec, onBar) {
      const q = new URLSearchParams({
        symbol,
        interval: String(intervalSec),
      });
      const es = new EventSource(`${getBridgeUrl()}/api/stream?${q}`);
      let closed = false;
      let lastTime = 0;
      let recovering = false;
      let queued: Bar[] = [];
      const emit = (b: Bar) => {
        if (closed || b.time < lastTime) return;
        lastTime = b.time;
        onBar(b);
      };
      es.onopen = () => {
        if (!lastTime || recovering) return;
        recovering = true;
        // EventSource 重连只带当前 bar;补上断线期间的真实历史,否则图上会永久留洞。
        void adapter.getHistory(symbol, intervalSec, lastTime, Math.floor(Date.now() / 1000))
          .then(bars => bars.forEach(emit))
          .catch(err => console.warn('NT8 重连历史补取失败', err))
          .finally(() => {
            recovering = false;
            queued.sort((a, b) => a.time - b.time).forEach(emit);
            queued = [];
          });
      };
      es.onmessage = (ev) => {
        try {
          const bar = JSON.parse(ev.data) as Bar;
          if (!Number.isFinite(bar.time) || !Number.isFinite(bar.close)) return;
          if (recovering) queued.push(bar);
          else emit(bar);
        } catch {
          /* 忽略坏帧 */
        }
      };
      return () => { closed = true; queued = []; es.close(); };
    },
  };
  return adapter;
}
