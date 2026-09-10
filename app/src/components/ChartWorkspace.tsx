import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import TvAdvancedChart from '@/components/TvAdvancedChart';
import { useOrderLines } from '@/hooks/useOrderLines';
import { usePendingBracketLines } from '@/hooks/usePendingBracketLines';
import { useExecutionTrades } from '@/hooks/useExecutionTrades';
import { detectOrderType, resolvePointValue, roundToTick, tickDecimals } from '@/lib/draftCalc';
import { hasSavedLayout } from '@/lib/tvLayoutStore';
import { bindContextMenu } from '@/lib/tvContextMenu';
import { trading } from '@/lib/tradingRouter';
import type { Nt8Bracket, Nt8Order, Nt8Position } from '@/lib/nt8Trading';
import type { TvDatafeed } from '@/lib/tvDatafeed';
import type { SymbolInfo } from '@/types/market';

const WORKSPACE_KEY = 'nt8-terminal-chart-workspace';
type PaneInfo = { symbol: string; interval: string };
export interface ChartWorkspaceHandle { saveLayouts: () => Promise<void> }
interface Props {
  ref?: Ref<ChartWorkspaceHandle>;
  count: 1 | 2 | 4;
  datafeed: TvDatafeed;
  symbol: string;
  initialInterval: string;
  symbols: SymbolInfo[];
  theme: 'dark' | 'light';
  replay: boolean;
  account: string;
  tradingEnabled: boolean;
  orders: Nt8Order[];
  positions: Nt8Position[];
  brackets: Nt8Bracket[];
  qty: number;
  showTradeHistory: boolean;
  tradeSig: string;
  onChanged: () => void;
  onActiveWidget: (widget: TradingViewWidget) => void;
}

function readWorkspace(): { active: number; panes: PaneInfo[] } {
  try {
    const value = JSON.parse(localStorage.getItem(WORKSPACE_KEY) || '{}');
    return {
      active: Number.isInteger(value.active) && value.active >= 0 && value.active < 4 ? value.active : 0,
      panes: Array.isArray(value.panes) ? value.panes.slice(0, 4).map((p: Partial<PaneInfo> | null) => ({
        symbol: typeof p?.symbol === 'string' ? p.symbol : '',
        interval: typeof p?.interval === 'string' && p.interval ? p.interval : '1',
      })) : [],
    };
  } catch { return { active: 0, panes: [] }; }
}

/** Each pane owns its drawings and chart events; selecting a pane only routes the order ticket. */
export default function ChartWorkspace({ ref, ...props }: Props) {
  const { count, replay, symbol, initialInterval, symbols, onActiveWidget } = props;
  const [saved] = useState(() => replay ? { active: 0, panes: [] as PaneInfo[] } : readWorkspace());
  const [active, setActive] = useState(saved.active < count ? saved.active : 0);
  const [mountedCount, setMountedCount] = useState(count);
  // Retain already opened charts when reducing the grid so unsaved drawings and subscriptions survive.
  if (count > mountedCount) setMountedCount(count);
  if (active >= count) setActive(0);
  const [panes, setPanes] = useState<PaneInfo[]>(() => {
    const candidates = [symbol, ...symbols.map(s => s.symbol).filter(s => s !== symbol)];
    return Array.from({ length: 4 }, (_, index) => ({
      symbol: saved.panes[index]?.symbol || candidates[index] || symbol,
      interval: saved.panes[index]?.interval || initialInterval,
    }));
  });
  // Initial props stay fixed: changing a symbol must use chart.setSymbol, never reconstruct a widget.
  const [initialPanes] = useState(panes);
  const widgets = useRef(new Map<number, TradingViewWidget>());
  useImperativeHandle(ref, () => ({
    saveLayouts: async () => {
      if (replay) return;
      await Promise.all(Array.from(widgets.current.values()).map(widget => new Promise<void>((resolve, reject) => {
        if (!widget.saveChartToServer) { resolve(); return; }
        widget.saveChartToServer(resolve, () => reject(new Error('图表布局保存失败，请检查浏览器存储后重试。')), { defaultChartName: '默认布局' });
      })));
    },
  }), [replay]);
  const [readyVersion, setReadyVersion] = useState(0);
  const recordPane = useCallback((index: number, info: PaneInfo) => {
    setPanes(current => current[index].symbol === info.symbol && current[index].interval === info.interval
      ? current : current.map((p, i) => i === index ? info : p));
  }, []);
  const register = useCallback((index: number, widget: TradingViewWidget | null) => {
    if (widget) widgets.current.set(index, widget);
    else widgets.current.delete(index);
    setReadyVersion(v => v + 1);
  }, []);
  useEffect(() => {
    const widget = widgets.current.get(active);
    if (widget) onActiveWidget(widget);
  }, [active, readyVersion, onActiveWidget]);
  useEffect(() => {
    if (!replay) {
      try { localStorage.setItem(WORKSPACE_KEY, JSON.stringify({ active, panes })); } catch { /* Preferences are optional. */ }
    }
  }, [active, panes, replay]);

  return <div data-chart-workspace data-chart-count={count} className={`grid h-full min-h-0 min-w-0 gap-px bg-[var(--tv-border)] ${count === 1 ? 'grid-cols-1 grid-rows-1' : count === 2 ? 'grid-cols-2 grid-rows-1' : 'grid-cols-2 grid-rows-2'}`}>
    {initialPanes.slice(0, mountedCount).map((info, index) => <ChartPane
      key={index} {...props} index={index} info={info} active={index === active} visible={index < count}
      multiple={count > 1} onSelect={setActive} onRegister={register} onInfo={recordPane}
    />)}
  </div>;
}

function ChartPane({ index, info, active, visible, multiple, onSelect, onRegister, onInfo, ...props }: Props & {
  index: number; info: PaneInfo; active: boolean; visible: boolean; multiple: boolean;
  onSelect: (index: number) => void;
  onRegister: (index: number, widget: TradingViewWidget | null) => void;
  onInfo: (index: number, info: PaneInfo) => void;
}) {
  const { datafeed, theme, replay, symbols, account, tradingEnabled, orders, positions, brackets, qty, showTradeHistory, tradeSig, onChanged } = props;
  const [widget, setWidget] = useState<TradingViewWidget | null>(null);
  const [current, setCurrent] = useState(info);
  const [epoch, setEpoch] = useState(0);
  const hostRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<TradingViewWidget | null>(null);
  const onReady = useCallback((w: TradingViewWidget) => {
    widgetRef.current = w;
    w.onChartReady(() => { if (widgetRef.current === w) setWidget(w); });
  }, []);

  useEffect(() => {
    if (!widget) return;
    let unsubscribe = () => {};
    let initialized = false;
    const bind = () => {
      unsubscribe();
      const chart = widget.activeChart();
      const sync = () => {
        const next = { symbol: chart.symbol(), interval: chart.resolution() };
        setCurrent(next);
        onInfo(index, next);
        setEpoch(e => e + 1);
      };
      const symbolEvent = chart.onSymbolChanged(), intervalEvent = chart.onIntervalChanged();
      symbolEvent.subscribe(null, sync);
      intervalEvent.subscribe(null, sync);
      unsubscribe = () => {
        symbolEvent.unsubscribe?.(null, sync);
        intervalEvent.unsubscribe?.(null, sync);
      };
      sync();
      try {
        if (!initialized && !chart.getAllStudies?.().length && !hasSavedLayout(index ? `chart-${index + 1}` : undefined)) {
          void chart.createStudy?.('Moving Average Exponential', false, false, { length: 20 });
        }
      } catch { /* An unavailable study or stored layout must not prevent chart use. */ }
      initialized = true;
    };
    bind();
    widget.subscribe?.('chart_loaded', bind);
    onRegister(index, widget);
    // Iframe pointer/focus events do not bubble to the outer React document.
    const frame = hostRef.current?.querySelector('iframe');
    const activate = () => onSelect(index);
    const frameDocument = frame?.contentDocument;
    frameDocument?.addEventListener('pointerdown', activate, true);
    frameDocument?.addEventListener('focusin', activate, true);
    return () => {
      unsubscribe();
      // The child widget may already have removed its iframe during React cleanup.
      try { widget.unsubscribe?.('chart_loaded', bind); } catch { /* The removed iframe has no event bus. */ }
      frameDocument?.removeEventListener('pointerdown', activate, true);
      frameDocument?.removeEventListener('focusin', activate, true);
      onRegister(index, null);
    };
  }, [widget, index, onInfo, onRegister, onSelect]);

  useEffect(() => () => { widgetRef.current = null; }, []);
  useEffect(() => {
    if (widget && widget.getTheme?.().toLowerCase() !== theme) void widget.changeTheme?.(theme);
  }, [widget, theme]);
  const instrument = symbols.find(s => s.symbol === current.symbol);
  const tickSize = instrument?.tickSize || 0.25;
  const pointValue = resolvePointValue(current.symbol, instrument?.pointValue);
  const getLastPrice = useCallback(() => datafeed.getLastPrice(current.symbol), [datafeed, current.symbol]);
  const subscribePrice = useCallback((fn: (symbol: string, price: number) => void) => datafeed.onPriceChange(fn), [datafeed]);
  useOrderLines({ widget, symbol: current.symbol, account, orders, positions, brackets, tickSize, pointValue,
    getLastPrice, subscribePrice, theme, epoch, onChanged });
  usePendingBracketLines({ widget, symbol: current.symbol, account, orders, brackets, pointValue, epoch });
  useExecutionTrades({ widget, symbol: current.symbol, account: tradingEnabled ? account : '', pointValue,
    refreshKey: tradeSig, enabled: showTradeHistory && visible, epoch });

  useEffect(() => {
    if (!widget) return;
    let contextValid = true;
    const unbind = bindContextMenu(widget, (_time, price) => {
      if (!contextValid || !visible || !tradingEnabled || !account || !(price > 0)) return [];
      // Capture this chart's symbol and account when the menu opens, independent of the active ticket.
      const symbol = widget.activeChart().symbol();
      if (symbol !== current.symbol) return [];
      const rounded = roundToTick(price, tickSize), market = datafeed.getLastPrice(symbol);
      return (['BUY', 'SELL'] as const).map(action => {
        const orderType = detectOrderType(action, rounded, market);
        return {
          position: 'top' as const,
          text: `${action === 'BUY' ? '买入' : '卖出'}${orderType === 'LIMIT' ? '限价' : '止损'} @ ${rounded.toFixed(tickDecimals(tickSize))} ×${qty}`,
          click: () => {
            if (!contextValid || widgetRef.current !== widget || widget.activeChart().symbol() !== symbol) return;
            void trading.placeOrder({ account, symbol, action, orderType, quantity: qty,
              limitPrice: orderType === 'LIMIT' ? rounded : undefined,
              stopPrice: orderType === 'STOPMARKET' ? rounded : undefined,
            }).then(onChanged).catch(err => window.alert(err instanceof Error ? err.message : '下单失败'));
          },
        };
      });
    });
    return () => {
      contextValid = false;
      unbind();
    };
  }, [widget, current.symbol, tickSize, datafeed, qty, account, tradingEnabled, visible, onChanged]);

  return <div ref={hostRef} data-chart-pane={index + 1} data-active={active} hidden={!visible} inert={!visible}
    onPointerDown={() => { if (widget) onSelect(index); }}
    className={`${visible ? 'flex' : 'hidden'} relative min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--tv-bg)] ${multiple && active ? 'ring-2 ring-inset ring-[#2962ff]' : ''}`}>
    {multiple && <button type="button" aria-label={`选择图表 ${index + 1}`} aria-pressed={active} disabled={!widget} onClick={() => onSelect(index)}
      className={`flex h-7 shrink-0 items-center justify-between gap-2 border-b px-3 text-xs ${active ? 'border-[#2962ff]/50 bg-[#2962ff]/15 text-[#5b8cff]' : 'border-[var(--tv-border)] bg-[var(--tv-panel)] text-[var(--tv-muted)]'}`}>
      <span className="truncate">{index + 1} · {current.symbol}</span><span className="shrink-0">{active ? '当前交易图表' : '点击选择'}</span>
    </button>}
    <div className="min-h-0 flex-1"><TvAdvancedChart datafeed={datafeed} symbol={info.symbol} initialInterval={info.interval}
      theme={theme} persistLayout={!replay} layoutScope={index ? `chart-${index + 1}` : undefined} onWidgetReady={onReady} /></div>
  </div>;
}
