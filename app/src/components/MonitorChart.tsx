import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, ColorType, TickMarkType, type IChartApi, type IPriceLine, type ISeriesApi, type Time, type UTCTimestamp } from 'lightweight-charts';
import type { BridgeProvider } from '@/lib/config';
import { resolvePointValue } from '@/lib/draftCalc';
import { positionLineTitle, type Protection } from '@/lib/monitorData';
import { checkNt8Status, createNt8Adapter } from '@/lib/nt8Bridge';
import type { Nt8Position } from '@/lib/nt8Trading';
import type { FeedAdapter } from '@/types/market';

const HISTORY_BARS = 240;

interface Props {
  provider: BridgeProvider;
  instrument: string;
  intervalSec: number;
  position: Nt8Position | null;
  protection: Protection;
  onPrice: (instrument: string, price: number) => void;
  onPointValue: (instrument: string, pointValue: number) => void;
}

/** 适配器按行情源缓存;离线时移除缓存以便下次重试 */
const adapterCache = new Map<BridgeProvider, Promise<FeedAdapter>>();
function getMonitorAdapter(provider: BridgeProvider): Promise<FeedAdapter> {
  let entry = adapterCache.get(provider);
  if (!entry) {
    entry = (async () => {
      const status = await checkNt8Status(provider);
      if (!status) throw new Error('数据桥离线，暂时无法读取 K 线。');
      return createNt8Adapter(status, provider);
    })();
    adapterCache.set(provider, entry);
    entry.catch(() => { if (adapterCache.get(provider) === entry) adapterCache.delete(provider); });
  }
  return entry;
}

function isLightBackground(color: string): boolean {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return false;
  const value = parseInt(match[1], 16);
  const r = (value >> 16) & 255, g = (value >> 8) & 255, b = value & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

/** 监控卡片内嵌小 K 线图:历史 + SSE 实时,持仓均价线和 TP/SL 线;只读,不含任何交易操作 */
export default function MonitorChart({ provider, instrument, intervalSec, position, protection, onPrice, onPointValue }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const linesRef = useRef<IPriceLine[]>([]);
  const posLineRef = useRef<IPriceLine | null>(null);
  const lastPriceRef = useRef<number | null>(null);
  const lastBarTimeRef = useRef(0);
  const pointValueRef = useRef(0);
  const posColorRef = useRef('#f0b90b');
  const positionRef = useRef(position);
  const callbacksRef = useRef({ onPrice, onPointValue });
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => { callbacksRef.current = { onPrice, onPointValue }; });

  // 图表只创建一次;主题色读取创建时的 CSS 变量(与交易详情图一致)
  useEffect(() => {
    if (!host.current) return;
    const node = host.current;
    const style = getComputedStyle(node);
    const bg = style.getPropertyValue('--tv-bg').trim() || '#131722';
    posColorRef.current = isLightBackground(bg) ? '#c89400' : '#f0b90b';
    const chart = createChart(node, {
      width: node.clientWidth, height: 260,
      layout: { background: { type: ColorType.Solid, color: bg }, textColor: style.getPropertyValue('--tv-muted').trim() || '#9598a1' },
      grid: { vertLines: { color: '#80808018' }, horzLines: { color: '#80808018' } },
      localization: { locale: 'zh-CN', timeFormatter: (time: Time) => new Date(Number(time) * 1000).toLocaleString('zh-CN', { hour12: false }) },
      timeScale: {
        timeVisible: true, secondsVisible: false,
        tickMarkFormatter: (time: Time, type: TickMarkType, locale: string) => {
          // Format in the user's timezone without shifting any UTC data timestamps.
          const date = typeof time === 'number' ? new Date(time * 1000)
            : typeof time === 'string' ? new Date(`${time}T00:00:00`)
              : new Date(time.year, time.month - 1, time.day);
          if (type === TickMarkType.Year) return date.toLocaleDateString(locale, { year: 'numeric' });
          if (type === TickMarkType.Month) return date.toLocaleDateString(locale, { month: 'short' });
          if (type === TickMarkType.DayOfMonth) return date.toLocaleDateString(locale, { day: 'numeric' });
          return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', ...(type === TickMarkType.TimeWithSeconds ? { second: '2-digit' as const } : {}), hourCycle: 'h23' });
        },
      },
    });
    const candles = chart.addSeries(CandlestickSeries, { upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350' });
    chartRef.current = chart;
    seriesRef.current = candles;
    const observer = new ResizeObserver(() => { chart.applyOptions({ width: node.clientWidth }); });
    observer.observe(node);
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      linesRef.current = [];
      posLineRef.current = null;
    };
  }, []);

  // 历史 + 实时订阅;换合约 / 周期 / 行情源时取消旧请求和订阅
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    const feedKey = `${provider}|${instrument}|${intervalSec}`;
    lastBarTimeRef.current = 0;
    lastPriceRef.current = null;
    const refreshPosTitle = () => {
      const pos = positionRef.current;
      if (posLineRef.current && pos) posLineRef.current.applyOptions({ title: positionLineTitle(pos, lastPriceRef.current, pointValueRef.current) });
    };
    void (async () => {
      try {
        const adapter = await getMonitorAdapter(provider);
        const to = Math.floor(Date.now() / 1000);
        const from = to - HISTORY_BARS * intervalSec;
        const [bars, info] = await Promise.all([
          adapter.getHistory(instrument, intervalSec, from, to),
          adapter.resolve ? adapter.resolve(instrument) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setFailure(current => current?.key === feedKey ? null : current);
        const clean = [...new Map(bars.filter(b => [b.time, b.open, b.high, b.low, b.close].every(Number.isFinite)).map(b => [b.time, b])).values()]
          .sort((a, b) => a.time - b.time);
        seriesRef.current?.setData(clean.map(b => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
        chartRef.current?.timeScale().fitContent();
        lastBarTimeRef.current = clean.at(-1)?.time ?? 0;
        const pv = resolvePointValue(instrument, info?.pointValue);
        pointValueRef.current = pv;
        callbacksRef.current.onPointValue(instrument, pv);
        const last = clean.at(-1);
        if (last) {
          lastPriceRef.current = last.close;
          callbacksRef.current.onPrice(instrument, last.close);
        }
        refreshPosTitle();
        unsubscribe = adapter.subscribe(instrument, intervalSec, (bar) => {
          if (cancelled || bar.time < lastBarTimeRef.current) return;
          lastBarTimeRef.current = bar.time;
          lastPriceRef.current = bar.close;
          seriesRef.current?.update({ time: bar.time as UTCTimestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
          callbacksRef.current.onPrice(instrument, bar.close);
          refreshPosTitle();
        });
      } catch (err) {
        if (!cancelled) setFailure({ key: feedKey, message: err instanceof Error ? err.message : '行情读取失败' });
      }
    })();
    return () => { cancelled = true; unsubscribe?.(); };
  }, [provider, instrument, intervalSec]);

  // 持仓均价线 + 工作 TP/SL 单线;轮询更新时重建
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const line of linesRef.current) series.removePriceLine(line);
    linesRef.current = [];
    posLineRef.current = null;
    if (position && position.averagePrice > 0) {
      const line = series.createPriceLine({
        price: position.averagePrice, color: posColorRef.current, lineWidth: 2, lineStyle: 0,
        axisLabelVisible: true, title: positionLineTitle(position, lastPriceRef.current, pointValueRef.current),
      });
      posLineRef.current = line;
      linesRef.current.push(line);
    }
    for (const leg of protection.tp) {
      linesRef.current.push(series.createPriceLine({ price: leg.price, color: '#26a69a', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: `TP +${leg.qty}` }));
    }
    for (const leg of protection.sl) {
      linesRef.current.push(series.createPriceLine({ price: leg.price, color: '#ef5350', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: `SL -${leg.qty}` }));
    }
  }, [position, protection]);

  const feedKey = `${provider}|${instrument}|${intervalSec}`;
  const error = failure?.key === feedKey ? failure.message : null;
  return <div>
    <div ref={host} data-monitor-chart className="h-[260px] w-full overflow-hidden rounded-lg border border-[var(--tv-border)]" />
    {error && <p role="status" className="mt-1 text-xs text-amber-500">{error}</p>}
  </div>;
}
