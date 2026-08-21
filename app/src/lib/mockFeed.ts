import type { Bar, FeedAdapter, SymbolInfo } from '@/types/market';

/** NT8 未启动时的模拟数据兜底,保证终端始终可用 */

const MOCK_SYMBOLS: SymbolInfo[] = [
  { symbol: 'ES 09-26', name: 'E-mini 标普500 (模拟)', tickSize: 0.25, pointValue: 50, type: 'futures' },
  { symbol: 'MES 09-26', name: '微型标普500 (模拟)', tickSize: 0.25, pointValue: 5, type: 'futures' },
  { symbol: 'NQ 09-26', name: 'E-mini 纳指100 (模拟)', tickSize: 0.25, pointValue: 20, type: 'futures' },
  { symbol: 'MNQ 09-26', name: '微型纳指100 (模拟)', tickSize: 0.25, pointValue: 2, type: 'futures' },
  { symbol: 'GC 12-26', name: '黄金 (模拟)', tickSize: 0.1, pointValue: 100, type: 'futures' },
  { symbol: 'MGC 12-26', name: '微型黄金 (模拟)', tickSize: 0.1, pointValue: 10, type: 'futures' },
  { symbol: 'CL 10-26', name: 'WTI 原油 (模拟)', tickSize: 0.01, pointValue: 1000, type: 'futures' },
  { symbol: '6E 09-26', name: '欧元外汇期货 (模拟)', tickSize: 0.00005, pointValue: 125000, type: 'futures' },
];

/** 由字符串生成稳定随机种子 */
function seedOf(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 伪随机数 */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function alignDown(t: number, step: number): number {
  return Math.floor(t / step) * step;
}

/** 从固定锚点向 to 生成确定性随机走势,再按 from 过滤,保证多次请求之间连续 */
function generateBars(
  symbol: string,
  intervalSec: number,
  from: number,
  to: number,
): Bar[] {
  const rnd = prng(seedOf(`${symbol}|${intervalSec}`));
  const base = 80 + (seedOf(symbol) % 4200);
  const anchor = alignDown(Math.floor(Date.now() / 1000), intervalSec) - 2000 * intervalSec;
  const end = alignDown(to, intervalSec);
  const bars: Bar[] = [];
  let price = base * (0.92 + rnd() * 0.16);
  let drift = 0;
  let i = 0;
  for (let t = anchor; t <= end && bars.length < 2000; t += intervalSec, i++) {
    if (i % 120 === 0) drift = (rnd() - 0.5) * base * 0.0004;
    const open = price;
    let high = open;
    let low = open;
    let close = open;
    for (let k = 0; k < 8; k++) {
      close += drift + (rnd() - 0.5) * base * 0.0016;
      high = Math.max(high, close);
      low = Math.min(low, close);
    }
    price = close;
    if (t >= from) {
      bars.push({ time: t, open, high, low, close, volume: Math.round(300 + rnd() * 4200) });
    }
  }
  return bars;
}

export function createMockAdapter(): FeedAdapter {
  return {
    async getSymbols(): Promise<SymbolInfo[]> {
      return MOCK_SYMBOLS;
    },

    async resolve(symbol: string): Promise<SymbolInfo | null> {
      const known = MOCK_SYMBOLS.find((s) => s.symbol === symbol);
      if (known) return known;
      // 模拟模式下任意合约名都可出图
      return { symbol, name: `${symbol} (模拟)`, tickSize: 0.01, pointValue: 1, type: 'futures' };
    },

    async getHistory(symbol, intervalSec, from, to): Promise<Bar[]> {
      return generateBars(symbol, intervalSec, from, to);
    },

    subscribe(symbol, intervalSec, onBar) {
      const now = Math.floor(Date.now() / 1000);
      const hist = generateBars(symbol, intervalSec, now - intervalSec, now);
      const rnd = prng(seedOf(`${symbol}|live`) + Math.floor(Math.random() * 1e9));
      let last: Bar = hist.length > 0
        ? { ...hist[hist.length - 1] }
        : { time: alignDown(now, intervalSec), open: 100, high: 100, low: 100, close: 100, volume: 0 };

      const timer = setInterval(() => {
        const t = Math.floor(Date.now() / 1000);
        const bucket = alignDown(t, intervalSec);
        if (bucket > last.time) {
          last = {
            time: bucket,
            open: last.close,
            high: last.close,
            low: last.close,
            close: last.close,
            volume: 0,
          };
        }
        const range = Math.max(last.close * 0.0008, 0.01);
        last.close += (rnd() - 0.5) * range;
        last.high = Math.max(last.high, last.close);
        last.low = Math.min(last.low, last.close);
        last.volume += Math.round(rnd() * 120);
        onBar({ ...last });
      }, 800);

      return () => clearInterval(timer);
    },
  };
}
