import type { Bar, FeedAdapter, SymbolInfo } from '@/types/market';
import { bridgeProviderName, getBridgeUrl, getProvider, type BridgeProvider } from './config';
import type { ExecutionArchiveStatus } from './nt8Trading';

export interface Nt8Status {
  provider?: BridgeProvider;
  tradingSupported?: boolean;
  tradingError?: string;
  syncError?: string;
  marketError?: string;
  error?: string;
  connected: boolean;
  connectionName?: string;
  version?: string;
  time?: number;
  historyWindowVersion?: number;
  symbolCatalogVersion?: number;
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
export async function checkNt8Status(bridgeProvider: BridgeProvider = getProvider()): Promise<Nt8Status | null> {
  try {
    const status = await fetchJson<Nt8Status>(`${getBridgeUrl(bridgeProvider)}/api/status`, 2000);
    if (status.provider && status.provider !== bridgeProvider) return null;
    // An ATAS endpoint must identify itself; an old NT8 bridge remains compatible.
    if (bridgeProvider === 'atas' && status.provider !== 'atas') return null;
    return status;
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
export function createNt8Adapter(status?: Nt8Status, bridgeProvider: BridgeProvider = status?.provider ?? getProvider()): FeedAdapter {
  const bridgeUrl = getBridgeUrl(bridgeProvider);
  // 旧桥把日内 from/to 直接传给按交易日取数的 BarsRequest,会丢掉整段行情。
  // 兼容旧桥时扩大到完整日期,缓存宽窗后再切片;新桥在服务端修正,只传输所需区间。
  const cache = new Map<string, { expires: number; data: Promise<Bar[]> }>();
  const exchange = bridgeProvider === 'atas' ? 'ATAS' : 'NT8';
  const adapter: FeedAdapter = {
    exchange,
    async getSymbols(): Promise<SymbolInfo[]> {
      const data = await fetchJson<{ symbols: SymbolInfo[] }>(
        `${bridgeUrl}/api/symbols`,
      );
      return data.symbols.map(symbol => ({ ...symbol, exchange: symbol.exchange || exchange }));
    },

    async getSearchSymbols(): Promise<SymbolInfo[]> {
      if (bridgeProvider !== 'nt8') return adapter.getSymbols();
      const data = await fetchJson<{ symbols: SymbolInfo[]; currentOnly?: boolean }>(
        `${bridgeUrl}/api/symbols?currentOnly=true`,
      );
      if (data.currentOnly !== true) throw new Error('请在 NT8 编译并重启新版数据桥，以启用主力合约搜索。');
      return data.symbols.map(symbol => ({ ...symbol, exchange: symbol.exchange || exchange }));
    },

    async resolve(symbol: string): Promise<SymbolInfo | null> {
      try {
        const info = await fetchJson<SymbolInfo>(
          `${bridgeUrl}/api/resolve?symbol=${encodeURIComponent(symbol)}`,
        );
        return { ...info, exchange: info.exchange || exchange };
      } catch {
        return null;
      }
    },

    async searchResolve(symbol: string): Promise<SymbolInfo | null> {
      if (bridgeProvider !== 'nt8') return adapter.resolve?.(symbol) ?? null;
      try {
        const info = await fetchJson<SymbolInfo & { currentOnly?: boolean }>(
          `${bridgeUrl}/api/resolve?symbol=${encodeURIComponent(symbol)}&currentOnly=true`,
        );
        // An old bridge may ignore the query flag and resolve a non-current expiry.
        return info.currentOnly === true ? { ...info, exchange: info.exchange || exchange } : null;
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
      const key = `${bridgeUrl}?${q}`;
      let entry = cache.get(key);
      if (!entry || entry.expires < Date.now()) {
        const data = fetchJson<{ bars: Bar[] }>(`${bridgeUrl}/api/history?${q}`, 30000)
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
      const es = new EventSource(`${bridgeUrl}/api/stream?${q}`);
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
          .catch(err => console.warn(`${bridgeProviderName(bridgeProvider)} 重连历史补取失败`, err))
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
