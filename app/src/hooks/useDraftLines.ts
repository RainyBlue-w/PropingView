import { useEffect, useRef } from 'react';
import {
  amountToPrice,
  priceToAmount,
  roundToTick,
  tickDecimals,
  type DraftSide,
} from '@/lib/draftCalc';

/* eslint-disable @typescript-eslint/no-explicit-any */

export type DraftWhich = 'tp' | 'sl' | 'entry';

interface DraftEntry {
  /** 图表绘图实体 id */
  id: any;
  /** 最近一次应用(同步或拖拽)后的价格 */
  price: number;
  /** 锚点时间(创建时) */
  time: number;
  /** 上次写入的标签文本,避免轮询期间重复 setProperties 干扰拖拽 */
  lastText?: string;
  /** 上次写入时的主题,主题切换时即使文本不变也要重写文字颜色 */
  theme?: string;
}

interface PendingMove {
  price: number;
  time: number;
  /** 位移补偿系数:线体拖动('move')库内位移 ×2,锚点拖动 ×1 */
  factor: number;
  ts: number;
  /** 本次拖拽开始时的线价(补偿与跟随的基准) */
  start: number;
  /** 入场线拖拽开始时的止盈/止损线价(用于实时跟随) */
  tp0: number | null;
  sl0: number | null;
  timer: ReturnType<typeof setTimeout>;
}

interface SettleMark {
  /** 结算落点价 */
  price: number;
  /** 止盈/止损:期望面板出现的金额字符串;入场线为 null(改比 entryPrice) */
  amount: string | null;
  ts: number;
}

interface UseDraftLinesParams {
  widget: TradingViewWidget | null;
  symbol: string;
  /** 是否草稿模式(交易模式下不画草稿线) */
  active: boolean;
  side: DraftSide;
  /** 基准价:MKT = 冻结最新价;LMT/STP = 入场价 */
  refPrice: number | null;
  /** 是否画入场虚线(草稿 + LMT/STP) */
  showEntry: boolean;
  /** 入场价(面板输入) */
  entryPrice: number | null;
  qty: number;
  tickSize: number;
  /** 每 1.00 点美元价值 */
  pointValue: number;
  /** 止盈/止损金额(美元)字符串,空 = 不画该线 */
  tpAmount: string;
  slAmount: string;
  /** 拖止盈/止损线或图上删线后回填金额;空串表示清除 */
  onAmount: (which: 'tp' | 'sl', amount: string) => void;
  /** 拖入场线后回填入场价;0/无效表示清除 */
  onEntryChange: (price: number) => void;
  /** 图表主题:决定虚线文字颜色 */
  theme: 'dark' | 'light';
}

/**
 * 草稿模式预览虚线(入场/止盈/止损):
 * - 面板输入(金额/手数/入场价/基准价)变化 -> 换算成价格,setPoints 移线(实时)
 * - 拖止盈/止损线 -> 反算金额回填面板;拖入场线 -> 回填入场价,
 *   且拖动过程中止盈/止损线实时跟随(保持金额不变)
 * - 拖拽事件模型与订单线一致:线体 'move' 库内位移 ×2 需补偿,
 *   锚点 'points_changed' ×1,程序化 setPoints 用价格指纹防回环
 * - 图上删除虚线(选中后 Delete)-> 清空对应金额/入场价
 */
export function useDraftLines({
  widget,
  symbol,
  active,
  side,
  refPrice,
  showEntry,
  entryPrice,
  qty,
  tickSize,
  pointValue,
  tpAmount,
  slAmount,
  onAmount,
  onEntryChange,
  theme,
}: UseDraftLinesParams) {
  const linesRef = useRef(new Map<DraftWhich, DraftEntry>());
  const creatingRef = useRef(new Set<DraftWhich>());
  /** 我们自己主动 removeEntity 的 id,避免 remove 事件误清空面板 */
  const intentionalRemoveRef = useRef(new Set<string>());
  /** 程序化 setPoints 的价格指纹(entityId -> price) */
  const progWriteRef = useRef(new Map<string, number>());
  const pendingMoveRef = useRef(new Map<DraftWhich, PendingMove>());
  /** 拖拽结算标记:flushMove 已把线写到落点,但面板状态(金额/入场价)
   *  要等下一次 React 渲染才生效;期间同步效应若用旧状态算目标价,
   *  会把线写回原位造成"跳回再跳过来"。面板值追上方解禁;
   *  超过兜底时间仍未追上(如回填被拦截)也解禁,避免永久冻结 */
  const settleRef = useRef(new Map<DraftWhich, SettleMark>());
  const SETTLE_FALLBACK_MS = 2000;
  /** 图上删线后的待清空标记:面板状态(金额/入场价)追上前禁止重建线,
   *  否则同步效应用旧状态把刚删的线重建,出现"删掉又出现再消失" */
  const pendingRemoveRef = useRef(new Map<DraftWhich, number>());
  const REMOVE_FALLBACK_MS = 2000;
  const widgetRef = useRef<TradingViewWidget | null>(null);
  widgetRef.current = widget;
  const onAmountRef = useRef(onAmount);
  onAmountRef.current = onAmount;
  const onEntryChangeRef = useRef(onEntryChange);
  onEntryChangeRef.current = onEntryChange;
  const ctxRef = useRef({ side, refPrice, qty, tickSize, pointValue });
  ctxRef.current = { side, refPrice, qty, tickSize, pointValue };
  /** 上次同步时的合约,用于合约切换时清线 */
  const prevSymbolRef = useRef('');

  // ---- drawing_event 订阅:拖拽回填 + 删线清空 ----
  useEffect(() => {
    if (!widget) return;

    const findByEntityId = (entityId: string): [DraftWhich, DraftEntry] | null => {
      for (const kv of Array.from(linesRef.current.entries())) {
        if (String(kv[1].id) === entityId) return kv;
      }
      return null;
    };

    /** 程序化写线(带价格指纹防回环;锚点固定在创建时间) */
    const writeLine = (entry: DraftEntry, price: number) => {
      try {
        const shape = (widget as any).activeChart().getShapeById(entry.id);
        if (shape) {
          progWriteRef.current.set(String(entry.id), price);
          shape.setPoints([{ time: entry.time, price }]);
        }
      } catch { /* ignore */ }
    };

    /** 拖拽结束:补偿位移 -> 吸附 tick -> 回填面板 */
    const flushMove = (which: DraftWhich) => {
      const pend = pendingMoveRef.current.get(which);
      if (!pend) return;
      pendingMoveRef.current.delete(which);
      const entry = linesRef.current.get(which);
      if (!entry) return;
      const { tickSize: tick, side: s, refPrice: ref, qty: q, pointValue: pv } = ctxRef.current;
      const eps = tick > 0 ? tick / 4 : 1e-9;
      const delta = pend.price - pend.start;

      // 价格基本没变(纯横向锚点拖动/微动):弹回原位
      if (Math.abs(delta) < eps) {
        if (Math.abs(delta) > 1e-9 || pend.time !== entry.time) writeLine(entry, entry.price);
        return;
      }

      const corrected = pend.start + delta / pend.factor;
      const p = roundToTick(corrected, tick);
      writeLine(entry, p);
      entry.price = p;

      // 入场线:回填入场价;止盈/止损由同步效应按金额重新定位(与拖动着跟随一致)
      if (which === 'entry') {
        settleRef.current.set('entry', { price: p, amount: null, ts: Date.now() });
        onEntryChangeRef.current(p);
        return;
      }

      // 止盈/止损线:反算金额回填;拖到错误方向(金额为 0)则清掉该线
      if (ref == null || ref <= 0) return;
      const amount = priceToAmount(s, which === 'tp', p, ref, pv, q);
      const amountStr = amount > 0 ? String(amount) : '';
      settleRef.current.set(which, { price: p, amount: amountStr, ts: Date.now() });
      onAmountRef.current(which, amountStr);
    };

    const handler = (id: any, type: string) => {
      const entityId = String(id);

      if (type === 'remove') {
        if (intentionalRemoveRef.current.delete(entityId)) return; // 我们自己删的
        const found = findByEntityId(entityId);
        if (!found) return;
        const [which] = found;
        linesRef.current.delete(which);
        // 面板状态追上前禁止同步效应重建该线
        pendingRemoveRef.current.set(which, Date.now());
        if (which === 'entry') onEntryChangeRef.current(0);
        else onAmountRef.current(which, '');
        return;
      }

      if (type !== 'move' && type !== 'points_changed') return;
      const found = findByEntityId(entityId);
      if (!found) return;
      const [which, entry] = found;

      let pt: { price: number; time: number } | null = null;
      try {
        const shape = (widget as any).activeChart().getShapeById(entry.id);
        const pts = shape && shape.getPoints ? shape.getPoints() : [];
        if (pts && pts.length > 0) pt = { price: pts[0].price, time: pts[0].time ?? entry.time };
      } catch { return; }
      if (!pt) return;

      // 程序化 setPoints 的回环:按价格指纹忽略
      if (type === 'points_changed') {
        const prog = progWriteRef.current.get(entityId);
        if (prog != null && Math.abs(prog - pt.price) < 1e-6) return;
      }

      // 拖动期间绝不动"被拖的线",只记录落点,停顿 350ms 或松手后结算
      const now = Date.now();
      const prev = pendingMoveRef.current.get(which);
      const factor =
        type === 'move' ? 2 : prev && prev.factor === 2 && now - prev.ts < 1000 ? 2 : 1;
      if (prev) clearTimeout(prev.timer);
      const start = prev ? prev.start : entry.price;
      const tp0 = prev ? prev.tp0 : linesRef.current.get('tp')?.price ?? null;
      const sl0 = prev ? prev.sl0 : linesRef.current.get('sl')?.price ?? null;
      const timer = setTimeout(() => flushMove(which), 350);
      pendingMoveRef.current.set(which, {
        price: pt.price, time: pt.time, factor, ts: now, start, tp0, sl0, timer,
      });

      const corrected = start + (pt.price - start) / factor;

      // 拖拽进行中实时刷新被拖线的标签数字(只写文本,不动几何):
      // 入场线显示实时价;止盈/止损线显示实时反算金额
      {
        const { tickSize: tick, side: s, refPrice: ref, qty: q, pointValue: pv } = ctxRef.current;
        const snapped = roundToTick(corrected, tick);
        let text: string | null = null;
        if (which === 'entry') {
          text = `草稿入场 @ ${snapped.toFixed(tickDecimals(tick))}`;
        } else if (ref != null && ref > 0) {
          const amt = priceToAmount(s, which === 'tp', snapped, ref, pv, q);
          text = `草稿${which === 'tp' ? '止盈' : '止损'} $${amt} · ${q}手`;
        }
        if (text != null && entry.lastText !== text) {
          entry.lastText = text;
          try {
            const shape = (widget as any).activeChart().getShapeById(entry.id);
            if (shape) shape.setProperties({ text });
          } catch { /* ignore */ }
        }
      }

      // 入场线拖动中:止盈/止损线实时跟随(保持金额不变)。
      // 移动的是"别的"线,不会污染正在被拖的入场线的参考系。
      if (which === 'entry') {
        const delta = corrected - start;
        for (const [fk, f0] of [['tp', tp0], ['sl', sl0]] as const) {
          if (f0 == null) continue;
          const fe = linesRef.current.get(fk);
          if (!fe) continue;
          fe.price = f0 + delta;
          writeLine(fe, fe.price);
        }
      }
    };

    const onMouseUp = () => {
      for (const key of Array.from(pendingMoveRef.current.keys())) {
        const pend = pendingMoveRef.current.get(key);
        if (pend) clearTimeout(pend.timer);
        flushMove(key);
      }
    };
    window.addEventListener('mouseup', onMouseUp, true);

    (widget as any).subscribe('drawing_event', handler);
    return () => {
      try { (widget as any).unsubscribe('drawing_event', handler); } catch { /* ignore */ }
      window.removeEventListener('mouseup', onMouseUp, true);
      for (const pend of Array.from(pendingMoveRef.current.values())) clearTimeout(pend.timer);
      pendingMoveRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widget]);

  // ---- 面板输入 -> 虚线位置 同步 ----
  useEffect(() => {
    if (!widget || !symbol) return;
    let chart: any = null;
    try { chart = (widget as any).activeChart(); } catch { chart = null; }
    if (!chart) return;

    const lines = linesRef.current;
    const nowSec = Math.round(Date.now() / 1000);
    const decimals = tickDecimals(tickSize);

    const removeLine = (which: DraftWhich) => {
      const entry = lines.get(which);
      if (!entry) return;
      lines.delete(which);
      settleRef.current.delete(which);
      const eid = String(entry.id);
      intentionalRemoveRef.current.add(eid);
      try { chart.removeEntity(entry.id); }
      catch { intentionalRemoveRef.current.delete(eid); }
    };

    // 切换合约:旧合约的草稿线全部清掉(同一 chart 对象上图形可能残留)
    if (prevSymbolRef.current !== symbol) {
      prevSymbolRef.current = symbol;
      removeLine('tp');
      removeLine('sl');
      removeLine('entry');
    }

    // 退出草稿模式:清掉所有草稿线
    if (!active) {
      removeLine('tp');
      removeLine('sl');
      removeLine('entry');
      return;
    }

    // 主题感知的虚线文字色
    const textColor = theme === 'light' ? '#131722' : '#d1d4dc';
    const upsert = (which: DraftWhich, target: number, label: string, color: string) => {
      // 删线待清空:面板状态(金额/入场价)追上前不重建;超时兜底
      const rmTs = pendingRemoveRef.current.get(which);
      if (rmTs != null) {
        const cleared =
          which === 'entry'
            ? !(entryPrice != null && entryPrice > 0)
            : !(parseFloat(which === 'tp' ? tpAmount : slAmount) > 0);
        if (cleared || Date.now() - rmTs > REMOVE_FALLBACK_MS) {
          pendingRemoveRef.current.delete(which);
        } else {
          return;
        }
      }
      const existing = lines.get(which);
      if (existing) {
        try {
          const shape = chart.getShapeById(existing.id);
          if (!shape) throw new Error('gone');
          // 拖拽进行中不写几何:MKT 草稿线跟随市价的刷新会让位于用户手势。
          // 拖拽结算后:面板状态(金额/入场价)追上方解禁,期间同步算出的
          // 目标价基于旧状态,写几何会造成"跳回原位再跳过来"的视觉跳变
          const settle = settleRef.current.get(which);
          if (settle) {
            const eps = tickSize > 0 ? tickSize / 4 : 1e-9;
            const caughtUp =
              which === 'entry'
                ? entryPrice != null && Math.abs(entryPrice - settle.price) < eps
                : settle.amount != null &&
                  (which === 'tp' ? tpAmount : slAmount).trim() === settle.amount;
            if (caughtUp || Date.now() - settle.ts > SETTLE_FALLBACK_MS) {
              settleRef.current.delete(which);
            }
          }
          if (
            Math.abs(existing.price - target) > 1e-9 &&
            !pendingMoveRef.current.has(which) &&
            !settleRef.current.has(which)
          ) {
            progWriteRef.current.set(String(existing.id), target);
            shape.setPoints([{ time: existing.time, price: target }]);
            existing.price = target;
          }
          // 文本同样受守卫:拖拽实时标签/结算标签不能被旧状态的轮询写回
          if (
            (existing.lastText !== label || existing.theme !== theme) &&
            !settleRef.current.has(which) &&
            !pendingMoveRef.current.has(which)
          ) {
            existing.lastText = label;
            existing.theme = theme;
            shape.setProperties({ text: label, linecolor: color, textcolor: textColor });
          }
        } catch {
          lines.delete(which);
        }
        return;
      }
      if (creatingRef.current.has(which)) return;
      creatingRef.current.add(which);
      void (async () => {
        try {
          const id = await chart.createMultipointShape([{ time: nowSec, price: target }], {
            shape: 'horizontal_line',
            lock: false,
            disableSelection: false,
            disableSave: true,
            overrides: {
              linecolor: color,
              linewidth: 1,
              linestyle: 2,
              text: label,
              showLabel: true,
              textcolor: textColor,
              fontsize: 12,
              showPrice: true,
              horzLabelsAlign: 'right',
            },
          });
          lines.set(which, { id, price: target, time: nowSec, lastText: label, theme });
        } catch {
          /* 图表未就绪,下次状态变化重试 */
        } finally {
          creatingRef.current.delete(which);
        }
      })();
    };

    // 入场线(仅 LMT/STP)
    if (showEntry && entryPrice != null && entryPrice > 0) {
      upsert('entry', entryPrice, `草稿入场 @ ${entryPrice.toFixed(decimals)}`, '#2962ff');
    } else {
      removeLine('entry');
    }

    // 止盈/止损线(金额 -> 价格)
    const specs: Array<{ which: 'tp' | 'sl'; amountStr: string; isTp: boolean; color: string }> = [
      { which: 'tp', amountStr: tpAmount, isTp: true, color: '#26a69a' },
      { which: 'sl', amountStr: slAmount, isTp: false, color: '#ef5350' },
    ];
    for (const spec of specs) {
      const amount = parseFloat(spec.amountStr);
      const target =
        refPrice != null && refPrice > 0 && amount > 0
          ? amountToPrice(side, spec.isTp, amount, refPrice, tickSize, pointValue, qty)
          : null;
      if (target == null) {
        removeLine(spec.which);
        continue;
      }
      upsert(spec.which, target, `草稿${spec.isTp ? '止盈' : '止损'} $${amount} · ${qty}手`, spec.color);
    }
  }, [widget, symbol, active, side, refPrice, showEntry, entryPrice, qty, tickSize, pointValue, tpAmount, slAmount, theme]);

  // 组件卸载时清理
  useEffect(() => {
    const lines = linesRef.current;
    const intentional = intentionalRemoveRef.current;
    return () => {
      const w = widgetRef.current as any;
      let chart: any = null;
      try { chart = w && w.activeChart(); } catch { chart = null; }
      if (!chart) return;
      for (const entry of lines.values()) {
        intentional.add(String(entry.id));
        try { chart.removeEntity(entry.id); } catch { /* ignore */ }
      }
      lines.clear();
    };
  }, []);
}
