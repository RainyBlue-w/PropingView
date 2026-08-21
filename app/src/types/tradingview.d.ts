/* TradingView Charting Library 全局对象类型声明(简化版) */
/* eslint-disable @typescript-eslint/no-explicit-any */

interface TradingViewSubscription {
  subscribe: (owner: unknown, callback: (...args: any[]) => void) => void;
  unsubscribe?: (owner: unknown, callback: (...args: any[]) => void) => void;
}

interface TradingViewChart {
  resetData: () => void;
  setSymbol: (symbol: string, callback?: () => void) => void;
  setResolution: (resolution: string, callback?: () => void) => void;
  symbol: () => string;
  onSymbolChanged: () => TradingViewSubscription;
  onIntervalChanged: () => TradingViewSubscription;
  createOrderLine: () => Promise<any>;
  createPositionLine: () => Promise<any>;
  /** 重新拉取图表 marks(交易历史) */
  refreshMarks?: () => void;
}

interface TradingViewWidget {
  remove: () => void;
  onChartReady: (callback: () => void) => void;
  activeChart: () => TradingViewChart;
  /** 右键菜单自定义:回调收到右击位置的时间/价格,返回要增删的菜单项 */
  onContextMenu: (
    callback: (unixTime: number, price: number) => TradingViewContextMenuItem[],
  ) => void;
}

interface TradingViewContextMenuItem {
  position: 'top' | 'bottom';
  /** 文本;'-' 为分隔符;'-名称' 删除已有项 */
  text: string;
  click?: () => void;
}

interface TradingViewGlobal {
  widget: new (options: any) => TradingViewWidget;
}

interface Window {
  TradingView?: TradingViewGlobal;
  Datafeeds?: any;
}
