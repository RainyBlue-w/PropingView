import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Eye, EyeOff, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  type Nt8Account,
  type Nt8Order,
  type Nt8Position,
} from '@/lib/nt8Trading';
import { trading } from '@/lib/tradingRouter';
import { getBridgeUrl } from '@/lib/config';
import { amountToPrice, detectOrderType, type DraftSide } from '@/lib/draftCalc';

interface TradingPanelProps {
  showTradingPanel?: boolean;
  showAccountPanel?: boolean;
  onCloseTradingPanel?: () => void;
  onCloseAccountPanel?: () => void;
  enabled: boolean;
  symbol: string;
  tickSize: number;
  accounts: Nt8Account[];
  account: string;
  onAccountChange: (name: string) => void;
  /** 隐藏账户名列表(账户页灰化沉底;交易下拉框不显示) */
  hiddenAccounts: string[];
  /** 眼睛开关:隐藏/恢复账户 */
  onToggleHidden: (name: string) => void;
  positions: Nt8Position[];
  orders: Nt8Order[];
  /** 持仓/订单轮询错误(null=正常);面板顶部红条提示 */
  pollError: string | null;
  onChanged: () => void;
  // ---- 交易/草稿模式与票据状态(提升自 ChartTerminal,草稿线需要共享) ----
  mode: 'trade' | 'draft';
  onModeChange: (m: 'trade' | 'draft') => void;
  side: DraftSide;
  onSideChange: (s: DraftSide) => void;
  kind: OrderKind;
  onKindChange: (k: OrderKind) => void;
  qty: number;
  onQtyChange: (q: number) => void;
  limitPrice: string;
  onLimitPriceChange: (v: string) => void;
  /** 草稿:止盈/止损金额(美元) */
  tpAmount: string;
  onTpAmountChange: (v: string) => void;
  slAmount: string;
  onSlAmountChange: (v: string) => void;
  /** 每 1.00 点美元价值 */
  pointValue: number;
  /** 草稿基准价(限价单=输入限价;市价类=冻结最新价) */
  refPrice: number | null;
  onRefreshRef: () => void;
  /** 取当前市价(LMT/STP 自动判定用) */
  getMarketPrice: () => number | null;
}

/** UI 订单类型:MKT=市价;LMT/STP=限价/止损(按方向与市价关系自动判定) */
export type OrderKind = 'MKT' | 'LMTSTP';

// NT8 真实枚举名:Working/Accepted/Submitted/PartFilled/TriggerPending/Suspended/
// AcceptedByRisk/Initialized/ChangePending/ChangeSubmitted/CancelPending/CancelSubmitted
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

/** 按 tick 推小数位数(0.25 -> 2 位,0.1 -> 1 位,0.0001 -> 4 位) */
function tickDecimals(tick: number): number {
  if (!tick || tick <= 0) return 2;
  let d = 0;
  while (d < 8 && Math.abs(tick * 10 ** d - Math.round(tick * 10 ** d)) > 1e-9) d++;
  return d;
}

/** 按 Connection 分组(保持首现顺序);无连接的归入"其他" */
interface AccountGroup {
  connection: string;
  items: Nt8Account[];
}
function groupByConnection(list: Nt8Account[]): AccountGroup[] {
  const groups: AccountGroup[] = [];
  const idx = new Map<string, AccountGroup>();
  for (const a of list) {
    const key = a.connection ? a.connection : '其他';
    let g = idx.get(key);
    if (!g) {
      g = { connection: key, items: [] };
      idx.set(key, g);
      groups.push(g);
    }
    g.items.push(a);
  }
  return groups;
}

/** 折叠组名持久化 key */
const COLLAPSED_KEY = 'tv-collapsed-conn-groups';

export default function TradingPanel({
  showTradingPanel = true,
  showAccountPanel = true,
  onCloseTradingPanel,
  onCloseAccountPanel,
  enabled,
  symbol,
  tickSize,
  accounts,
  account,
  onAccountChange,
  hiddenAccounts,
  onToggleHidden,
  positions,
  orders,
  pollError,
  onChanged,
  mode,
  onModeChange,
  side,
  onSideChange,
  kind,
  onKindChange,
  qty,
  onQtyChange,
  limitPrice,
  onLimitPriceChange,
  tpAmount,
  onTpAmountChange,
  slAmount,
  onSlAmountChange,
  pointValue,
  refPrice,
  onRefreshRef,
  getMarketPrice,
}: TradingPanelProps) {
  const [tpPrice, setTpPrice] = useState('');
  const [slPrice, setSlPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [rowActions, setRowActions] = useState<Record<string, { busy: boolean; ok?: boolean; text?: string }>>({});
  const pendingRowActions = useRef(new Set<string>());
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [ticketSymbol, setTicketSymbol] = useState(symbol);
  const symbolContext = useRef(0);
  useEffect(() => {
    symbolContext.current += 1;
  }, [symbol]);
  // 绝对价格仅属于当前合约；切图时同步清空，隐藏面板不影响表单。
  if (ticketSymbol !== symbol) {
    setTicketSymbol(symbol);
    setTpPrice('');
    setSlPrice('');
    setMessage(null);
  }
  /** 账户下拉(自绘,支持 Connection 分组折叠) */
  const [ddOpen, setDdOpen] = useState(false);
  const ddRef = useRef<HTMLDivElement>(null);
  /** Connection 分组折叠状态(localStorage 持久化,账户页/下拉共用) */
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  });
  const toggleGroup = (name: string) => {
    setCollapsed((prev) => {
      const next = prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name];
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        /* 存储不可用时仅本次会话生效 */
      }
      return next;
    });
  };
  useEffect(() => {
    if (!ddOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (ddRef.current && !ddRef.current.contains(e.target as Node)) setDdOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [ddOpen]);

  // API 已按当前账户查询；此处必须列出该账户所有合约，不随当前图表筛选。
  const workingOrders = orders.filter((o) => WORKING_STATES.has(o.state));
  const openPositions = positions.filter((p) => Number.isFinite(p.quantity) && p.quantity !== 0);
  const rowKey = (kind: 'position' | 'order', id: string) => JSON.stringify([account, kind, id]);
  // 其他合约可能使用不同 tick；账户列表不能套用当前图表的小数位。
  const formatRowPrice = (price: number) => Number.isFinite(price)
    ? price.toLocaleString('en-US', { useGrouping: false, minimumFractionDigits: 2, maximumFractionDigits: 8 }) : '—';
  /** 当前账户的财务信息(净值/已实现/浮盈),随 3 秒轮询刷新 */
  const currentAccount = accounts.find((a) => a.name === account);
  /** 交易下拉框只显可见账户;账户页可见在前、隐藏沉底(保持各自原有顺序) */
  const visibleAccounts = accounts.filter((a) => !hiddenAccounts.includes(a.name));
  const sortedAccounts = [
    ...visibleAccounts,
    ...accounts.filter((a) => hiddenAccounts.includes(a.name)),
  ];
  const decimals = tickDecimals(tickSize);

  // 草稿模式:金额 -> 目标价 预览(与图上虚线一致)
  const tpComputed =
    mode === 'draft' && refPrice && parseFloat(tpAmount) > 0
      ? amountToPrice(side, true, parseFloat(tpAmount), refPrice, tickSize, pointValue, qty)
      : null;
  const slComputed =
    mode === 'draft' && refPrice && parseFloat(slAmount) > 0
      ? amountToPrice(side, false, parseFloat(slAmount), refPrice, tickSize, pointValue, qty)
      : null;

  // LMT/STP 自动判定预览(按当前市价)
  const priceNum = parseFloat(limitPrice);
  const detected =
    kind === 'LMTSTP' && priceNum > 0
      ? detectOrderType(side, roundToTick(priceNum, tickSize), getMarketPrice())
      : null;

  const submit = async (clicked: DraftSide) => {
    const submittedContext = symbolContext.current;
    // 草稿模式两段式:点击与当前预览方向不同的按钮 -> 先切方向(虚线镜像),再点才提交
    if (mode === 'draft' && clicked !== side) {
      onSideChange(clicked);
      setMessage({
        ok: true,
        text: `已切换为${clicked === 'BUY' ? '买入' : '卖出'}方向,确认虚线位置后再点一次提交`,
      });
      return;
    }
    // LMT/STP:按方向与市价关系自动判定 LIMIT / STOPMARKET
    let orderType: 'MARKET' | 'LIMIT' | 'STOPMARKET' = 'MARKET';
    let lp: number | undefined;
    let sp: number | undefined;
    if (kind === 'LMTSTP') {
      const p = roundToTick(parseFloat(limitPrice), tickSize);
      if (!(p > 0)) {
        setMessage({ ok: false, text: '请输入有效价格' });
        return;
      }
      orderType = detectOrderType(clicked, p, getMarketPrice());
      if (orderType === 'LIMIT') lp = p;
      else sp = p;
    }
    // 草稿模式:止盈止损来自金额换算(与图上虚线位置一致);交易模式:直接读价格输入。
    // 市价单成交价未知,发金额由桥在成交后按实际均价换算;LMT/STP 入场价已知,直接发绝对价
    let tp: number | undefined;
    let sl: number | undefined;
    let tpA = NaN;
    let slA = NaN;
    if (mode === 'draft') {
      tpA = parseFloat(tpAmount);
      slA = parseFloat(slAmount);
      if (kind === 'LMTSTP') {
        if (refPrice && tpA > 0) {
          tp = amountToPrice(clicked, true, tpA, refPrice, tickSize, pointValue, qty) ?? undefined;
        }
        if (refPrice && slA > 0) {
          sl = amountToPrice(clicked, false, slA, refPrice, tickSize, pointValue, qty) ?? undefined;
        }
      }
    } else {
      tp = tpPrice ? roundToTick(parseFloat(tpPrice), tickSize) : undefined;
      sl = slPrice ? roundToTick(parseFloat(slPrice), tickSize) : undefined;
    }
    setBusy(true);
    setMessage(null);
    try {
      await trading.placeOrder({
        account,
        symbol,
        action: clicked,
        orderType,
        quantity: qty,
        limitPrice: lp,
        stopPrice: sp,
        tp,
        sl,
        tpAmount: mode === 'draft' && kind === 'MKT' && tpA > 0 ? tpA : undefined,
        slAmount: mode === 'draft' && kind === 'MKT' && slA > 0 ? slA : undefined,
      });
      if (submittedContext !== symbolContext.current) {
        onChanged();
        return;
      }
      const mktAmt =
        mode === 'draft' && kind === 'MKT' && (tpA > 0 || slA > 0)
          ? `${tpA > 0 ? ` · 止盈 $${tpA}` : ''}${slA > 0 ? ` · 止损 $${slA}` : ''}(按实际成交价定位)`
          : '';
      setMessage({
        ok: true,
        text:
          `${orderType === 'LIMIT' ? '限价单' : orderType === 'STOPMARKET' ? '止损单' : '市价单'}已提交` +
          (mktAmt ||
            (mode === 'draft' && (tp || sl)
              ? `${tp ? ` · 止盈 ${tp.toFixed(decimals)}` : ''}${sl ? ` · 止损 ${sl.toFixed(decimals)}` : ''}`
              : '')),
      });
      if (mode === 'draft') {
        // 草稿提交后由真实订单线接管:清掉草稿金额与入场价,所有草稿虚线随之消失
        onTpAmountChange('');
        onSlAmountChange('');
        onLimitPriceChange('');
      }
      onChanged();
    } catch (err) {
      if (submittedContext === symbolContext.current) {
        setMessage({ ok: false, text: err instanceof Error ? err.message : '下单失败' });
      }
    } finally {
      setBusy(false);
    }
  };

  const runRowAction = async (key: string, action: () => Promise<unknown>, success: string, failure: string) => {
    if (!enabled || !account || pendingRowActions.current.has(key)) return;
    pendingRowActions.current.add(key);
    setRowActions(current => ({ ...current, [key]: { busy: true } }));
    try {
      await action();
      setRowActions(current => ({ ...current, [key]: { busy: false, ok: true, text: success } }));
      onChanged();
    } catch (err) {
      setRowActions(current => ({ ...current, [key]: { busy: false, ok: false, text: err instanceof Error ? err.message : failure } }));
    } finally {
      pendingRowActions.current.delete(key);
    }
  };

  const cancelOrder = (orderId: string) => runRowAction(rowKey('order', orderId),
    () => trading.cancelOrder(account, orderId), '撤单已提交', '撤单失败');

  const closePosition = (instrument: string) => runRowAction(rowKey('position', instrument),
    () => trading.closePosition(account, instrument), '平仓单已提交', '平仓失败');

  const inputCls =
    'h-8 border-[var(--tv-border)] bg-[var(--tv-bg)] text-[var(--tv-text)] text-xs font-mono';
  const labelCls = 'text-[11px] text-[var(--tv-muted)]';

  /** 金额显示:缺失(旧版桥)显 —;负数前置 - 号 */
  const fmtMoney = (v?: number): string =>
    v == null
      ? '—'
      : `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const pnlCls = (v?: number): string =>
    v == null ? 'text-[var(--tv-muted)]' : v >= 0 ? 'text-[#26a69a]' : 'text-[#ef5350]';

  /** 账户页单个账户卡片 */
  const renderAccountCard = (a: Nt8Account) => {
    const isActive = a.name === account;
    const isHidden = hiddenAccounts.includes(a.name);
    const hasFin = a.netLiquidation != null || a.cashValue != null;
    return (
      <div
        key={a.name}
        onClick={() => { if (!isHidden) onAccountChange(a.name); }}
        className={`w-full rounded border p-2.5 text-left transition-colors ${
          isHidden
            ? 'cursor-default border-[var(--tv-border)] bg-[var(--tv-bg)] opacity-40 grayscale'
            : isActive
              ? 'cursor-pointer border-[#2962ff] bg-[#2962ff]/10'
              : 'cursor-pointer border-[var(--tv-border)] bg-[var(--tv-bg)] hover:border-[#2962ff]/50'
        }`}
        title={isHidden ? '已隐藏(点眼睛恢复)' : isActive ? '当前账户' : '点击切换为该账户'}
      >
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-bold">
            {a.name}
            {a.connection ? (
              <span className="ml-1 font-normal text-[var(--tv-muted)]">· {a.connection}</span>
            ) : null}
          </span>
          <span className="flex items-center gap-1.5">
            {isActive && !isHidden && (
              <span className="rounded bg-[#2962ff] px-1.5 py-0.5 text-[10px] font-semibold text-white">
                当前
              </span>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleHidden(a.name);
              }}
              className="rounded p-0.5 text-[var(--tv-muted)] hover:bg-[var(--tv-border)] hover:text-[var(--tv-text)]"
              title={isHidden ? '恢复显示该账户' : '隐藏该账户(移到列表底部,交易下拉框不再显示)'}
            >
              {isHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </button>
          </span>
        </div>
        {hasFin ? (
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            <span className="text-[var(--tv-muted)]">净清算</span>
            <span className="text-right font-mono">{fmtMoney(a.netLiquidation)}</span>
            <span className="text-[var(--tv-muted)]">现金</span>
            <span className="text-right font-mono">{fmtMoney(a.cashValue)}</span>
            <span className="text-[var(--tv-muted)]">未实现盈亏</span>
            <span className={`text-right font-mono ${pnlCls(a.unrealizedPnl)}`}>
              {fmtMoney(a.unrealizedPnl)}
            </span>
            <span className="text-[var(--tv-muted)]">当日已实现</span>
            <span className={`text-right font-mono ${pnlCls(a.realizedPnl)}`}>
              {fmtMoney(a.realizedPnl)}
            </span>
          </div>
        ) : (
          <div className="text-[11px] text-[var(--tv-muted)]">
            余额/盈亏需要升级桥端(NT8 里 F5 编译 TvBridgeAddOn)后可见
          </div>
        )}
      </div>
    );
  };

  /** Connection 分组头(账户页/下拉共用样式) */
  const renderGroupHeader = (g: AccountGroup) => (
    <button
      key={g.connection}
      onClick={() => toggleGroup(g.connection)}
      className="flex w-full items-center gap-1 rounded px-1 py-1 text-[11px] font-semibold text-[var(--tv-muted)] transition-colors hover:text-[var(--tv-text)]"
      title={collapsed.includes(g.connection) ? '展开该组' : '收起该组'}
    >
      {collapsed.includes(g.connection) ? (
        <ChevronRight className="h-3 w-3 shrink-0" />
      ) : (
        <ChevronDown className="h-3 w-3 shrink-0" />
      )}
      <span className="truncate">{g.connection}</span>
      <span className="shrink-0 font-normal">({g.items.length})</span>
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-px overflow-hidden bg-[var(--tv-border)] text-[var(--tv-text)]">
      {/* 持仓/订单轮询失败提示由两个面板共用。 */}
      {pollError && (showTradingPanel || showAccountPanel) && (
        <div className="mx-2 mt-2 shrink-0 rounded border border-[#ef5350]/40 bg-[#ef5350]/10 px-2 py-1.5 text-[11px] leading-4 text-[#ef5350]">
          持仓/订单读取失败:{pollError}
          <br />
          可打开 <a className="underline" href={`${getBridgeUrl()}/api/debug`} target="_blank" rel="noreferrer">数据桥诊断</a> 自查桥端状态
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 gap-px overflow-hidden">
      <section
        id="trading-page-trade"
        aria-labelledby="trading-panel-heading"
        className={`${showTradingPanel ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col bg-[var(--tv-panel)]`}
      >
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--tv-border)] px-3">
          <h2 id="trading-panel-heading" className="text-xs font-semibold">交易面板</h2>
          {onCloseTradingPanel && (
            <button
              type="button"
              onClick={onCloseTradingPanel}
              aria-label="关闭交易面板"
              title="关闭交易面板"
              className="rounded p-1 text-[var(--tv-muted)] hover:bg-[var(--tv-border)] hover:text-[var(--tv-text)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
      {/* 账户 */}
      <div className="border-b border-[var(--tv-border)] p-3">
        <div className={labelCls}>账户</div>
        {/* 自绘下拉:shadcn Select 不支持分组折叠 */}
        <div className="relative mt-1" ref={ddRef}>
          <button
            onClick={() => setDdOpen((v) => !v)}
            className="flex h-8 w-full items-center justify-between rounded-md border border-[var(--tv-border)] bg-[var(--tv-bg)] px-2 text-xs"
          >
            <span className="truncate font-mono">
              {account || '选择账户'}
              {account && currentAccount?.connection ? (
                <span className="ml-1 text-[var(--tv-muted)]">· {currentAccount.connection}</span>
              ) : null}
            </span>
            <ChevronDown
              className={`h-3.5 w-3.5 shrink-0 text-[var(--tv-muted)] transition-transform ${ddOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {ddOpen && (
            <div className="absolute z-50 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-[var(--tv-border)] bg-[var(--tv-panel)] shadow-lg">
              {groupByConnection(visibleAccounts).map((g) => (
                <div key={g.connection}>
                  {renderGroupHeader(g)}
                  {!collapsed.includes(g.connection) &&
                    g.items.map((a) => (
                      <button
                        key={a.name}
                        onClick={() => {
                          onAccountChange(a.name);
                          setDdOpen(false);
                        }}
                        className={`block w-full px-3 py-1.5 text-left font-mono text-xs transition-colors hover:bg-[#2962ff]/10 ${
                          a.name === account ? 'bg-[#2962ff]/15 text-[#2962ff]' : ''
                        }`}
                      >
                        {a.name}
                      </button>
                    ))}
                </div>
              ))}
              {visibleAccounts.length === 0 && (
                <div className="px-3 py-2 text-[11px] text-[var(--tv-muted)]">无可用账户</div>
              )}
            </div>
          )}
        </div>
        {/* 当前账户财务:净值 / 今日已实现 / 浮盈(3 秒轮询刷新) */}
        {currentAccount && (
          <div className="mt-2 grid grid-cols-3 gap-1 rounded bg-[var(--tv-bg)] px-2 py-1.5">
            <div className="min-w-0">
              <div className={labelCls}>净值</div>
              <div className="truncate font-mono text-xs" title={fmtMoney(currentAccount.netLiquidation)}>
                {fmtMoney(currentAccount.netLiquidation)}
              </div>
            </div>
            <div className="min-w-0">
              <div className={labelCls}>今日已实现</div>
              <div
                className={`truncate font-mono text-xs ${pnlCls(currentAccount.realizedPnl)}`}
                title={fmtMoney(currentAccount.realizedPnl)}
              >
                {fmtMoney(currentAccount.realizedPnl)}
              </div>
            </div>
            <div className="min-w-0">
              <div className={labelCls}>浮盈</div>
              <div
                className={`truncate font-mono text-xs ${pnlCls(currentAccount.unrealizedPnl)}`}
                title={fmtMoney(currentAccount.unrealizedPnl)}
              >
                {fmtMoney(currentAccount.unrealizedPnl)}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 下单票 */}
      <div className="border-b border-[var(--tv-border)] p-3">
        {/* 交易/草稿模式切换 */}
        <div className="mb-2 grid grid-cols-2 gap-1 rounded bg-[var(--tv-bg)] p-0.5 text-xs">
          <button
            onClick={() => onModeChange('trade')}
            className={`rounded py-1 font-semibold transition-colors ${
              mode === 'trade' ? 'bg-[#2962ff] text-white' : 'text-[var(--tv-muted)] hover:text-[var(--tv-text)]'
            }`}
          >
            交易
          </button>
          <button
            onClick={() => onModeChange('draft')}
            className={`rounded py-1 font-semibold transition-colors ${
              mode === 'draft' ? 'bg-[#f0b90b] text-black' : 'text-[var(--tv-muted)] hover:text-[var(--tv-text)]'
            }`}
          >
            草稿
          </button>
        </div>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-semibold">
            {mode === 'draft' ? '草稿单' : '下单'} · {symbol || '—'}
          </span>
        </div>

        {/* MKT / LMT·STP 切换(原买卖切换位) */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => onKindChange('MKT')}
            className={`rounded py-2 text-sm font-bold transition-colors ${
              kind === 'MKT'
                ? 'bg-[#2962ff] text-white'
                : 'bg-[#2962ff]/15 text-[#2962ff] hover:bg-[#2962ff]/25'
            }`}
          >
            MKT
          </button>
          <button
            onClick={() => onKindChange('LMTSTP')}
            className={`rounded py-2 text-sm font-bold transition-colors ${
              kind === 'LMTSTP'
                ? 'bg-[#2962ff] text-white'
                : 'bg-[#2962ff]/15 text-[#2962ff] hover:bg-[#2962ff]/25'
            }`}
          >
            LMT/STP
          </button>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <div>
            <div className={labelCls}>数量</div>
            <Input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => onQtyChange(Math.max(1, parseInt(e.target.value, 10) || 1))}
              className={inputCls}
            />
          </div>
          {kind === 'LMTSTP' && (
            <div>
              <div className={labelCls}>
                {mode === 'draft' ? '入场价(图上虚线可拖)' : '价格'}
              </div>
              <Input
                value={limitPrice}
                onChange={(e) => onLimitPriceChange(e.target.value)}
                placeholder="0.00"
                className={inputCls}
              />
            </div>
          )}
        </div>

        {/* LMT/STP 自动判定提示:草稿模式按当前预览方向给出具体结果,交易模式给通用规则 */}
        {kind === 'LMTSTP' &&
          (mode === 'draft' && detected ? (
            <div className="mt-1 text-[11px] text-[var(--tv-muted)]">
              {side === 'BUY' ? '买入' : '卖出'}价
              {detected === 'LIMIT'
                ? '位于市价' + (side === 'BUY' ? '下方' : '上方')
                : '位于市价' + (side === 'BUY' ? '上方' : '下方')}
              → 将下
              <span className="text-[var(--tv-text)]">
                {detected === 'LIMIT' ? '限价单 LMT' : '止损单 STP'}
              </span>
            </div>
          ) : (
            <div className="mt-1 text-[11px] text-[var(--tv-muted)]">
              自动判定:买入价低于市价→限价单 LMT,高于市价→止损单 STP;卖出相反
            </div>
          ))}

        {mode === 'draft' ? (
          <>
            {/* 草稿:止盈/止损金额,自动换算成图上虚线 */}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <div className={labelCls}>止盈金额($)</div>
                <Input
                  type="number"
                  min={0}
                  value={tpAmount}
                  onChange={(e) => onTpAmountChange(e.target.value)}
                  placeholder="如 100"
                  className={inputCls}
                />
              </div>
              <div>
                <div className={labelCls}>止损金额($)</div>
                <Input
                  type="number"
                  min={0}
                  value={slAmount}
                  onChange={(e) => onSlAmountChange(e.target.value)}
                  placeholder="如 50"
                  className={inputCls}
                />
              </div>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[11px] text-[var(--tv-muted)]">
              <span>
                基准价{' '}
                <span className="font-mono text-[var(--tv-text)]">
                  {refPrice ? refPrice.toFixed(decimals) : '—'}
                </span>
                {kind === 'MKT' && (
                  <button
                    onClick={onRefreshRef}
                    className="ml-1.5 text-[#2962ff] hover:underline"
                    title="以最新价重新计算虚线位置"
                  >
                    刷新
                  </button>
                )}
              </span>
              <span>每tick ${(tickSize * pointValue).toFixed(2)}</span>
            </div>
            {(tpComputed != null || slComputed != null) && (
              <div className="mt-1 font-mono text-[11px] leading-4">
                {tpComputed != null && (
                  <span className="text-[#26a69a]">TP {tpComputed.toFixed(decimals)}</span>
                )}
                {tpComputed != null && slComputed != null && '  '}
                {slComputed != null && (
                  <span className="text-[#ef5350]">SL {slComputed.toFixed(decimals)}</span>
                )}
                <span className="ml-1 text-[var(--tv-muted)]">(图上虚线可拖)</span>
              </div>
            )}
          </>
        ) : (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <div className={labelCls}>止盈价(可选)</div>
              <Input
                value={tpPrice}
                onChange={(e) => setTpPrice(e.target.value)}
                placeholder="成交后自动挂"
                className={inputCls}
              />
            </div>
            <div>
              <div className={labelCls}>止损价(可选)</div>
              <Input
                value={slPrice}
                onChange={(e) => setSlPrice(e.target.value)}
                placeholder="成交后自动挂"
                className={inputCls}
              />
            </div>
          </div>
        )}

        {/* 提交:买入 +N / 卖出 -N(草稿模式下点击异向按钮先切预览方向,再点提交) */}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button
            disabled={!enabled || busy || !account || !symbol}
            onClick={() => void submit('BUY')}
            className={
              mode === 'draft' && side !== 'BUY'
                ? 'bg-[#26a69a]/15 text-[#26a69a] hover:bg-[#26a69a]/25'
                : 'bg-[#26a69a] hover:bg-[#26a69a]/90'
            }
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : `买入 +${qty}`}
          </Button>
          <Button
            disabled={!enabled || busy || !account || !symbol}
            onClick={() => void submit('SELL')}
            className={
              mode === 'draft' && side !== 'SELL'
                ? 'bg-[#ef5350]/15 text-[#ef5350] hover:bg-[#ef5350]/25'
                : 'bg-[#ef5350] hover:bg-[#ef5350]/90'
            }
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : `卖出 -${qty}`}
          </Button>
        </div>

        {message && (
          <div
            className={`mt-2 flex items-center gap-1.5 text-xs ${
              message.ok ? 'text-[#26a69a]' : 'text-[#ef5350]'
            }`}
          >
            {message.ok ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <AlertCircle className="h-3.5 w-3.5" />
            )}
            {message.text}
          </div>
        )}
        {!enabled && (
          <div className="mt-2 text-[11px] text-[var(--tv-muted)]">
            模拟数据模式下不可交易,请连接 NT8 数据桥。
          </div>
        )}
      </div>

      {/* 持仓 */}
      <div className="border-b border-[var(--tv-border)] p-3">
        <div className="mb-1.5 text-xs font-semibold">所有持仓</div>
        {openPositions.length === 0 ? (
          <div className="text-[11px] text-[var(--tv-muted)]">无持仓</div>
        ) : <div className="space-y-1">
          {openPositions.map(position => {
            const action = rowActions[rowKey('position', position.instrument)];
            return <div key={position.instrument} data-position-instrument={position.instrument}
              className="rounded bg-[var(--tv-bg)] px-2 py-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate font-mono font-semibold" title={position.instrument}>{position.instrument}</span>
                <Button size="sm" variant="ghost" disabled={!enabled || !account || action?.busy}
                  aria-label={`市价平仓 ${position.instrument}`}
                  onClick={() => void closePosition(position.instrument)}
                  className="h-6 shrink-0 px-2 text-[11px] text-[#f0b90b] hover:bg-[var(--tv-border)]">
                  {action?.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : '市价平仓'}
                </Button>
              </div>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <span className={position.quantity > 0 ? 'text-[#26a69a]' : 'text-[#ef5350]'}>
                  {position.quantity > 0 ? '多' : '空'} {Math.abs(position.quantity)} 手
                </span>
                <span className="font-mono text-[var(--tv-text)]">均价 {formatRowPrice(position.averagePrice)}</span>
              </div>
              {action?.text && <div role={action.ok ? 'status' : 'alert'}
                className={`mt-1 text-[11px] ${action.ok ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>{action.text}</div>}
            </div>;
          })}
        </div>}
      </div>

      {/* 工作中订单 */}
      <div className="flex-1 p-3">
        <div className="mb-1.5 text-xs font-semibold">
          所有工作中订单<span className="ml-1 font-normal text-[var(--tv-muted)]">({workingOrders.length})</span>
        </div>
        <div className="space-y-1">
          {workingOrders.length === 0 && (
            <div className="text-[11px] text-[var(--tv-muted)]">无</div>
          )}
          {workingOrders.map((o) => {
            const isBuy = o.action.startsWith('Buy');
            const isTp = o.name.includes('TP');
            const isSl = o.name.includes('SL');
            const price = o.limitPrice || o.stopPrice;
            const action = rowActions[rowKey('order', o.orderId)];
            return (
              <div
                key={o.orderId}
                data-order-id={o.orderId}
                className="rounded bg-[var(--tv-bg)] px-2 py-1.5 text-xs"
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono font-semibold" title={o.instrument}>{o.instrument}</span>
                  <button
                    onClick={() => void cancelOrder(o.orderId)} disabled={!enabled || !account || action?.busy}
                    aria-label={`撤销 ${o.instrument} 订单 ${o.orderId}`}
                    className="shrink-0 rounded p-0.5 text-[var(--tv-muted)] hover:bg-[var(--tv-border)] hover:text-[#ef5350] disabled:opacity-40"
                    title="撤单">
                    {action?.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <span className={isBuy ? 'text-[#26a69a]' : 'text-[#ef5350]'}>
                  {isBuy ? '买' : '卖'} {o.quantity - o.filled} 手
                  {isTp && <span className="ml-1 text-[#26a69a]">·止盈</span>}
                  {isSl && <span className="ml-1 text-[#ef5350]">·止损</span>}
                </span>
                <span className="font-mono">{price > 0 ? `@ ${formatRowPrice(price)}` : '市价'}</span>
                </div>
                {action?.text && <div role={action.ok ? 'status' : 'alert'}
                  className={`mt-1 text-[11px] ${action.ok ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>{action.text}</div>}
              </div>
            );
          })}
        </div>
        <div className="mt-3 text-[11px] leading-4 text-[var(--tv-muted)]">
          提示:图表上的订单线可直接拖拽改价(止盈止损线同样可拖);选中线后按 Delete
          键或右键删除即可撤单。
        </div>
      </div>
      </div>
      </section>

      <section
        id="trading-page-accounts"
        aria-labelledby="account-panel-heading"
        className={`${showAccountPanel ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col bg-[var(--tv-panel)]`}
      >
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-[var(--tv-border)] px-3">
          <h2 id="account-panel-heading" className="text-xs font-semibold">账户信息</h2>
          {onCloseAccountPanel && (
            <button
              type="button"
              onClick={onCloseAccountPanel}
              aria-label="关闭账户信息"
              title="关闭账户信息"
              className="rounded p-1 text-[var(--tv-muted)] hover:bg-[var(--tv-border)] hover:text-[var(--tv-text)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {accounts.length === 0 && (
            <div className="text-[11px] text-[var(--tv-muted)]">
              无账户数据(需连接 NT8 数据桥)
            </div>
          )}
          <div className="space-y-2">
            {groupByConnection(sortedAccounts).map((g) => (
              <div key={g.connection}>
                {renderGroupHeader(g)}
                {!collapsed.includes(g.connection) && (
                  <div className="space-y-2">{g.items.map(renderAccountCard)}</div>
                )}
              </div>
            ))}
          </div>
          <div className="mt-3 text-[11px] leading-4 text-[var(--tv-muted)]">
            数据每 3 秒随交易轮询刷新;点击卡片可切换当前交易账户;眼睛图标隐藏/恢复账户(隐藏的沉底且不可选)。
          </div>
        </div>
      </section>
      </div>
    </div>
  );
}
