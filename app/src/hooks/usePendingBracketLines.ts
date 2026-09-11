import { useEffect, useRef } from 'react';
import type { Nt8Bracket, Nt8Order } from '@/lib/nt8Trading';
import { matchesChartInstrument } from '@/lib/chartInstrument';

interface Params {
  widget: TradingViewWidget | null;
  symbol: string;
  account: string;
  epoch: number;
  orders: Nt8Order[];
  brackets: Nt8Bracket[];
  pointValue: number;
}

/** 尚未挂到交易所的保护价只作预览,成交后由真实订单线接替。 */
export function usePendingBracketLines({ widget, symbol, account, epoch, orders, brackets, pointValue }: Params) {
  const shapes = useRef(new Map<string, { id: string; price: number; text: string }>());
  const creating = useRef(new Set<string>());
  const generation = useRef(0);
  const desired = useRef(new Map<string, { price: number; text: string; color: string }>());

  useEffect(() => {
    const chart = widget?.activeChart();
    const owned = shapes.current;
    const version = ++generation.current;
    creating.current.clear();
    return () => {
      generation.current = version + 1;
      for (const { id } of owned.values()) {
        try { chart?.removeEntity(id); } catch { /* 图表已销毁 */ }
      }
      owned.clear();
    };
  }, [widget, symbol, account, epoch]);

  useEffect(() => {
    const wanted = new Map<string, { price: number; text: string; color: string }>();
    for (const bracket of brackets) {
      const o = orders.find(o => o.orderId === bracket.entryOrderId && matchesChartInstrument(o, symbol));
      if (!o || !['Limit', 'StopMarket', 'StopLimit'].includes(o.orderType)
        || ['Filled', 'Cancelled', 'Rejected', 'CancelPending', 'CancelSubmitted'].includes(o.state)) continue;
      const qty = o.quantity - o.filled;
      if (qty <= 0) continue;
      const entry = o.orderType === 'Limit' ? o.limitPrice : o.stopPrice;
      const dir = o.action.startsWith('Buy') ? 1 : -1;
      for (const kind of ['tp', 'sl'] as const) {
        const price = bracket[kind];
        if (!(price > 0)) continue;
        const pnl = (price - entry) * dir * pointValue * qty;
        wanted.set(`${o.orderId}:${kind}`, {
          price, color: kind === 'tp' ? '#26a69a' : '#ef5350',
          text: `待成交 ${kind.toUpperCase()} · ${o.orderId.slice(-6)} | ${qty}手 | ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}$`,
        });
      }
    }
    desired.current = wanted;
    if (!widget || !account || !symbol) return;
    const chart = widget.activeChart();
    const remove = (id: string) => { try { chart.removeEntity(id); } catch { /* 已移除 */ } };
    for (const [key, shape] of shapes.current) {
      if (!wanted.has(key)) { remove(shape.id); shapes.current.delete(key); }
    }
    const version = generation.current;
    for (const [key, spec] of wanted) {
      const old = shapes.current.get(key);
      if (old) {
        try {
          const shape = chart.getShapeById(old.id);
          if (old.price !== spec.price) shape.setPoints([{ time: Math.floor(Date.now() / 1000), price: spec.price }]);
          if (old.text !== spec.text) shape.setProperties({ text: spec.text });
          Object.assign(old, spec);
          continue;
        } catch { remove(old.id); shapes.current.delete(key); }
      }
      if (creating.current.has(key)) continue;
      creating.current.add(key);
      void Promise.resolve().then(() => chart.createMultipointShape([{ time: Math.floor(Date.now() / 1000), price: spec.price }], {
        shape: 'horizontal_line', lock: true, disableSelection: true, disableSave: true, disableUndo: true,
        overrides: { linecolor: spec.color, linewidth: 1, linestyle: 2, text: spec.text,
          textcolor: spec.color, fontsize: 12, showLabel: true, showPrice: true, horzLabelsAlign: 'right' },
      })).then(id => {
        if (id == null) return;
        const current = desired.current.get(key);
        if (generation.current !== version || !current || current.price !== spec.price || current.text !== spec.text) remove(id);
        else shapes.current.set(key, { id, price: spec.price, text: spec.text });
      }).catch(() => { /* 下一轮数据更新重试 */ }).finally(() => {
        if (version === generation.current) creating.current.delete(key);
      });
    }
  }, [widget, symbol, account, epoch, orders, brackets, pointValue]);
}
