import { useEffect, useRef, useState } from 'react';
import type { TvDatafeed } from '@/lib/tvDatafeed';
import { createLayoutAdapter, getLastSavedLayout, getLayoutSavedData, rememberLayout } from '@/lib/tvLayoutStore';
import { notifyBeforeLayoutLoad } from '@/lib/tvLayoutEvents';

let nextDatafeedInstance = 0;

interface TvAdvancedChartProps {
  datafeed: TvDatafeed;
  symbol: string;
  /** 初始周期(只在创建 widget 时生效;运行中切周期由图表自己管理) */
  initialInterval: string;
  /** 初始主题;运行时切换由宿主调 widget.changeTheme,不重建图表 */
  theme: 'dark' | 'light';
  /** 回放会话使用自己的合约与周期，不覆盖实盘图表布局。 */
  persistLayout?: boolean;
  /** 主图省略；额外图表使用稳定 ID，分别保存和恢复原生布局。 */
  layoutScope?: string;
  onWidgetReady?: (widget: TradingViewWidget) => void;
}

/**
 * TradingView Charting Library(高级图表)挂载组件。
 * v32.1 图表库位于 public/charting_library，通过 index.html 中带版本号的 <script> 加载。
 */
export default function TvAdvancedChart({
  datafeed,
  symbol,
  initialInterval,
  theme,
  persistLayout = true,
  layoutScope,
  onWidgetReady,
}: TvAdvancedChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [layoutError, setLayoutError] = useState('');
  const onWidgetReadyRef = useRef(onWidgetReady);
  useEffect(() => { onWidgetReadyRef.current = onWidgetReady; }, [onWidgetReady]);
  const themeRef = useRef(theme);
  useEffect(() => { themeRef.current = theme; }, [theme]);
  const initialIntervalRef = useRef(initialInterval);

  useEffect(() => {
    const el = containerRef.current;
    const TV = window.TradingView;
    if (!el || !TV || !symbol) return;

    let disposed = false;
    const subscriptionPrefix = `widget-${++nextDatafeedInstance}:`;
    const subscriptions = new Set<string>();
    // 各 widget 可能产生相同 listenerGuid。共享行情缓存，但隔离订阅的归属，
    // 避免关闭或切换一个图表时停止其他图表的实时数据。
    const widgetDatafeed = new Proxy(datafeed, {
      get(target, property) {
        if (property === 'subscribeBars') {
          return (...args: Parameters<TvDatafeed['subscribeBars']>) => {
            if (disposed) return;
            args[3] = `${subscriptionPrefix}${args[3]}`;
            if (subscriptions.has(args[3])) target.unsubscribeBars(args[3]);
            subscriptions.add(args[3]);
            return target.subscribeBars(...args);
          };
        }
        if (property === 'unsubscribeBars') {
          return (guid: string) => {
            const scopedGuid = `${subscriptionPrefix}${guid}`;
            subscriptions.delete(scopedGuid);
            return target.unsubscribeBars(scopedGuid);
          };
        }
        // onReady/searchSymbols/resolveSymbol/getBars 等方法必须仍以原实例为 this。
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    let savedData: object | undefined;
    try {
      const saved = persistLayout ? getLastSavedLayout(layoutScope) : null;
      if (saved) savedData = getLayoutSavedData(saved);
    } catch {
      // 与外部存储同步；读取失败不能把损坏的数据当作空库并覆盖。
      setLayoutError('无法读取本地布局，原数据已保留。');
    }
    let pendingLayoutId: string | undefined;

    const widget = new TV.widget({
      container: el,
      library_path: 'charting_library/',
      datafeed: widgetDatafeed,
      // 显式传 symbol/interval 会覆盖 saved_data 中保存的合约和周期。
      ...(savedData ? { saved_data: savedData } : { symbol, interval: initialIntervalRef.current }),
      locale: 'zh',
      theme: themeRef.current,
      timezone: 'Asia/Shanghai',
      // 注意:不能同时开 fullscreen 和 autosize。
      // fullscreen 会按整个窗口建立内部坐标模型,与 flex 容器(图表+交易面板)
      // 的实际显示尺寸冲突,导致拖拽绘图时价格/像素换算比例错误(距离越远偏差越大)。
      // 只保留 autosize,让图表始终跟随容器尺寸。
      autosize: true,
      debug: false,
      // 开启右键菜单自定义项(onContextMenu 回调依赖此开关,否则注入的项不出现)
      enabled_features: ['custom_items_in_context_menu'],
      // 禁用库内置合约搜索(顶栏按钮 + 键盘快搜),统一用自建的收藏搜索栏,
      // 避免两套搜索候选不一致(库内搜索无星标置顶)
      disabled_features: ['header_symbol_search', 'symbol_search_hot_key'],
      // 布局持久化:指标(含参数/颜色)、绘图、周期、图表样式变化后自动保存
      // 到 localStorage，下次从 saved_data 恢复最近打开的独立布局。
      save_load_adapter: persistLayout ? createLayoutAdapter({
        scope: layoutScope,
        onChartLoadRequested: id => {
          // 库自己的 requested 订阅会先开始移除旧绘图，必须在返回内容前保护交易线。
          beginLoad();
          notifyBeforeLayoutLoad(widget);
          pendingLayoutId = id;
        },
      }) : undefined,
      load_last_chart: false,
      auto_save_delay: 1,
    });

    // 自动保存:用户每次可撤销的图表修改(增删指标/改参数/画图等)都会触发
    // onAutoSaveNeeded(auto_save_delay 节流),立即经 adapter 写入 localStorage。
    // 注意:程序化修改(如脚本 createStudy)不触发该事件,需自行调 saveChartToServer;
    // defaultChartName 只补空名；chartName 会把用户命名的布局改回默认名称。
    let loading = true;
    let unsubscribeChart = () => {};
    const saveTimers = new Set<ReturnType<typeof setTimeout>>();
    const clearSaveTimers = () => {
      for (const timer of saveTimers) clearTimeout(timer);
      saveTimers.clear();
    };
    const saveLayout = () => {
      if (disposed || loading || !persistLayout) return;
      widget.saveChartToServer?.(
        () => { if (!disposed) setLayoutError(''); },
        () => { if (!disposed) setLayoutError('布局保存失败，请检查浏览器存储空间及权限后重试保存。'); },
        { defaultChartName: '默认布局' },
      );
    };
    const scheduleSave = (delay: number) => {
      const timer = setTimeout(() => {
        saveTimers.delete(timer);
        saveLayout();
      }, delay);
      saveTimers.add(timer);
      return timer;
    };
    widget.subscribe?.('onAutoSaveNeeded', saveLayout);

    const bindChart = () => {
      if (disposed) return;
      unsubscribeChart();
      const chart = widget.activeChart();
      // 换合约/切周期/改图表类型不是可撤销动作,不会触发自动保存,各自订阅兜底
      // (防抖:连续切换只存最后一次)
      let timer: ReturnType<typeof setTimeout> | undefined;
      const debouncedSave = () => {
        if (loading || disposed) return;
        if (timer) { clearTimeout(timer); saveTimers.delete(timer); }
        timer = scheduleSave(800);
      };
      const subscriptions = [chart.onSymbolChanged(), chart.onIntervalChanged(), chart.onChartTypeChanged?.()];
      for (const event of subscriptions) event?.subscribe(null, debouncedSave);
      unsubscribeChart = () => {
        for (const event of subscriptions) event?.unsubscribe?.(null, debouncedSave);
      };
    };
    const beginLoad = () => {
      loading = true;
      clearSaveTimers();
      unsubscribeChart();
    };
    const finishLoad = () => {
      if (disposed) return;
      loading = false;
      bindChart();
      if (pendingLayoutId !== undefined) {
        try { rememberLayout(pendingLayoutId, layoutScope); }
        catch { setLayoutError('无法记住最近打开的布局，请检查浏览器存储空间及权限。'); }
        pendingLayoutId = undefined;
      }
    };
    widget.subscribe?.('chart_load_requested', beginLoad);
    widget.subscribe?.('chart_loaded', finishLoad);
    widget.onChartReady(finishLoad);
    const saveProperties = () => { if (!loading && !disposed) scheduleSave(800); };
    widget.subscribe?.('series_properties_changed', saveProperties);
    widget.subscribe?.('study_properties_changed', saveProperties);
    widget.subscribe?.('chart_theme_changed', saveProperties);
    // 对话框内部分背景/坐标属性没有专用变更事件，保留延时保存兜底。
    widget.subscribe?.('edit_object_dialog', () => {
      scheduleSave(1500);
      scheduleSave(6000);
    });

    onWidgetReadyRef.current?.(widget);
    try {
      if (layoutScope === undefined) (window as unknown as Record<string, unknown>).__lastWidget = widget;
    } catch {
      /* ignore */
    }

    return () => {
      // 回放进出会重建 widget，旧布局定时器不能再访问已移除的 iframe API。
      disposed = true;
      clearSaveTimers();
      unsubscribeChart();
      notifyBeforeLayoutLoad(widget);
      try {
        widget.remove();
      } catch {
        /* ignore */
      } finally {
        for (const guid of subscriptions) datafeed.unsubscribeBars(guid);
        subscriptions.clear();
      }
    };
  }, [datafeed, symbol, persistLayout, layoutScope]);

  return <div className="relative h-full w-full">
    <div ref={containerRef} className="h-full w-full" />
    {layoutError && <div role="alert" className="absolute bottom-10 left-14 right-4 z-30 rounded border border-red-500/40 bg-[var(--tv-panel)] px-3 py-2 text-sm text-red-500">{layoutError}</div>}
  </div>;
}
