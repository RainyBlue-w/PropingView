/* TradingView Charting Library 全局对象类型声明(简化版) */
/* eslint-disable @typescript-eslint/no-explicit-any */

interface TradingViewSubscription {
  subscribe: (owner: unknown, callback: (...args: any[]) => void) => void;
  unsubscribe?: (owner: unknown, callback: (...args: any[]) => void) => void;
}

interface TradingViewChart {
  removeEntity: (id: string) => void;
  getShapeById: (id: string) => {
    setPoints: (points: { time: number; price: number }[]) => void;
    setProperties: (properties: Record<string, unknown>) => void;
  };
  createMultipointShape: (
    points: { time: number; price: number }[],
    options: Record<string, unknown>,
  ) => Promise<string | null> | string | null;
  resetData: () => void;
  setSymbol: (symbol: string, callback?: () => void) => void;
  setResolution: (resolution: string, callback?: () => void) => void;
  symbol: () => string;
  resolution: () => string;
  getAllStudies?: () => { id: string; name: string }[];
  createStudy?: (name: string, forceOverlay: boolean, lock: boolean, inputs: Record<string, unknown>) => Promise<string | null>;
  onSymbolChanged: () => TradingViewSubscription;
  onIntervalChanged: () => TradingViewSubscription;
  dataReady(): Promise<boolean>;
  dataReady(callback: () => void): boolean;
  onChartTypeChanged?: () => TradingViewSubscription;
  createOrderLine: () => Promise<any>;
  createPositionLine: () => Promise<any>;
  /** 重新拉取图表 marks(交易历史) */
  refreshMarks?: () => void;
}

interface TradingViewWidget {
  getTheme?: () => 'dark' | 'light';
  changeTheme?: (theme: 'dark' | 'light') => Promise<void>;
  remove: () => void;
  onChartReady: (callback: () => void) => void;
  activeChart: () => TradingViewChart;
  /** 订阅 widget 事件,如 onAutoSaveNeeded(图表内容被用户修改) */
  subscribe?: (event: string, callback: (...args: any[]) => void) => void;
  unsubscribe?: (event: string, callback: (...args: any[]) => void) => void;
  /** 经 adapter 保存布局；自动保存用 defaultChartName 补空名，保留用户命名。 */
  saveChartToServer?: (
    onComplete?: () => void,
    onFail?: (err: unknown) => void,
    options?: { chartName?: string; defaultChartName?: string },
  ) => void;
  /** 追加右键菜单回调（不会替换旧回调）；应用通过 bindContextMenu 管理当前菜单。 */
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
