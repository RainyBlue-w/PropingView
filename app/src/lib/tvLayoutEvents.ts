// 原生 chart_load_requested 的内置订阅会先开始替换绘图模型。
// 在 adapter 返回布局内容前同步通知交易线，避免删除事件被误当作撤单。
const listeners = new WeakMap<object, Set<() => void>>();

export function notifyBeforeLayoutLoad(widget: TradingViewWidget): void {
  for (const callback of Array.from(listeners.get(widget) ?? [])) callback();
}

export function onBeforeLayoutLoad(widget: TradingViewWidget, callback: () => void): () => void {
  let callbacks = listeners.get(widget);
  if (!callbacks) {
    callbacks = new Set();
    listeners.set(widget, callbacks);
  }
  callbacks.add(callback);
  return () => {
    callbacks.delete(callback);
    if (callbacks.size === 0) listeners.delete(widget);
  };
}
