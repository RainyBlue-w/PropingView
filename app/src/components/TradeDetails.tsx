import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { CandlestickSeries, ColorType, LineSeries, TickMarkType, createChart, createSeriesMarkers, type Time, type UTCTimestamp } from 'lightweight-charts';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import type { Nt8Execution } from '@/lib/nt8Trading';
import { analyzeTrades, compareExecutions, executionDirection, executionKey, executionTime, formatMoney, type MatchedTrade } from '@/lib/tradeAnalytics';
import { checkNt8Status, createNt8Adapter } from '@/lib/nt8Bridge';
import { parseBridgeAccount, displayBridgeAccount } from '@/lib/bridgeAccounts';
import type { Bar, FeedAdapter } from '@/types/market';
import type { BridgeProvider } from '@/lib/config';

interface Props { row: Nt8Execution; rows: Nt8Execution[]; trade?: MatchedTrade; unpairedQty?: number; onClose: () => void; adapter?: FeedAdapter; toTime?: number; historyProvider?: BridgeProvider }

export default function TradeDetails({ row, rows, trade, unpairedQty, onClose, adapter, toTime, historyProvider }: Props) {
  const key = executionKey(row);
  const isUnpaired = !trade && unpairedQty != null;
  const direction = executionDirection((trade?.entry || row).side);
  const pairs = useMemo(() => trade ? [trade] : isUnpaired ? [] : analyzeTrades(rows).trades.filter(t => executionKey(t.entry) === key || executionKey(t.exit) === key), [rows, key, trade, isUnpaired]);
  const related = useMemo(() => trade ? [trade.entry, trade.exit].sort(compareExecutions) : isUnpaired ? [row] : [...new Map([row, ...pairs.flatMap(t => [t.entry, t.exit])].map(e => [executionKey(e), e])).values()].sort(compareExecutions), [row, pairs, trade, isUnpaired]);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[92vh] overflow-auto border-[var(--tv-border)] bg-[var(--tv-panel)] text-[var(--tv-text)] sm:max-w-5xl">
      <DialogTitle>交易详情{isUnpaired ? ' · 未配对' : ''} · {row.instrument || '未知合约'}</DialogTitle>
      <DialogDescription className="text-[var(--tv-muted)]">{row.accountDisplayName || displayBridgeAccount(row.account)} · {trade
        ? <><span className={`inline-flex items-center gap-1 align-middle ${direction > 0 ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>{direction > 0 ? <ArrowUp size={15} aria-hidden="true" /> : <ArrowDown size={15} aria-hidden="true" />}{direction > 0 ? '做多' : '做空'}</span> {trade.qty} · 入场 {new Date(executionTime(trade.entry) * 1000).toLocaleString('zh-CN', { hour12: false })} → 离场 {new Date(executionTime(trade.exit) * 1000).toLocaleString('zh-CN', { hour12: false })}</>
        : <>{new Date(executionTime(row) * 1000).toLocaleString('zh-CN', { hour12: false })} · {direction > 0 ? '买入' : direction < 0 ? '卖出' : '方向未知'} {isUnpaired ? unpairedQty : row.qty} @ {row.price}</>}
      </DialogDescription>
      <DetailChart row={row} related={related} trade={trade} adapter={adapter} toTime={toTime} historyProvider={historyProvider} />
      {trade || isUnpaired ? <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4" data-paired-trade-summary>
        <div><span className="text-xs text-[var(--tv-muted)]">入场价格</span><p className="mt-1 font-mono">{trade?.entry.price ?? row.price}</p></div>
        <div><span className="text-xs text-[var(--tv-muted)]">离场价格</span><p className="mt-1 font-mono">{trade?.exit.price ?? '—'}</p></div>
        <div><span className="text-xs text-[var(--tv-muted)]">成交数量</span><p className="mt-1 font-mono">{trade?.qty ?? unpairedQty}</p></div>
        <div><span className="text-xs text-[var(--tv-muted)]">盈亏额</span><p className={`mt-1 font-mono ${trade?.net == null ? '' : trade.net >= 0 ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>{formatMoney(trade?.net, trade?.currency)}</p></div>
      </div> : <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div><span className="text-xs text-[var(--tv-muted)]">成交手续费</span><p className="mt-1 font-mono">{formatMoney(row.commission, row.currency)}</p></div>
        <div><span className="text-xs text-[var(--tv-muted)]">合约点值</span><p className="mt-1 font-mono">{formatMoney(row.pointValue, row.currency)}</p></div>
        <div className="col-span-2 break-all"><span className="text-xs text-[var(--tv-muted)]">成交 / 订单编号</span><p className="mt-1 font-mono text-xs">{row.executionId || '—'} / {row.orderId || '—'}</p></div>
      </div>}
      <div className="overflow-x-auto rounded-lg border border-[var(--tv-border)]"><table className="account-table"><thead><tr><th>FIFO 进场</th><th>FIFO 出场</th><th>数量</th><th>毛盈亏</th><th>净盈亏</th></tr></thead><tbody>
        {pairs.map((p, i) => <tr key={i}><td>{new Date(executionTime(p.entry) * 1000).toLocaleString('zh-CN')}<div className="text-xs text-[var(--tv-muted)]">{p.entry.side} @ {p.entry.price}</div></td><td>{new Date(executionTime(p.exit) * 1000).toLocaleString('zh-CN')}<div className="text-xs text-[var(--tv-muted)]">{p.exit.side} @ {p.exit.price}</div></td><td>{p.qty}</td><td>{formatMoney(p.gross, p.currency)}</td><td className={p.net == null ? '' : p.net >= 0 ? 'text-[#26a69a]' : 'text-[#ef5350]'}>{formatMoney(p.net, p.currency)}</td></tr>)}
        {!pairs.length && <tr><td colSpan={5} className="text-[var(--tv-muted)]">尚无可配对的进出场，可能仍持仓或另一侧历史未归档。</td></tr>}
      </tbody></table></div>
      {trade && <p className="text-xs text-[var(--tv-muted)]">盈亏额已扣除该配对数量对应的手续费；缺少点值或手续费时显示 —。</p>}
    </DialogContent>
  </Dialog>;
}

function DetailChart({ row, related, trade, adapter, toTime, historyProvider }: Pick<Props, 'row' | 'trade' | 'adapter' | 'toTime' | 'historyProvider'> & { related: Nt8Execution[] }) {
  const host = useRef<HTMLDivElement>(null);
  const [result, setResult] = useState<{ bars: Bar[]; error?: string } | null>(null);
  const start = Math.max(0, Math.min(...related.map(e => e.time)) - 3600);
  const end = Math.min(toTime ?? Math.floor(Date.now() / 1000), Math.max(...related.map(e => e.time)) + 3600);
  const interval = [60, 300, 900, 3600, 14400, 86400].find(value => (end - start) / value <= 600) || 86400;
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        if (!row.instrument) throw new Error('成交记录缺少合约，无法取得 K 线。');
        const provider = historyProvider ?? parseBridgeAccount(row.account || '').provider;
        const status = adapter ? null : await checkNt8Status(provider);
        if (!adapter && !status) throw new Error('数据桥离线，暂时无法读取 K 线。');
        const feed = adapter || createNt8Adapter(status || undefined, provider);
        const bars = await feed.getHistory(row.instrument, interval, start, end);
        if (!cancelled) setResult({ bars: [...new Map(bars.filter(b => b.time >= start && b.time <= end && [b.time, b.open, b.high, b.low, b.close].every(Number.isFinite)).map(b => [b.time, b])).values()].sort((a, b) => a.time - b.time) });
      } catch (error) { if (!cancelled) setResult({ bars: [], error: error instanceof Error ? error.message : '行情读取失败' }); }
    })();
    return () => { cancelled = true; };
  }, [row.instrument, row.account, interval, start, end, adapter, historyProvider]);
  useEffect(() => {
    if (!host.current) return;
    const node = host.current;
    const style = getComputedStyle(node);
    const chart = createChart(node, {
      width: node.clientWidth, height: 340,
      layout: { background: { type: ColorType.Solid, color: style.getPropertyValue('--tv-bg').trim() || '#131722' }, textColor: style.getPropertyValue('--tv-muted').trim() || '#9598a1' },
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
    const candles = chart.addSeries(CandlestickSeries, { upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350', lastValueVisible: false, priceLineVisible: false });
    candles.setData((result?.bars || []).map(b => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
    const fills = chart.addSeries(LineSeries, { color: '#638dff', lineWidth: 2, pointMarkersVisible: true, pointMarkersRadius: 5, priceLineVisible: false, lastValueVisible: false });
    // One price per timestamp is required by the chart API: preserve the selected fill at collisions.
    const plotted = [...new Map([...related, row].map(e => [executionTime(e), e])).values()].sort(compareExecutions);
    fills.setData(plotted.map(e => ({ time: executionTime(e) as UTCTimestamp, value: e.price })));
    createSeriesMarkers(fills, plotted.map(e => {
      const direction = executionDirection(e.side);
      return { time: executionTime(e) as UTCTimestamp, position: direction > 0 ? 'belowBar' as const : direction < 0 ? 'aboveBar' as const : 'inBar' as const, shape: direction > 0 ? 'arrowUp' as const : direction < 0 ? 'arrowDown' as const : 'circle' as const, color: direction > 0 ? '#26a69a' : direction < 0 ? '#ef5350' : '#9598a1', text: '', size: executionKey(e) === executionKey(row) ? 2 : 1.5 };
    }));
    if (trade) {
      fills.createPriceLine({ price: trade.entry.price, color: '#638dff', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '入场价格' });
      fills.createPriceLine({ price: trade.exit.price, color: '#d09cfa', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '离场价格' });
    } else {
      fills.createPriceLine({ price: row.price, color: '#638dff', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: '所选成交' });
    }
    chart.timeScale().fitContent();
    const observer = new ResizeObserver(() => { chart.applyOptions({ width: node.clientWidth }); });
    observer.observe(node);
    return () => { observer.disconnect(); chart.remove(); };
  }, [result, related, row, trade]);
  return <div><div ref={host} data-trade-detail-chart className="h-[340px] w-full overflow-hidden rounded-lg border border-[var(--tv-border)]" />
    <p role="status" className={`mt-2 text-xs ${result?.error ? 'text-amber-500' : 'text-[var(--tv-muted)]'}`}>{!result ? '正在读取交易时段 K 线…' : result.bars.length ? `${result.bars.length} 根 ${interval < 3600 ? `${interval / 60} 分钟` : `${interval / 3600} 小时`} K 线 · 绿箭头买入 / 红箭头卖出，蓝线连接相关成交。` : `该时段暂无可用 K 线，图中仅展示真实成交价格。${result.error ? ` ${result.error}` : ''}`}{new Set(related.map(executionTime)).size < related.length ? ' 同刻成交优先显示所选记录，其余成交价格见下方配对表。' : ''}</p>
  </div>;
}
