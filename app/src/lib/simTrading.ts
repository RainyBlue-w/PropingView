import type { Bar } from '@/types/market';
import type {
  Nt8Account,
  Nt8Bracket,
  Nt8Execution,
  Nt8Order,
  Nt8Position,
  PlaceOrderPayload,
  ExecutionPage,
} from './nt8Trading';

/** 回放模拟账户名(固定;回放期间账户列表只含它) */
export const SIM_ACCOUNT = 'SIM-REPLAY';

export interface SimDeps {
  /** 回放游标处的最新价(= 最近揭示 bar 的收盘价,来自 TvDatafeed) */
  getLastPrice: (symbol: string) => number | null;
  /** 每 1.00 点美元价值(盈亏结算用) */
  pointValueOf: (symbol: string) => number;
  /** 回放游标时间(unix 秒),即时成交的成交时间用 */
  getCursorTime: () => number;
  /** 一次完整下单/撤改/平仓/行情撮合完成后通知,供会话立即保存快照。 */
  onChange?: () => void;
}

/** 内部订单:NT8 形状 + 入场单附带的止盈/止损价(成交后挂 OCO 子单) */
export interface SimOrder extends Nt8Order {
  tpPrice?: number;
  slPrice?: number;
  tpAmount?: number;
  slAmount?: number;
}

/** 会话快照只含可序列化的值；包含未成交订单的附加保护参数。 */
export interface SimTradingState {
  version: 1;
  initialEquity: number;
  positions: Nt8Position[];
  orders: SimOrder[];
  executions: (Nt8Execution & { instrument: string })[];
  realized: number;
  orderSeq: number;
  ocoSeq: number;
}

export function isSimTradingState(value: unknown): value is SimTradingState {
  if (!value || typeof value !== 'object') return false;
  const state = value as SimTradingState;
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  const positive = (n: unknown): n is number => finite(n) && n > 0;
  const text = (s: unknown): s is string => typeof s === 'string' && s.length > 0;
  const record = (o: unknown): o is Record<string, unknown> => !!o && typeof o === 'object';
  return state.version === 1 && positive(state.initialEquity) && finite(state.realized)
    && Number.isSafeInteger(state.orderSeq) && state.orderSeq >= 0
    && Number.isSafeInteger(state.ocoSeq) && state.ocoSeq >= 0
    && Array.isArray(state.positions) && state.positions.every(p => record(p)
      && text(p.instrument) && Number.isSafeInteger(p.quantity) && finite(p.averagePrice)
      && typeof p.marketPosition === 'string')
    && Array.isArray(state.orders) && state.orders.every(o => record(o)
      && text(o.orderId) && text(o.instrument) && ['Buy', 'Sell'].includes(o.action)
      && ['Market', 'Limit', 'StopMarket', 'StopLimit'].includes(o.orderType)
      && Number.isSafeInteger(o.quantity) && o.quantity > 0 && Number.isSafeInteger(o.filled)
      && o.filled >= 0 && o.filled <= o.quantity && finite(o.limitPrice) && finite(o.stopPrice)
      && finite(o.averageFillPrice) && finite(o.time) && typeof o.oco === 'string'
      && typeof o.name === 'string' && typeof o.state === 'string'
      && [o.tpPrice, o.slPrice, o.tpAmount, o.slAmount].every(n => n === undefined || finite(n)))
    && Array.isArray(state.executions) && state.executions.every(e => record(e)
      && text(e.instrument) && text(e.orderId) && text(e.executionId) && finite(e.time)
      && finite(e.price) && Number.isSafeInteger(e.qty) && e.qty > 0
      && ['Buy', 'Sell'].includes(e.side)
      && (e.commission === undefined || finite(e.commission))
      && (e.pointValue === undefined || positive(e.pointValue))
      && (e.timeMs === undefined || finite(e.timeMs))
      && (e.sequence === undefined || (Number.isSafeInteger(e.sequence) && e.sequence > 0)))
    && new Set(state.positions.map(p => p.instrument)).size === state.positions.length
    && new Set(state.orders.map(o => o.orderId)).size === state.orders.length
    && new Set(state.executions.map(e => e.executionId)).size === state.executions.length;
}

const ORDER_TYPE_TO_NT8: Record<PlaceOrderPayload['orderType'], string> = {
  MARKET: 'Market',
  LIMIT: 'Limit',
  STOPMARKET: 'StopMarket',
  STOPLIMIT: 'StopLimit',
};

/**
 * 回放模拟撮合引擎:方法与 nt8Trading 同名同形状,全部本地结算。
 * 撮合粒度 = 图表当前周期 bar 的 OHLC(不模拟 bar 内路径):
 * - 限价单:bar 低/高价触及即成交;跳空开穿按更优的开盘价成交;
 * - 止损(StopMarket):触发后按 stop 与开盘价的更差者成交(保守);
 * - StopLimit:触发后转为限价单;
 * - 市价单、挂牌瞬间就已可成交的限价/止损单:按当前最新价立即成交。
 */
export class SimTrading {
  private positions = new Map<string, Nt8Position>();
  private working: SimOrder[] = [];
  private executions: (Nt8Execution & { instrument: string })[] = [];
  private realized = 0;
  private orderSeq = 0;
  private ocoSeq = 0;
  private readonly startEquity: number;
  private deps: SimDeps;

  constructor(deps: SimDeps, options: { initialEquity?: number; state?: SimTradingState } = {}) {
    this.deps = deps;
    if (options.state && !isSimTradingState(options.state)) throw new Error('回放会话快照损坏,无法恢复');
    const state = options.state;
    this.startEquity = state?.initialEquity ?? options.initialEquity ?? 100000;
    if (!Number.isFinite(this.startEquity) || this.startEquity <= 0) throw new Error('初始资金必须大于零');
    if (state) {
      this.positions = new Map(state.positions.map(p => [p.instrument, { ...p }]));
      this.working = state.orders.map(o => ({ ...o }));
      this.executions = state.executions.map((e, index) => ({ ...e,
        timeMs: e.timeMs ?? e.time * 1000, sequence: e.sequence ?? index + 1 }));
      this.realized = state.realized;
      this.orderSeq = state.orderSeq;
      this.ocoSeq = state.ocoSeq;
    }
  }

  exportState(): SimTradingState {
    return {
      version: 1,
      initialEquity: this.startEquity,
      positions: [...this.positions.values()].map(p => ({ ...p })),
      orders: this.working.map(o => ({ ...o })),
      executions: this.executions.map(e => ({ ...e })),
      realized: this.realized,
      orderSeq: this.orderSeq,
      ocoSeq: this.ocoSeq,
    };
  }

  async getAccounts(): Promise<{ accounts: Nt8Account[] }> {
    let unreal = 0;
    for (const p of this.positions.values()) {
      const last = this.deps.getLastPrice(p.instrument);
      if (p.quantity !== 0 && last != null) {
        unreal += (last - p.averagePrice) * p.quantity * this.deps.pointValueOf(p.instrument);
      }
    }
    const equity = this.startEquity + this.realized + unreal;
    return {
      accounts: [
        {
          name: SIM_ACCOUNT,
          currency: 'USD',
          cashValue: this.startEquity + this.realized,
          netLiquidation: equity,
          realizedPnl: Math.round(this.realized * 100) / 100,
          unrealizedPnl: Math.round(unreal * 100) / 100,
        },
      ],
    };
  }

  async getPositions(): Promise<{ positions: Nt8Position[] }> {
    return { positions: [...this.positions.values()].filter((p) => p.quantity !== 0) };
  }

  async getOrders(): Promise<{ orders: Nt8Order[] }> {
    return { orders: this.working.map((o) => ({ ...o })) };
  }

  async getBrackets(): Promise<{ brackets: Nt8Bracket[] }> {
    return { brackets: this.working.filter(o => o.tpPrice || o.slPrice).map(o => ({
      entryOrderId: o.orderId, instrument: o.instrument, tp: o.tpPrice ?? 0, sl: o.slPrice ?? 0,
    })) };
  }

  async getExecutionPage(_account: string, symbol: string, from: number, to: number, offset = 0, limit = 100): Promise<ExecutionPage> {
    const rows = this.executions.filter(e => (!symbol || e.instrument === symbol) && e.time >= from && e.time <= to)
      .slice().reverse().sort((a, b) => b.time - a.time);
    const pageSize = Math.max(1, Math.min(1000, Math.floor(limit) || 100));
    return { executions: rows.slice(offset, offset + pageSize).map(e => ({ ...e })), total: rows.length,
      nextOffset: offset + pageSize < rows.length ? offset + pageSize : null };
  }

  // 注意:刻意忽略 from/to —— 回放成交落在历史游标处,可能早于
  // useExecutionTrades 的近 7 天拉取窗口;模拟成交数量小,全量返回由前端上图
  async getExecutions(
    _account: string,
    symbol: string,
  ): Promise<{ executions: Nt8Execution[] }> {
    return {
      executions: this.executions
        .filter((e) => e.instrument === symbol)
        .map((e) => ({ ...e })),
    };
  }

  async placeOrder(payload: PlaceOrderPayload): Promise<{ ok: boolean; orderId: string }> {
    if (!(payload.quantity > 0) || !Number.isInteger(payload.quantity)) throw new Error('手数必须为正整数');
    const o: SimOrder = {
      orderId: `SIM-${Date.now()}-${++this.orderSeq}`,
      instrument: payload.symbol,
      action: payload.action === 'BUY' ? 'Buy' : 'Sell',
      orderType: ORDER_TYPE_TO_NT8[payload.orderType] ?? payload.orderType,
      quantity: payload.quantity,
      filled: 0,
      limitPrice: payload.limitPrice ?? 0,
      stopPrice: payload.stopPrice ?? 0,
      averageFillPrice: 0,
      state: 'Working',
      oco: '',
      name: '',
      time: this.deps.getCursorTime(),
      tpPrice: payload.tp,
      slPrice: payload.sl,
      tpAmount: payload.tpAmount,
      slAmount: payload.slAmount,
    };
    if (o.orderType === 'Market') {
      const last = this.deps.getLastPrice(o.instrument);
      if (last == null) throw new Error('回放尚无最新价,无法市价成交');
      this.fill(o, last, o.time);
      this.deps.onChange?.();
      return { ok: true, orderId: o.orderId };
    }
    // 挂牌瞬间按市场价就已可成交的,按最新价立即成交(与真实撮合一致)
    if (this.tryImmediateFill(o)) {
      this.deps.onChange?.();
      return { ok: true, orderId: o.orderId };
    }
    this.working.push(o);
    this.deps.onChange?.();
    return { ok: true, orderId: o.orderId };
  }

  async cancelOrder(_account: string, orderId: string): Promise<{ ok: boolean }> {
    const target = this.working.find((o) => o.orderId === orderId);
    this.working = this.working.filter((o) => o.orderId !== orderId);
    // OCO 关联单一并撤掉(与 NT8 的 OCO 行为一致)
    if (target?.oco) this.working = this.working.filter((o) => o.oco !== target.oco);
    this.deps.onChange?.();
    return { ok: true };
  }

  async changeOrder(
    _account: string,
    orderId: string,
    price: { limitPrice?: number; stopPrice?: number },
  ): Promise<{ ok: boolean }> {
    const o = this.working.find((x) => x.orderId === orderId);
    if (!o) throw new Error('订单不存在或已成交');
    if (price.limitPrice !== undefined) o.limitPrice = price.limitPrice;
    if (price.stopPrice !== undefined) o.stopPrice = price.stopPrice;
    // 改到已穿越的价位 → 按最新价立即成交(与真实撮合一致)
    this.tryImmediateFill(o);
    this.deps.onChange?.();
    return { ok: true };
  }

  async closePosition(_account: string, symbol: string): Promise<{ ok: boolean }> {
    const pos = this.positions.get(symbol);
    if (!pos || pos.quantity === 0) return { ok: true };
    const last = this.deps.getLastPrice(symbol);
    if (last == null) throw new Error('回放尚无最新价,无法平仓');
    const t = this.deps.getCursorTime();
    this.fill(
      {
        orderId: `SIM-${Date.now()}-${++this.orderSeq}`,
        instrument: symbol,
        action: pos.quantity < 0 ? 'Buy' : 'Sell',
        orderType: 'Market',
        quantity: Math.abs(pos.quantity),
        filled: 0,
        limitPrice: 0,
        stopPrice: 0,
        averageFillPrice: 0,
        state: 'Working',
        oco: '',
        name: '',
        time: t,
      },
      last,
      t,
    );
    // 平仓同时撤掉该合约剩余工作单(OCO 止盈止损等)
    this.working = this.working.filter((o) => o.instrument !== symbol);
    this.deps.onChange?.();
    return { ok: true };
  }

  /** 每根新揭示 bar 驱动工作单撮合(由回放会话 onBarRevealed 回调) */
  onBar(symbol: string, bar: Bar): void {
    for (const o of [...this.working]) {
      if (o.instrument !== symbol) continue;
      // 前一腿成交可能已撤掉 OCO 另一腿,遍历快照时必须再次确认仍在工作。
      if (!this.working.includes(o)) continue;
      const isBuy = o.action === 'Buy';
      if (o.orderType === 'Limit') {
        const px = o.limitPrice;
        if (isBuy ? bar.low <= px : bar.high >= px) {
          this.fill(o, isBuy ? Math.min(bar.open, px) : Math.max(bar.open, px), bar.time);
        }
      } else if (o.orderType === 'StopMarket' || o.orderType === 'StopLimit') {
        const px = o.stopPrice;
        const triggered = isBuy ? bar.high >= px : bar.low <= px;
        if (!triggered) continue;
        if (o.orderType === 'StopMarket') {
          this.fill(o, isBuy ? Math.max(bar.open, px) : Math.min(bar.open, px), bar.time);
        } else {
          // StopLimit:触发后转限价(同根 bar 内允许继续按限价成交)
          o.orderType = 'Limit';
          const lp = o.limitPrice;
          if (isBuy ? bar.low <= lp : bar.high >= lp) {
            this.fill(o, isBuy ? Math.min(bar.open, lp) : Math.max(bar.open, lp), bar.time);
          }
        }
      }
    }
    this.deps.onChange?.();
  }

  /** 挂牌/改单瞬间的"按市场价已可成交"检查;命中则按最新价成交并返回 true */
  private tryImmediateFill(o: SimOrder): boolean {
    const last = this.deps.getLastPrice(o.instrument);
    if (last == null) return false;
    const isBuy = o.action === 'Buy';
    if (o.orderType === 'Limit' && (isBuy ? o.limitPrice >= last : o.limitPrice <= last)) {
      this.fill(o, last, this.deps.getCursorTime());
      return true;
    }
    if (o.orderType === 'StopMarket' && (isBuy ? o.stopPrice <= last : o.stopPrice >= last)) {
      this.fill(o, last, this.deps.getCursorTime());
      return true;
    }
    return false;
  }

  /** 成交:出工作单、算持仓与盈亏、记成交流水;入场单带 TP/SL 时挂 OCO 子单 */
  private fill(o: SimOrder, price: number, time: number): void {
    const qty = o.quantity; // 模拟撮合不拆批,整单成交
    this.working = this.working.filter((x) => x.orderId !== o.orderId);
    if (o.oco) this.working = this.working.filter((x) => x.oco !== o.oco); // OCO:一边成交撤另一边

    // 持仓与盈亏:加仓加权均价;减仓计已实现;反手以成交价为新成本
    const pv = this.deps.pointValueOf(o.instrument);
    const pos =
      this.positions.get(o.instrument) ??
      ({ instrument: o.instrument, quantity: 0, averagePrice: 0, marketPosition: 'Flat' } as Nt8Position);
    const signed = o.action === 'Buy' ? qty : -qty;
    const newQty = pos.quantity + signed;
    let avg = pos.averagePrice;
    if (pos.quantity === 0 || Math.sign(pos.quantity) === Math.sign(signed)) {
      avg = (pos.averagePrice * Math.abs(pos.quantity) + price * qty) / (Math.abs(pos.quantity) + qty);
    } else {
      const closing = Math.min(Math.abs(pos.quantity), qty);
      this.realized += (price - pos.averagePrice) * closing * Math.sign(pos.quantity) * pv;
      if (newQty === 0) avg = 0;
      else if (Math.sign(newQty) !== Math.sign(pos.quantity)) avg = price;
    }
    pos.quantity = newQty;
    pos.averagePrice = avg;
    pos.marketPosition = newQty > 0 ? 'Long' : newQty < 0 ? 'Short' : 'Flat';
    this.positions.set(o.instrument, pos);
    this.executions.push({ time, timeMs: time * 1000, sequence: this.executions.length + 1,
      price, qty, side: o.action, orderId: o.orderId, instrument: o.instrument,
      executionId: `exec-${o.orderId}`, commission: 0, account: SIM_ACCOUNT, pointValue: pv, currency: 'USD' });

    this.resizeProtection(o.instrument, newQty);

    // 入场成交后挂 OCO 止盈/止损子单(name 含 TP/SL,订单线按此着色)
    const direction = o.action === 'Buy' ? 1 : -1;
    const tp = o.tpAmount ? price + direction * o.tpAmount / (pv * qty) : o.tpPrice ?? 0;
    const sl = o.slAmount ? price - direction * o.slAmount / (pv * qty) : o.slPrice ?? 0;
    const alreadyProtected = this.working.some(x => x.instrument === o.instrument && x.oco);
    if ((tp > 0 || sl > 0) && newQty * direction > 0 && !alreadyProtected) {
      const oco = `sim-oco-${++this.ocoSeq}`;
      const base = {
        instrument: o.instrument,
        action: o.action === 'Buy' ? 'Sell' : 'Buy',
        quantity: Math.abs(newQty),
        filled: 0,
        averageFillPrice: 0,
        state: 'Working',
        oco,
        time,
      };
      if (tp > 0) {
        this.working.push({
          ...base,
          orderId: `SIM-${Date.now()}-${++this.orderSeq}`,
          orderType: 'Limit',
          limitPrice: tp,
          stopPrice: 0,
          name: 'TP',
        });
      }
      if (sl > 0) {
        this.working.push({
          ...base,
          orderId: `SIM-${Date.now()}-${++this.orderSeq}`,
          orderType: 'StopMarket',
          limitPrice: 0,
          stopPrice: sl,
          name: 'SL',
        });
      }
    }
  }

  private resizeProtection(symbol: string, quantity: number): void {
    this.working = this.working.filter(o => o.instrument !== symbol || !o.oco
      || (quantity !== 0 && (o.action === 'Buy' ? quantity < 0 : quantity > 0)));
    const groups = new Map<string, SimOrder[]>();
    for (const o of this.working.filter(o => o.instrument === symbol && o.oco)) {
      groups.set(o.oco, [...(groups.get(o.oco) ?? []), o]);
    }
    const entries = [...groups.values()];
    const weights = entries.map(g => Math.max(...g.map(o => o.quantity - o.filled)));
    const total = weights.reduce((a, b) => a + b, 0);
    if (!total) return;
    const exact = weights.map(w => w * Math.abs(quantity) / total);
    const sizes = exact.map(Math.floor);
    const extra = Math.abs(quantity) - sizes.reduce((a, b) => a + b, 0);
    exact.map((v, i) => ({ i, fraction: v - sizes[i] })).sort((a, b) => b.fraction - a.fraction)
      .slice(0, extra).forEach(({ i }) => sizes[i]++);
    entries.forEach((g, i) => g.forEach(o => {
      if (sizes[i]) o.quantity = o.filled + sizes[i];
      else this.working = this.working.filter(x => x !== o);
    }));
  }
}
