import { useEffect, useRef } from 'react';
import { nt8Trading, type Nt8Bracket, type Nt8Order, type Nt8Position } from '@/lib/nt8Trading';

/* eslint-disable @typescript-eslint/no-explicit-any */

// NT8 真实枚举名(与桥端 IsWorkingState 保持一致)
const WORKING_STATES = new Set([
  'Working', 'Accepted', 'Submitted', 'PartFilled', 'TriggerPending', 'Suspended',
  'AcceptedByRisk', 'Initialized', 'ChangePending', 'ChangeSubmitted',
  'CancelPending', 'CancelSubmitted',
]);

function roundToTick(price: number, tick: number): number {
  if (!tick || tick <= 0) return Math.round(price * 10000) / 10000;
  const decimals = Math.max(0, Math.ceil(-Math.log10(tick)));
  return Number((Math.round(price / tick) * tick).toFixed(decimals + 1));
}

/** 按 tick 推小数位数(0.25 -> 2 位,0.1 -> 1 位) */
function tickDecimals(tick: number): number {
  if (!tick || tick <= 0) return 2;
  let d = 0;
  while (d < 8 && Math.abs(tick * 10 ** d - Math.round(tick * 10 ** d)) > 1e-9) d++;
  return d;
}

interface LineEntry {
  /** 图表绘图实体 id */
  id: any;
  /** 最近一次应用(同步或拖拽)后的价格 */
  price: number;
  /** 锚点时间(创建时) */
  time: number;
  /** Limit 单拖LimitPrice,其余拖StopPrice */
  orderType?: string;
  /** 上次写入的标签文本,避免轮询期间重复 setProperties 干扰拖拽 */
  lastText?: string;
  /** 上次写入时的主题,主题切换时即使文本不变也要重写文字颜色 */
  theme?: string;
}

/** 拖拽改单结算标记:线已写到落点并提交改单,但轮询的 orders 状态
 *  要等 NT8 确认后才含新价;期间同步效应拿到旧价会把线写回原位,
 *  造成"跳回再跳过来"。订单价追上方解禁,超兜底时间强制解禁 */
interface DragSettle {
  price: number;
  ts: number;
}

interface UseOrderLinesParams {
  widget: TradingViewWidget | null;
  symbol: string;
  account: string;
  orders: Nt8Order[];
  positions: Nt8Position[];
  /** 待触发括号单(entryOrderId -> tp/sl),入场单成交前由桥注册表提供 */
  brackets: Nt8Bracket[];
  tickSize: number;
  /** 每 1.00 点美元价值(括号单金额标注) */
  pointValue: number;
  /** 取当前市价(持仓线浮动盈亏用) */
  getLastPrice: () => number | null;
  /** 订阅最新价变化(tick 驱动,浮盈文本即时刷新);返回退订函数 */
  subscribePrice: (fn: (symbol: string, price: number) => void) => () => void;
  /** 图表主题:决定线条文字颜色(切换时由同步效应重写 textcolor) */
  theme: 'dark' | 'light';
  onChanged: () => void;
}

/**
 * 在图表上维护订单线/持仓线。
 * 注意:本 charting_library 是"纯图表版",createOrderLine/createPositionLine 是
 * 只抛异常的桩函数(Trading Platform 授权才有)。这里用通用绘图 API
 * (createMultipointShape 水平线)实现等价交互:
 * - 工作中订单 -> 水平线(止盈绿虚线/止损红虚线/挂单按买卖着色)。拖线体
 *   (drawing_event 'move')或拖锚点('points_changed')松手后 -> 吸附 tick
 *   并调改单接口;线体拖动库内位移为实际 2 倍,按事件来源补偿(factor)。
 *   用户在图上删除该线(选中后 Delete)触发 'remove' -> 调撤单接口
 * - 程序化同步价格用 setPoints(只触发 points_changed,用价格指纹避免
 *   被误判为用户拖拽)
 * - 当前合约持仓 -> 黄色虚线(锁定不可拖)
 */
export function useOrderLines({
  widget,
  symbol,
  account,
  orders,
  positions,
  brackets,
  tickSize,
  pointValue,
  getLastPrice,
  subscribePrice,
  theme,
  onChanged,
}: UseOrderLinesParams) {
  const linesRef = useRef(new Map<string, LineEntry>());
  const creatingRef = useRef(new Set<string>());
  /** 我们自己主动 removeEntity 的 id,避免 remove 事件误触发撤单 */
  const intentionalRemoveRef = useRef(new Set<string>());
  /** 程序化 setPoints 的价格指纹(entityId -> price):points_changed 事件
   *  借此区分"我们自己的程序化写"(忽略)和"用户拖锚点"(处理) */
  const progWriteRef = useRef(new Map<string, number>());
  /** 拖拽进行中的待处理落点:拖动期间绝不动线,停顿/松手后才吸附改价。
   *  factor:线体拖动('move')库内位移为实际 2 倍,记 2;锚点拖动记 1 */
  const pendingMoveRef = useRef(
    new Map<
      string,
      {
        price: number;
        time: number;
        factor: number;
        ts: number;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  /** 拖拽改单结算标记(orderId -> 落点价):轮询订单价追上方解禁 */
  const settleRef = useRef(new Map<string, DragSettle>());
  const SETTLE_FALLBACK_MS = 2000;
  /** 图上删线撤单的待确认标记(orderId -> 时间戳):订单从轮询列表消失才解禁,
   *  期间禁止同步效应重建线(否则"删掉又出现再消失") */
  const pendingCancelRef = useRef(new Map<string, number>());
  const CANCEL_FALLBACK_MS = 2000;
  const widgetRef = useRef<TradingViewWidget | null>(null);
  widgetRef.current = widget;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  const ctxRef = useRef({ account, tickSize, pointValue, theme });
  ctxRef.current = { account, tickSize, pointValue, theme };
  const ordersRef = useRef(orders);
  ordersRef.current = orders;
  const bracketsRef = useRef(brackets);
  bracketsRef.current = brackets;
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const getLastPriceRef = useRef(getLastPrice);
  getLastPriceRef.current = getLastPrice;

  /** 主题感知的线文字色(浅色图表用深色字,反之亦然) */
  const lineTextColor = () => (ctxRef.current.theme === 'light' ? '#131722' : '#d1d4dc');
  /** 持仓线文字色(与线同色,浅主题下用深黄) */
  const posTextColor = () => (ctxRef.current.theme === 'light' ? '#c89400' : '#f0b90b');

  /** 持仓均价线标签:+2 | +375$(带符号手数 | 浮动盈亏美元,随价格变动) */
  const posLabel = (pos: Nt8Position): string => {
    const q = pos.quantity;
    const qPart = `${q > 0 ? '+' : ''}${q}`;
    const lp = getLastPriceRef.current();
    const pv = ctxRef.current.pointValue;
    if (lp == null || !(pv > 0)) return qPart;
    // pnl =(现价-均价)× 手数(带符号)× 每点价值:多涨正、空跌正
    const pnl = Math.round((lp - pos.averagePrice) * q * pv * 100) / 100;
    return `${qPart} | ${pnl >= 0 ? '+' : ''}${pnl}$`;
  };

  /** 订单线标签:LMT | +3 | TP:+300$/SL:-200$。
   *  price 取线当前价——拖拽进行中用补偿后的实时价调用,实现盈亏数字实时刷新 */
  const buildOrderLabel = (o: Nt8Order, price: number): string => {
    const isBuy = o.action.startsWith('Buy');
    const isTp = o.name.includes('TP');
    const isSl = o.name.includes('SL');
    const remaining = o.quantity - o.filled;
    const pv = ctxRef.current.pointValue;
    const typeShort =
      o.orderType === 'Limit' ? 'LMT'
      : o.orderType === 'StopMarket' ? 'STP'
      : o.orderType === 'StopLimit' ? 'S-LMT'
      : o.orderType === 'Market' ? 'MKT'
      : o.orderType;
    let label = `${typeShort} | ${isBuy ? '+' : '-'}${remaining}`;
    if (isTp || isSl) {
      // 成交后挂出的止盈/止损腿:按持仓均价标注盈亏金额
      const pos = positionsRef.current.find((p) => p.instrument === symbolRef.current);
      if (pos && pos.averagePrice > 0 && pv > 0) {
        const dir = pos.quantity > 0 ? 1 : -1;
        const v = Math.round((price - pos.averagePrice) * dir * pv * remaining * 100) / 100;
        label += ` | ${isTp ? 'TP' : 'SL'}:${v >= 0 ? '+' : ''}${v}$`;
      } else {
        label += isTp ? ' ·止盈' : ' ·止损';
      }
    } else {
      // 装载了止盈/止损的挂单(入场单未成交,括号价来自桥注册表)
      const br = bracketsRef.current.find((b) => b.entryOrderId === o.orderId);
      if (br && (br.tp > 0 || br.sl > 0) && pv > 0) {
        const dir = isBuy ? 1 : -1;
        const parts: string[] = [];
        if (br.tp > 0) {
          const v = Math.round((br.tp - price) * dir * pv * remaining * 100) / 100;
          parts.push(`TP:${v >= 0 ? '+' : ''}${v}$`);
        }
        if (br.sl > 0) {
          const v = Math.round((br.sl - price) * dir * pv * remaining * 100) / 100;
          parts.push(`SL:${v >= 0 ? '+' : ''}${v}$`);
        }
        if (parts.length > 0) label += ` | ${parts.join('/')}`;
      }
    }
    return label;
  };

  // ---- drawing_event 订阅(每个 widget 一次):拖拽改价 + 删线撤单 ----
  useEffect(() => {
    if (!widget) return;

    const findByEntityId = (entityId: string): [string, LineEntry] | null => {
      for (const kv of Array.from(linesRef.current.entries())) {
        if (String(kv[1].id) === entityId) return kv;
      }
      return null;
    };

    const handler = (id: any, type: string) => {
      const entityId = String(id);

      if (type === 'remove') {
        if (intentionalRemoveRef.current.delete(entityId)) return; // 我们自己删的
        const found = findByEntityId(entityId);
        if (!found || found[0] === '__position__') return;
        linesRef.current.delete(found[0]);
        const acc = ctxRef.current.account;
        if (acc) {
          // 撤单确认前的轮询仍含该订单,标记期间禁止同步效应重建线
          pendingCancelRef.current.set(found[0], Date.now());
          nt8Trading
            .cancelOrder(acc, found[0])
            .catch(() => pendingCancelRef.current.delete(found[0]))   // 撤单失败:允许重建
            .finally(() => onChangedRef.current());
        }
        return;
      }

      const readPoint = (entry: LineEntry): { price: number; time: number } | null => {
        try {
          const shape = (widget as any).activeChart().getShapeById(entry.id);
          const pts = shape && shape.getPoints ? shape.getPoints() : [];
          if (pts && pts.length > 0) {
            return { price: pts[0].price, time: pts[0].time ?? entry.time };
          }
        } catch { /* ignore */ }
        return null;
      };

      // 拖动期间绝不能 setPoints(会从外部挪动正在被拖的线,污染库内部拖拽
      // 参考系,误差随距离累积),只记录落点,停顿 350ms 或松手后再吸附改价。
      // 拖拽进行中用补偿后的实时价重建标签文本(只 setProperties 文本,
      // 不动几何),让盈亏数字跟着拖动手势实时刷新
      const updateDragLabel = (orderId: string, rawPrice: number, factor: number) => {
        const entry = linesRef.current.get(orderId);
        if (!entry) return;
        const o = ordersRef.current.find((x) => x.orderId === orderId);
        if (!o) return;
        const corrected = entry.price + (rawPrice - entry.price) / factor;
        const snapped = roundToTick(corrected, ctxRef.current.tickSize);
        const text = buildOrderLabel(o, snapped);
        if (text === entry.lastText) return;
        entry.lastText = text;
        try {
          const shape = (widget as any).activeChart().getShapeById(entry.id);
          if (shape) shape.setProperties({ text });
        } catch { /* ignore */ }
      };

      const notePending = (
        orderId: string,
        price: number,
        time: number,
        source: 'move' | 'points',
      ) => {
        // 线体拖动('move')库里把纵向位移计两次,factor=2;
        // 锚点拖动('points_changed')只动点本身,factor=1。
        // 若线体拖动进行中库附带发了 points_changed(点也在动),沿用 factor=2。
        const now = Date.now();
        const prev = pendingMoveRef.current.get(orderId);
        const factor =
          source === 'move' ? 2 : prev && prev.factor === 2 && now - prev.ts < 1000 ? 2 : 1;
        if (prev) clearTimeout(prev.timer);
        const timer = setTimeout(() => flushMove(orderId), 350);
        pendingMoveRef.current.set(orderId, { price, time, factor, ts: now, timer });
        updateDragLabel(orderId, price, factor);
      };

      if (type === 'move') {
        const found = findByEntityId(entityId);
        if (!found || found[0] === '__position__') return;
        const pt = readPoint(found[1]);
        if (!pt) return;
        notePending(found[0], pt.price, pt.time, 'move');
        return;
      }

      if (type === 'points_changed') {
        const found = findByEntityId(entityId);
        if (!found || found[0] === '__position__') return;
        const pt = readPoint(found[1]);
        if (!pt) return;
        // 程序化 setPoints 也触发 points_changed:按价格指纹忽略自己的写
        const prog = progWriteRef.current.get(entityId);
        if (prog != null && Math.abs(prog - pt.price) < 1e-6) return;
        notePending(found[0], pt.price, pt.time, 'points');
        return;
      }
    };

    /**
     * 拖拽结束:吸附到 tick + 提交改单(防抖 350ms 或 mouseup 触发)。
     * - 线体拖动('move',factor=2):库内部价 = 实际位移 × 2,补偿一半;
     * - 锚点拖动('points_changed',factor=1):直接采用;
     * - 价格几乎没变的拖动(纯横向拖锚点):不改单,锚点弹回原位。
     * 结算后把线吸附到改单价,使"线停在哪 / 改到什么价 / 轴上显示什么价"一致。
     */
    const flushMove = (orderId: string) => {
      const pend = pendingMoveRef.current.get(orderId);
      if (!pend) return;
      pendingMoveRef.current.delete(orderId);
      const entry = linesRef.current.get(orderId);
      if (!entry) return;
      const tick = ctxRef.current.tickSize;
      const eps = tick > 0 ? tick / 4 : 1e-9;
      const delta = pend.price - entry.price;

      // 程序化写线:锚点固定回创建时间(订单线锚点的横向位置无意义),
      // 并记录价格指纹,防止随后的 points_changed 被误判为用户拖拽
      const setLine = (price: number) => {
        try {
          const shape = (widget as any).activeChart().getShapeById(entry.id);
          if (shape) {
            progWriteRef.current.set(String(entry.id), price);
            shape.setPoints([{ time: entry.time, price }]);
          }
        } catch { /* ignore */ }
      };

      // 价格基本没变(纯横向锚点拖动/原地微动):不改单,弹回原位
      if (Math.abs(delta) < eps) {
        if (Math.abs(delta) > 1e-9 || pend.time !== entry.time) setLine(entry.price);
        return;
      }

      const corrected = entry.price + delta / pend.factor;
      const p = roundToTick(corrected, tick);
      try {
        (window as any).__olLog = (window as any).__olLog || [];
        (window as any).__olLog.push({
          kind: 'apply', t: Date.now(), raw: pend.price, factor: pend.factor,
          corrected, snapped: p, entryBefore: entry.price,
        });
      } catch { /* ignore */ }
      // 吸附显示:线停在用户松手时看到的位置
      setLine(p);
      // 标签(止盈/止损金额)也按落点价落定:拖拽中的实时标签基于未吸附价,
      // 且改单确认前轮询拿到旧价时同步效应会跳过文本更新,这里必须落定
      const dragged = ordersRef.current.find((x) => x.orderId === orderId);
      if (dragged) {
        const text = buildOrderLabel(dragged, p);
        if (text !== entry.lastText) {
          entry.lastText = text;
          try {
            const shape = (widget as any).activeChart().getShapeById(entry.id);
            if (shape) shape.setProperties({ text });
          } catch { /* ignore */ }
        }
      }
      // 补偿后与最后应用价一致则无需改单
      if (Math.abs(p - entry.price) < (tick > 0 ? tick / 2 : 1e-9)) return;
      const oldPrice = entry.price;
      entry.price = p;
      const acc = ctxRef.current.account;
      if (!acc) return;
      const field = entry.orderType === 'Limit' ? { limitPrice: p } : { stopPrice: p };
      settleRef.current.set(orderId, { price: p, ts: Date.now() });
      nt8Trading
        .changeOrder(acc, orderId, field)
        .catch(() => {
          // 改单被拒:线弹回原价,等下轮轮询与 NT8 真实状态对齐
          settleRef.current.delete(orderId);
          entry.price = oldPrice;
          entry.lastText = undefined;   // 标签一并失效,下轮轮询按原价重写
          setLine(oldPrice);
        })
        .finally(() => onChangedRef.current());
    };

    // 松手立即结算,不等防抖
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
  }, [widget]);

  // ---- 悬浮带括号单的入场线 -> 显示其待触发止盈/止损位置(锁定虚线预览,平时隐藏) ----
  useEffect(() => {
    if (!widget) return;
    let chart: any = null;
    try { chart = (widget as any).activeChart(); } catch { chart = null; }
    if (!chart || typeof chart.crossHairMoved !== 'function') return;

    const previews = new Map<string, { tpId?: any; slId?: any }>();
    const shownFor = new Map<string, { tp: number; sl: number }>();

    const hidePreview = (orderId: string) => {
      shownFor.delete(orderId);
      const p = previews.get(orderId);
      previews.delete(orderId);
      for (const id of [p?.tpId, p?.slId]) {
        if (id == null) continue;
        intentionalRemoveRef.current.add(String(id));
        try { chart.removeEntity(id); }
        catch { intentionalRemoveRef.current.delete(String(id)); }
      }
    };

    const showPreview = (orderId: string, br: Nt8Bracket, o: Nt8Order | undefined) => {
      const tick = ctxRef.current.tickSize;
      const decimals = tickDecimals(tick);
      const isBuy = o ? o.action.startsWith('Buy') : true;
      const qty = o ? Math.max(1, o.quantity - o.filled) : 1;
      const dir = isBuy ? 1 : -1;
      const entryPx = o ? o.limitPrice || o.stopPrice : 0;
      const pv = ctxRef.current.pointValue > 0 ? ctxRef.current.pointValue : 1;
      const amt = (px: number) =>
        Math.round((px - entryPx) * dir * pv * qty * 100) / 100;
      const nowSec = Math.round(Date.now() / 1000);
      shownFor.set(orderId, { tp: br.tp, sl: br.sl });
      previews.set(orderId, {});

      const mk = async (which: 'tp' | 'sl', px: number, text: string, color: string) => {
        try {
          const id = await chart.createMultipointShape([{ time: nowSec, price: px }], {
            shape: 'horizontal_line',
            lock: true,
            disableSelection: true,
            disableSave: true,
            overrides: {
              linecolor: color,
              linewidth: 1,
              linestyle: 2,
              text,
              showLabel: true,
              textcolor: color,
              fontsize: 12,
              showPrice: true,
              horzLabelsAlign: 'right',
            },
          });
          // 创建返回时鼠标已移开 -> 立即删掉,避免残留
          if (!shownFor.has(orderId)) {
            intentionalRemoveRef.current.add(String(id));
            try { chart.removeEntity(id); }
            catch { intentionalRemoveRef.current.delete(String(id)); }
            return;
          }
          const cur = previews.get(orderId);
          if (cur) cur[which === 'tp' ? 'tpId' : 'slId'] = id;
        } catch { /* 图表未就绪 */ }
      };

      if (br.tp > 0) {
        const v = amt(br.tp);
        void mk('tp', br.tp, `TP ${v >= 0 ? '+' : ''}${v}$ @ ${br.tp.toFixed(decimals)}`, '#26a69a');
      }
      if (br.sl > 0) {
        const v = amt(br.sl);
        void mk('sl', br.sl, `SL ${v >= 0 ? '+' : ''}${v}$ @ ${br.sl.toFixed(decimals)}`, '#ef5350');
      }
    };

    const onCross = (param: any) => {
      const price = param && typeof param.price === 'number' ? param.price : null;
      const tick = ctxRef.current.tickSize;
      const tol = (tick > 0 ? tick : 0.01) * 4;

      // 找"带括号单的入场线"中,离十字光标价格最近且在容差内的那条
      let hovered: string | null = null;
      let best = Infinity;
      if (price != null) {
        for (const kv of Array.from(linesRef.current.entries())) {
          const [orderId, entry] = kv;
          if (orderId.startsWith('__')) continue;
          const br = bracketsRef.current.find((b) => b.entryOrderId === orderId);
          if (!br || (br.tp <= 0 && br.sl <= 0)) continue;
          const d = Math.abs(entry.price - price);
          if (d <= tol && d < best) {
            best = d;
            hovered = orderId;
          }
        }
      }

      for (const orderId of Array.from(shownFor.keys())) {
        if (orderId !== hovered) hidePreview(orderId);
      }
      if (hovered) {
        const br = bracketsRef.current.find((b) => b.entryOrderId === hovered);
        if (br) {
          const cur = shownFor.get(hovered);
          if (!cur || cur.tp !== br.tp || cur.sl !== br.sl) {
            hidePreview(hovered);
            showPreview(hovered, br, ordersRef.current.find((x) => x.orderId === hovered));
          }
        }
      }
    };

    chart.crossHairMoved().subscribe(null, onCross);
    return () => {
      try { chart.crossHairMoved().unsubscribe(null, onCross); } catch { /* ignore */ }
      for (const orderId of Array.from(shownFor.keys())) hidePreview(orderId);
    };
  }, [widget, symbol]);

  // ---- 持仓线浮动盈亏:随最新价 tick 即时刷新文本 ----
  useEffect(() => {
    if (!widget) return;
    const update = () => {
      const entry = linesRef.current.get('__position__');
      if (!entry) return;
      const pos = positionsRef.current.find((p) => p.instrument === symbolRef.current);
      if (!pos) return;
      const label = posLabel(pos);
      if (entry.lastText === label) return;
      entry.lastText = label;
      try {
        const shape = (widget as any).activeChart().getShapeById(entry.id);
        if (shape) shape.setProperties({ text: label });
      } catch { /* ignore */ }
    };
    update();
    return subscribePrice(update);
  }, [widget, subscribePrice]);

  // ---- 订单/持仓 -> 水平线 同步 ----
  useEffect(() => {
    if (!widget || !symbol || !account) return;
    let chart: any = null;
    try { chart = (widget as any).activeChart(); } catch { chart = null; }
    if (!chart) return;

    const lines = linesRef.current;
    const seen = new Set<string>();
    const nowSec = Math.round(Date.now() / 1000);

    const removeLine = (key: string) => {
      const entry = lines.get(key);
      if (!entry) return;
      lines.delete(key);
      settleRef.current.delete(key);
      const eid = String(entry.id);
      intentionalRemoveRef.current.add(eid);
      try { chart.removeEntity(entry.id); }
      catch { intentionalRemoveRef.current.delete(eid); }
    };

    const working = orders.filter(
      (o) => o.instrument === symbol && WORKING_STATES.has(o.state),
    );
    const pos = positions.find((p) => p.instrument === symbol);

    // 撤单确认:订单从轮询列表消失后解禁;超时兜底防永久冻结
    for (const [oid, ts] of Array.from(pendingCancelRef.current)) {
      if (!working.some((o) => o.orderId === oid) || Date.now() - ts > CANCEL_FALLBACK_MS) {
        pendingCancelRef.current.delete(oid);
      }
    }

    // ---- 订单线 ----
    for (const o of working) {
      const key = o.orderId;
      if (pendingCancelRef.current.has(key)) continue;   // 撤单待确认:不重建
      seen.add(key);
      const price = o.limitPrice || o.stopPrice;
      if (!(price > 0)) continue;   // 市价单无价可画
      const isBuy = o.action.startsWith('Buy');
      const isTp = o.name.includes('TP');
      const isSl = o.name.includes('SL');
      const color = isSl ? '#ef5350' : isTp ? '#26a69a' : isBuy ? '#26a69a' : '#ef5350';
      // 标签形式:LMT | +3 | TP:+300$/SL:-200$
      const label = buildOrderLabel(o, price);
      const lineStyle = isTp || isSl ? 2 : 0;

      const existing = lines.get(key);
      if (existing) {
        try {
          const shape = chart.getShapeById(existing.id);
          if (!shape) throw new Error('gone');
          // 拖拽改单后:轮询订单价追上方解禁,期间的旧价快照若写几何
          // 会造成"跳回原位再跳过来"的视觉跳变;拖拽进行中同样不写
          const settle = settleRef.current.get(key);
          if (settle) {
            const epsS = tickSize > 0 ? tickSize / 4 : 1e-9;
            if (
              Math.abs(price - settle.price) < epsS ||
              Date.now() - settle.ts > SETTLE_FALLBACK_MS
            ) {
              settleRef.current.delete(key);
            }
          }
          if (
            Math.abs(existing.price - price) > 1e-9 &&
            !settleRef.current.has(key) &&
            !pendingMoveRef.current.has(key)
          ) {
            // 调试埋点:记录轮询同步
            try {
              (window as any).__olLog = (window as any).__olLog || [];
              (window as any).__olLog.push({
                kind: 'sync', t: Date.now(), key, from: existing.price, to: price,
              });
            } catch { /* ignore */ }
            progWriteRef.current.set(String(existing.id), price);
            shape.setPoints([{ time: existing.time, price }]);
            existing.price = price;
          }
          // 文本或主题变化时写属性:非变更不写;拖拽进行中或改单未确认时
          // 也不写——否则会盖掉拖拽实时标签/造成金额回跳
          if (
            (existing.lastText !== label || existing.theme !== theme) &&
            !settleRef.current.has(key) &&
            !pendingMoveRef.current.has(key)
          ) {
            existing.lastText = label;
            existing.theme = theme;
            shape.setProperties({
              text: label,
              linecolor: color,
              linestyle: lineStyle,
              textcolor: lineTextColor(),
            });
          }
        } catch {
          // 图形失效(用户删线会走 remove 事件撤单;此处为异常兜底,重建)
          lines.delete(key);
        }
        continue;
      }

      if (creatingRef.current.has(key)) continue;   // 防止轮询期间重复创建
      creatingRef.current.add(key);
      void (async () => {
        try {
          const id = await chart.createMultipointShape([{ time: nowSec, price }], {
            shape: 'horizontal_line',
            lock: false,
            disableSelection: false,
            disableSave: true,
            overrides: {
              linecolor: color,
              linewidth: 1,
              linestyle: lineStyle,
              text: label,
              showLabel: true,
              textcolor: lineTextColor(),
              fontsize: 12,
              showPrice: true,
              horzLabelsAlign: 'right',
            },
          });
          lines.set(key, { id, price, time: nowSec, orderType: o.orderType, lastText: label, theme });
        } catch {
          /* 图表未就绪,下轮轮询重试 */
        } finally {
          creatingRef.current.delete(key);
        }
      })();
    }

    // ---- 持仓均价线(锁定不可拖) ----
    if (pos) {
      const pkey = '__position__';
      seen.add(pkey);
      const plabel = posLabel(pos);
      const existing = lines.get(pkey);
      if (existing) {
        try {
          const shape = chart.getShapeById(existing.id);
          if (!shape) throw new Error('gone');
          if (Math.abs(existing.price - pos.averagePrice) > 1e-9) {
            progWriteRef.current.set(String(existing.id), pos.averagePrice);
            shape.setPoints([{ time: existing.time, price: pos.averagePrice }]);
            existing.price = pos.averagePrice;
          }
          if (existing.lastText !== plabel || existing.theme !== theme) {
            existing.lastText = plabel;
            existing.theme = theme;
            shape.setProperties({ text: plabel, textcolor: posTextColor() });
          }
        } catch {
          lines.delete(pkey);
        }
      } else if (!creatingRef.current.has(pkey)) {
        creatingRef.current.add(pkey);
        void (async () => {
          try {
            const id = await chart.createMultipointShape([{ time: nowSec, price: pos.averagePrice }], {
              shape: 'horizontal_line',
              lock: true,
              disableSelection: true,
              disableSave: true,
              overrides: {
                linecolor: '#f0b90b',
                linewidth: 1,
                linestyle: 2,
                text: plabel,
                showLabel: true,
                textcolor: posTextColor(),
                fontsize: 12,
                showPrice: true,
                horzLabelsAlign: 'right',
              },
            });
            lines.set(pkey, { id, price: pos.averagePrice, time: nowSec, lastText: plabel, theme });
          } catch {
            /* 下轮重试 */
          } finally {
            creatingRef.current.delete(pkey);
          }
        })();
      }
    }

    // ---- 清理已消失的线条(订单终结/撤单/切换合约) ----
    for (const key of Array.from(lines.keys())) {
      if (!seen.has(key)) removeLine(key);
    }
  }, [widget, symbol, account, orders, positions, brackets, tickSize, pointValue, theme]);

  // 组件卸载时清理所有线条
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
