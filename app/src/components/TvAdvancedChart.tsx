import { useEffect, useRef } from 'react';
import type { TvDatafeed } from '@/lib/tvDatafeed';

interface TvAdvancedChartProps {
  datafeed: TvDatafeed;
  symbol: string;
  /** 初始主题;运行时切换由宿主调 widget.changeTheme,不重建图表 */
  theme: 'dark' | 'light';
  onWidgetReady?: (widget: TradingViewWidget) => void;
}

/**
 * TradingView Charting Library(高级图表)挂载组件。
 * 图表库文件位于 public/charting_library,通过 <script> 全局加载。
 */
export default function TvAdvancedChart({
  datafeed,
  symbol,
  theme,
  onWidgetReady,
}: TvAdvancedChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onWidgetReadyRef = useRef(onWidgetReady);
  onWidgetReadyRef.current = onWidgetReady;

  useEffect(() => {
    const el = containerRef.current;
    const TV = window.TradingView;
    if (!el || !TV || !symbol) return;

    const widget = new TV.widget({
      container: el,
      library_path: 'charting_library/',
      datafeed,
      symbol,
      interval: '1',
      locale: 'zh',
      theme,
      timezone: 'Asia/Shanghai',
      // 注意:不能同时开 fullscreen 和 autosize。
      // fullscreen 会按整个窗口建立内部坐标模型,与 flex 容器(图表+交易面板)
      // 的实际显示尺寸冲突,导致拖拽绘图时价格/像素换算比例错误(距离越远偏差越大)。
      // 只保留 autosize,让图表始终跟随容器尺寸。
      autosize: true,
      debug: false,
      // 开启右键菜单自定义项(onContextMenu 回调依赖此开关,否则注入的项不出现)
      enabled_features: ['custom_items_in_context_menu'],
    });

    onWidgetReadyRef.current?.(widget);
    try {
      (window as unknown as Record<string, unknown>).__lastWidget = widget;
    } catch {
      /* ignore */
    }

    return () => {
      try {
        widget.remove();
      } catch {
        /* ignore */
      }
    };
  }, [datafeed, symbol]);

  return <div ref={containerRef} className="h-full w-full" />;
}
