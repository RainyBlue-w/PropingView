import type { Bar, FeedAdapter, SymbolInfo } from '@/types/market';
import { getBridgeUrl } from './config';

export interface Nt8Status {
  connected: boolean;
  connectionName?: string;
  version?: string;
  time?: number;
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
export function createNt8Adapter(): FeedAdapter {
  return {
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
      const q = new URLSearchParams({
        symbol,
        interval: String(intervalSec),
        from: String(from),
        to: String(to),
      });
      const data = await fetchJson<{ bars: Bar[] }>(
        `${getBridgeUrl()}/api/history?${q}`,
        20000,
      );
      return data.bars;
    },

    subscribe(symbol, intervalSec, onBar) {
      const q = new URLSearchParams({
        symbol,
        interval: String(intervalSec),
      });
      const es = new EventSource(`${getBridgeUrl()}/api/stream?${q}`);
      es.onmessage = (ev) => {
        try {
          onBar(JSON.parse(ev.data) as Bar);
        } catch {
          /* 忽略坏帧 */
        }
      };
      return () => es.close();
    },
  };
}
