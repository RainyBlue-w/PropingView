import { useCallback, useEffect, useRef, useState } from 'react';
import { History, Moon, RefreshCw, Settings, Sun, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import TvAdvancedChart from '@/components/TvAdvancedChart';
import TradingPanel, { type OrderKind } from '@/sections/TradingPanel';
import { useOrderLines } from '@/hooks/useOrderLines';
import { useDraftLines } from '@/hooks/useDraftLines';
import { useExecutionTrades } from '@/hooks/useExecutionTrades';
import { detectOrderType, resolvePointValue, roundToTick, tickDecimals, type DraftSide } from '@/lib/draftCalc';
import { getBridgeUrl, setBridgeUrl, DEFAULT_BRIDGE_URL_DISPLAY } from '@/lib/config';
import { createMockAdapter } from '@/lib/mockFeed';
import { checkNt8Status, createNt8Adapter, type Nt8Status } from '@/lib/nt8Bridge';
import { nt8Trading, type Nt8Account, type Nt8Bracket, type Nt8Order, type Nt8Position } from '@/lib/nt8Trading';
import { TvDatafeed } from '@/lib/tvDatafeed';

type FeedStatus = 'connecting' | 'nt8' | 'mock';

const ACCOUNT_KEY = 'nt8-terminal-account';
const PANEL_WIDTH_KEY = 'nt8-terminal-panel-width';
const THEME_KEY = 'nt8-terminal-theme';
const SETTINGS_POS_KEY = 'nt8-terminal-settings-pos';
const HIDDEN_ACCOUNTS_KEY = 'nt8-terminal-hidden-accounts';

export default function ChartTerminal() {
  const [datafeed] = useState(() => new TvDatafeed(createMockAdapter()));
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const [nt8Info, setNt8Info] = useState<Nt8Status | null>(null);
  const [defaultSymbol, setDefaultSymbol] = useState<string>('');
  const [bridgeUrlDraft, setBridgeUrlDraft] = useState(getBridgeUrl());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [symbolsEmpty, setSymbolsEmpty] = useState(false);

  // ---- 白天/黑夜主题(图表 + 应用外壳;localStorage 记忆) ----
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });

  // ---- 设置浮窗位置(可拖动,记忆) ----
  const [settingsPos, setSettingsPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_POS_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (typeof p.x === 'number' && typeof p.y === 'number') return p;
      }
    } catch { /* ignore */ }
    return null;
  });
  const settingsDragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null);
  const settingsWinRef = useRef<HTMLDivElement>(null);

  // ---- 交易状态 ----
  const [widget, setWidget] = useState<TradingViewWidget | null>(null);
  /** 订单成交/持仓签名:变化时刷新图表交易历史箭头 */
  const tradeSigRef = useRef('');
  const [tradeSig, setTradeSig] = useState('');
  const [chartSymbol, setChartSymbol] = useState('');
  const [tickSize, setTickSize] = useState(0.25);
  const [accounts, setAccounts] = useState<Nt8Account[]>([]);
  const [account, setAccount] = useState(() => {
    try { return localStorage.getItem(ACCOUNT_KEY) || ''; } catch { return ''; }
  });
  const [positions, setPositions] = useState<Nt8Position[]>([]);
  const [orders, setOrders] = useState<Nt8Order[]>([]);
  /** 待触发括号单(入场单未成交时的预设止盈/止损价) */
  const [brackets, setBrackets] = useState<Nt8Bracket[]>([]);

  // ---- 交易/草稿模式与票据状态(草稿线 hook 与面板共享) ----
  const [mode, setMode] = useState<'trade' | 'draft'>('trade');
  const [side, setSide] = useState<DraftSide>('BUY');
  const [kind, setKind] = useState<OrderKind>('MKT');
  const [qty, setQty] = useState(1);
  const [limitPrice, setLimitPrice] = useState('');
  const [tpAmount, setTpAmount] = useState('');
  const [slAmount, setSlAmount] = useState('');
  const [pointValue, setPointValue] = useState(50);
  /** 草稿基准价:进入草稿/切合约时冻结最新价;限价单改用输入限价 */
  const [refPrice, setRefPrice] = useState<number | null>(null);

  // ---- 面板宽度拖拽 ----
  const [panelWidth, setPanelWidth] = useState(() => {
    try { return parseInt(localStorage.getItem(PANEL_WIDTH_KEY) || '', 10) || 400; } catch { return 400; }
  });
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const connect = useCallback(async () => {
    setStatus('connecting');
    setSymbolsEmpty(false);
    const st = await checkNt8Status();
    setNt8Info(st);
    datafeed.setAdapter(st ? createNt8Adapter() : createMockAdapter());
    setStatus(st ? 'nt8' : 'mock');
    try {
      const symbols = await datafeed.listSymbols();
      if (symbols.length === 0 && st) setSymbolsEmpty(true);
      setTickSize(
        symbols.find((s) => s.symbol === chartSymbol)?.tickSize ??
          symbols.find((s) => s.symbol.startsWith('ES'))?.tickSize ??
          0.25,
      );
      const curSym =
        symbols.find((s) => s.symbol === chartSymbol) ??
        symbols.find((s) => s.symbol.startsWith('ES'));
      setPointValue(resolvePointValue(curSym?.symbol ?? chartSymbol, curSym?.pointValue));
      setDefaultSymbol((cur) => {
        if (cur && symbols.some((s) => s.symbol === cur)) return cur;
        return (
          symbols.find((s) => s.symbol.startsWith('ES'))?.symbol ??
          symbols[0]?.symbol ??
          (st ? 'ES 09-26' : '')
        );
      });
    } catch {
      /* 保留当前默认合约 */
    }
    if (st) {
      try {
        const { accounts: accs } = await nt8Trading.getAccounts();
        setAccounts(accs);
        setAccount((cur) =>
          cur && accs.some((a) => a.name === cur) ? cur : accs[0]?.name ?? '',
        );
      } catch {
        setAccounts([]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datafeed]);

  useEffect(() => {
    datafeed.onAdapterSwapped = () => {
      const w = widget;
      if (w) w.onChartReady(() => w.activeChart().resetData());
    };
    void connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect, datafeed]);

  // ---- 交易数据轮询(0.5 秒;桥端是轻量快照,直连本地开销极低) ----
  const refreshTrading = useCallback(async () => {
    if (status !== 'nt8' || !account) return;
    try {
      // brackets 端点依赖桥端升级(F5);未升级时单独容错,不拖垮订单/持仓轮询
      const [{ positions: p }, { orders: o }, bracketsRes, accsRes] = await Promise.all([
        nt8Trading.getPositions(account),
        nt8Trading.getOrders(account),
        nt8Trading.getBrackets(account).catch(() => null),
        // 账户余额/盈亏(账户信息页用);失败不影响其他数据
        nt8Trading.getAccounts().catch(() => null),
      ]);
      setPositions(p);
      setOrders(o);
      if (bracketsRes) setBrackets(bracketsRes.brackets);
      if (accsRes) setAccounts(accsRes.accounts);
      // 成交/持仓变化时推进签名,驱动图上交易历史箭头刷新(有变化才刷)
      const sig =
        JSON.stringify(o.map((x) => [x.orderId, x.filled])) +
        JSON.stringify(p.map((x) => [x.instrument, x.quantity]));
      if (sig !== tradeSigRef.current) {
        tradeSigRef.current = sig;
        setTradeSig(sig);
      }
    } catch {
      /* 轮询失败保持旧数据 */
    }
  }, [status, account]);

  useEffect(() => {
    if (status !== 'nt8' || !account) return;
    void refreshTrading();
    const timer = setInterval(() => void refreshTrading(), 500);
    return () => clearInterval(timer);
  }, [status, account, refreshTrading]);

  // ---- widget 图表就绪后再暴露给订单线等逻辑,并追踪合约变化 ----
  const handleWidgetReady = useCallback((w: TradingViewWidget) => {
    w.onChartReady(() => {
      setWidget(w);
      const chart = w.activeChart();
      setChartSymbol(chart.symbol());
      chart.onSymbolChanged().subscribe(null, () => {
        setChartSymbol(chart.symbol());
      });
      // 默认指标:EMA20(图表上没有任何指标时才加,避免重复)
      try {
        const studies = (chart as any).getAllStudies ? (chart as any).getAllStudies() : [];
        if (!studies || studies.length === 0) {
          void (chart as any).createStudy('Moving Average Exponential', false, false, { length: 20 });
        }
      } catch { /* 指标加载失败不影响主流程 */ }
    });
  }, []);

  // ---- 主题应用:<html> 挂类切应用外壳变量;图表用 changeTheme 原地切换 ----
  useEffect(() => {
    document.documentElement.classList.toggle('theme-light', theme === 'light');
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
    if (widget) {
      try { void (widget as any).changeTheme(theme); } catch { /* ignore */ }
    }
  }, [theme, widget]);

  // ---- 设置浮窗拖动(标题栏为手柄) ----
  const onSettingsDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const rect = settingsWinRef.current?.getBoundingClientRect();
    settingsDragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: rect?.left ?? window.innerWidth - 340,
      baseY: rect?.top ?? 56,
    };
    const onMove = (ev: MouseEvent) => {
      const d = settingsDragRef.current;
      if (!d) return;
      const x = Math.min(window.innerWidth - 120, Math.max(0, d.baseX + ev.clientX - d.startX));
      const y = Math.min(window.innerHeight - 60, Math.max(0, d.baseY + ev.clientY - d.startY));
      setSettingsPos({ x, y });
    };
    const onUp = () => {
      const d = settingsDragRef.current;
      settingsDragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (d) {
        setSettingsPos((p) => {
          if (p) { try { localStorage.setItem(SETTINGS_POS_KEY, JSON.stringify(p)); } catch { /* ignore */ } }
          return p;
        });
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  // 合约切换后同步 tickSize / pointValue
  useEffect(() => {
    if (!chartSymbol) return;
    void datafeed.listSymbols().then((symbols) => {
      const found = symbols.find((s) => s.symbol === chartSymbol);
      if (found?.tickSize) setTickSize(found.tickSize);
      setPointValue(resolvePointValue(chartSymbol, found?.pointValue));
    });
  }, [chartSymbol, datafeed]);

  // ---- 图表订单线 ----
  const getMarketPrice = useCallback(
    () => datafeed.getLastPrice(chartSymbol),
    [datafeed, chartSymbol],
  );
  const subscribePrice = useCallback(
    (fn: (symbol: string, price: number) => void) => datafeed.onPriceChange(fn),
    [datafeed],
  );

  useOrderLines({
    widget,
    symbol: chartSymbol,
    account,
    orders,
    positions,
    brackets,
    tickSize,
    pointValue,
    getLastPrice: getMarketPrice,
    subscribePrice,
    theme,
    onChanged: refreshTrading,
  });

  /** 图表交易历史(成交箭头/盈亏连线)显示开关,默认开 */
  const [showTradeHistory, setShowTradeHistory] = useState(
    () => localStorage.getItem('nt8-terminal-show-trades') !== '0',
  );
  const toggleTradeHistory = useCallback(() => {
    setShowTradeHistory((v) => {
      try {
        localStorage.setItem('nt8-terminal-show-trades', v ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !v;
    });
  }, []);

  // ---- 图表交易历史(linetool 箭头 + FIFO 盈亏连线) ----
  useExecutionTrades({
    widget,
    symbol: chartSymbol,
    account: status === 'nt8' ? account : '',
    pointValue,
    refreshKey: tradeSig,
    enabled: showTradeHistory,
  });

  // ---- 右键下单:在图表上右键,按右击价位挂限价/止损单(手数取面板) ----
  const ctxRef = useRef({ status, account, chartSymbol, tickSize, qty, refreshTrading });
  ctxRef.current = { status, account, chartSymbol, tickSize, qty, refreshTrading };
  useEffect(() => {
    if (!widget) return;
    widget.onContextMenu((_unixtime: number, price: number) => {
      const { status: st, account: acc, chartSymbol: sym, tickSize: tick, qty: q } = ctxRef.current;
      if (st !== 'nt8' || !acc || !sym || !(price > 0)) return [];
      const p = roundToTick(price, tick);
      const label = p.toFixed(tickDecimals(tick));
      // 智能判定:右击价低于市价的买单=限价、高于=止损;卖单相反(无市价兜底限价)
      const market = datafeed.getLastPrice(sym);
      const buyKind = detectOrderType('BUY', p, market);
      const sellKind = detectOrderType('SELL', p, market);
      const kindText = (k: 'LIMIT' | 'STOPMARKET') => (k === 'LIMIT' ? '限价' : '止损');
      const place = (action: 'BUY' | 'SELL', kindName: 'LIMIT' | 'STOPMARKET') => () => {
        void nt8Trading
          .placeOrder({
            account: acc,
            symbol: sym,
            action,
            orderType: kindName,
            quantity: q,
            limitPrice: kindName === 'LIMIT' ? p : undefined,
            stopPrice: kindName === 'STOPMARKET' ? p : undefined,
          })
          .then(() => ctxRef.current.refreshTrading())
          .catch((err) => window.alert(err instanceof Error ? err.message : '下单失败'));
      };
      return [
        { position: 'top' as const, text: `买入${kindText(buyKind)} @ ${label} ×${q}`, click: place('BUY', buyKind) },
        { position: 'top' as const, text: `卖出${kindText(sellKind)} @ ${label} ×${q}`, click: place('SELL', sellKind) },
        { text: '-', position: 'top' as const },
      ];
    });
  }, [widget, datafeed]);

  // ---- 草稿模式:基准价(MKT 冻结最新价;LMT/STP 用输入的入场价,实时跟随输入) ----
  useEffect(() => {
    if (mode !== 'draft') return;
    const lp = datafeed.getLastPrice(chartSymbol);
    if (lp) setRefPrice(lp);
  }, [mode, chartSymbol, datafeed]);

  // 草稿 + MKT:止盈止损虚线跟随市价移动(保持金额不变),基准价随 tick 刷新。
  // useDraftLines 同步效应会跳过正在拖拽的线,不与手势冲突
  useEffect(() => {
    if (mode !== 'draft' || kind !== 'MKT') return;
    const sync = () => {
      const lp = datafeed.getLastPrice(chartSymbol);
      if (lp) setRefPrice((cur) => (cur != null && Math.abs(cur - lp) < 1e-9 ? cur : lp));
    };
    sync();
    return datafeed.onPriceChange(sync);
  }, [mode, kind, chartSymbol, datafeed]);

  // 草稿 + LMT/STP:入场价初始化为当前市价(图上生成入场虚线的初始位置)。
  // 仅在"进入该组合"或"切换合约"时初始化一次,不与用户清空输入对抗。
  const draftLmtKeyRef = useRef('');
  useEffect(() => {
    const key = mode === 'draft' && kind === 'LMTSTP' ? chartSymbol : '';
    if (key && draftLmtKeyRef.current !== key && !(parseFloat(limitPrice) > 0)) {
      const lp = datafeed.getLastPrice(chartSymbol);
      if (lp) setLimitPrice(String(roundToTick(lp, tickSize)));
    }
    draftLmtKeyRef.current = key;
  }, [mode, kind, chartSymbol, datafeed, limitPrice, tickSize]);

  const entryPriceNum =
    kind === 'LMTSTP' && parseFloat(limitPrice) > 0
      ? roundToTick(parseFloat(limitPrice), tickSize)
      : null;
  const effectiveRef = kind === 'LMTSTP' ? entryPriceNum : refPrice;

  // ---- 草稿预览虚线(入场/止盈/止损;拖拽反算入场价与金额) ----
  useDraftLines({
    widget,
    symbol: chartSymbol,
    active: mode === 'draft',
    side,
    refPrice: effectiveRef,
    showEntry: kind === 'LMTSTP',
    entryPrice: entryPriceNum,
    qty,
    tickSize,
    pointValue,
    tpAmount,
    slAmount,
    onAmount: (which, amount) =>
      which === 'tp' ? setTpAmount(amount) : setSlAmount(amount),
    onEntryChange: (price) => setLimitPrice(price > 0 ? String(price) : ''),
    theme,
  });

  const refreshRefPrice = useCallback(() => {
    const lp = datafeed.getLastPrice(chartSymbol);
    if (lp) setRefPrice(lp);
  }, [datafeed, chartSymbol]);

  const handleAccountChange = useCallback((name: string) => {
    setAccount(name);
    try { localStorage.setItem(ACCOUNT_KEY, name); } catch { /* ignore */ }
  }, []);

  // ---- 隐藏账户(账户页眼睛开关;localStorage 记忆) ----
  const [hiddenAccounts, setHiddenAccounts] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(HIDDEN_ACCOUNTS_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : [];
    } catch { return []; }
  });
  const toggleHiddenAccount = useCallback((name: string) => {
    setHiddenAccounts((cur) => {
      const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
      try { localStorage.setItem(HIDDEN_ACCOUNTS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // 当前账户被隐藏时,自动切到第一个可见账户(隐藏账户不可选中)
  useEffect(() => {
    if (account && hiddenAccounts.includes(account)) {
      const firstVisible = accounts.find((a) => !hiddenAccounts.includes(a.name));
      if (firstVisible) handleAccountChange(firstVisible.name);
    }
  }, [account, accounts, hiddenAccounts, handleAccountChange]);

  // ---- 分隔条拖拽 ----
  const onDividerDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragState.current = { startX: e.clientX, startWidth: panelWidth };
      const onMove = (ev: MouseEvent) => {
        if (!dragState.current) return;
        const delta = dragState.current.startX - ev.clientX;
        const w = Math.min(640, Math.max(280, dragState.current.startWidth + delta));
        setPanelWidth(w);
      };
      const onUp = () => {
        if (dragState.current) {
          try { localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidth)); } catch { /* ignore */ }
        }
        dragState.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [panelWidth],
  );

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--tv-bg)]">
      {/* 图表区 */}
      <div className="relative min-w-0 flex-1">
        {defaultSymbol ? (
          <TvAdvancedChart
            datafeed={datafeed}
            symbol={defaultSymbol}
            theme={theme}
            onWidgetReady={handleWidgetReady}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[var(--tv-muted)]">
            正在初始化数据源…
          </div>
        )}

        {/* NT8 已连接但合约列表为空的提示 */}
        {symbolsEmpty && status === 'nt8' && (
          <div className="absolute left-1/2 top-12 z-50 -translate-x-1/2 rounded-md border border-[#f0b90b]/40 bg-[var(--tv-panel)]/95 px-4 py-2 text-xs text-[#f0b90b] shadow-lg">
            NT8 已连接,但合约列表为空:请检查 TvBridgeAddOn.cs 的 Watchlist
            是否为当前主力合约(注意换月),或直接在图表搜索框输入合约名(如 ES 09-26)。
          </div>
        )}

        {/* 悬浮状态面板 */}
        <div className="absolute right-3 top-2 z-50 flex items-center gap-2 rounded-md border border-[var(--tv-border)] bg-[var(--tv-panel)]/95 px-2 py-1.5 shadow-lg backdrop-blur">
          {status === 'connecting' && (
            <Badge variant="outline" className="border-[var(--tv-border)] text-[var(--tv-text)]">
              正在连接数据桥…
            </Badge>
          )}
          {status === 'nt8' && (
            <Badge className="border-transparent bg-[#26a69a]/15 text-[#26a69a] hover:bg-[#26a69a]/15">
              NT8 已连接{nt8Info?.connectionName ? ` · ${nt8Info.connectionName}` : ''}
            </Badge>
          )}
          {status === 'mock' && (
            <Badge className="border-transparent bg-[#f0b90b]/15 text-[#f0b90b] hover:bg-[#f0b90b]/15">
              模拟数据(未检测到 NT8)
            </Badge>
          )}

          <Button
            variant="ghost"
            size="icon"
            className={`h-7 w-7 hover:bg-[var(--tv-border)] ${
              showTradeHistory ? 'text-[#2962ff]' : 'text-[var(--tv-muted)]'
            }`}
            title={showTradeHistory ? '隐藏交易历史' : '显示交易历史'}
            onClick={toggleTradeHistory}
          >
            <History className="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-[var(--tv-text)] hover:bg-[var(--tv-border)]"
            title="重新连接数据桥"
            onClick={() => void connect()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-[var(--tv-text)] hover:bg-[var(--tv-border)]"
            title={theme === 'dark' ? '切换为白天模式' : '切换为黑夜模式'}
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-[var(--tv-text)] hover:bg-[var(--tv-border)]"
            title="数据桥设置"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* 数据桥设置浮窗(可拖动:标题栏为手柄,非模态不挡图表) */}
        {settingsOpen && (
          <div
            ref={settingsWinRef}
            className="fixed z-[100] w-80 rounded-md border border-[var(--tv-border)] bg-[var(--tv-panel)] text-[var(--tv-text)] shadow-xl"
            style={
              settingsPos
                ? { left: settingsPos.x, top: settingsPos.y }
                : { right: 16, top: 56 }
            }
          >
            <div
              onMouseDown={onSettingsDragStart}
              className="flex cursor-move items-center justify-between border-b border-[var(--tv-border)] px-3 py-2 select-none"
              title="按住拖动"
            >
              <span className="text-sm font-semibold">数据桥设置</span>
              <button
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setSettingsOpen(false)}
                className="rounded p-0.5 text-[var(--tv-muted)] hover:bg-[var(--tv-border)] hover:text-[var(--tv-text)]"
                title="关闭"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="p-3">
              <p className="mb-2 text-xs text-[var(--tv-muted)]">
                NinjaTrader 8 数据桥 AddOn 的 HTTP 地址,默认为{' '}
                {DEFAULT_BRIDGE_URL_DISPLAY}。修改后请点击"保存并重连"。
              </p>
              <Input
                value={bridgeUrlDraft}
                onChange={(e) => setBridgeUrlDraft(e.target.value)}
                placeholder={DEFAULT_BRIDGE_URL_DISPLAY}
                className="border-[var(--tv-border)] bg-[var(--tv-bg)] text-[var(--tv-text)]"
              />
              <div className="mt-3 flex justify-end">
                <Button
                  onClick={() => {
                    setBridgeUrl(bridgeUrlDraft);
                    setSettingsOpen(false);
                    void connect();
                  }}
                >
                  保存并重连
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 分隔条 */}
      <div
        onMouseDown={onDividerDown}
        className="w-1 shrink-0 cursor-col-resize bg-[var(--tv-border)] transition-colors hover:bg-[#2962ff]"
        title="拖拽调整面板宽度"
      />

      {/* 交易面板 */}
      <div
        style={{ width: panelWidth }}
        className="shrink-0 border-l border-[var(--tv-border)]"
      >
        <TradingPanel
          enabled={status === 'nt8'}
          symbol={chartSymbol}
          tickSize={tickSize}
          accounts={accounts}
          account={account}
          onAccountChange={handleAccountChange}
          hiddenAccounts={hiddenAccounts}
          onToggleHidden={toggleHiddenAccount}
          positions={positions}
          orders={orders}
          onChanged={refreshTrading}
          mode={mode}
          onModeChange={setMode}
          side={side}
          onSideChange={setSide}
          kind={kind}
          onKindChange={setKind}
          qty={qty}
          onQtyChange={setQty}
          limitPrice={limitPrice}
          onLimitPriceChange={setLimitPrice}
          tpAmount={tpAmount}
          onTpAmountChange={setTpAmount}
          slAmount={slAmount}
          onSlAmountChange={setSlAmount}
          pointValue={pointValue}
          refPrice={effectiveRef}
          onRefreshRef={refreshRefPrice}
          getMarketPrice={getMarketPrice}
        />
      </div>
    </div>
  );
}
