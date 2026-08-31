import { useCallback, useEffect, useRef, useState } from 'react';
import { GripVertical, History, Moon, RefreshCw, Settings, Sun, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import TvAdvancedChart from '@/components/TvAdvancedChart';
import SymbolFavorites from '@/components/SymbolFavorites';
import TradingPanel, { type OrderKind } from '@/sections/TradingPanel';
import ReplayBar from '@/sections/ReplayBar';
import { useOrderLines } from '@/hooks/useOrderLines';
import { useDraftLines } from '@/hooks/useDraftLines';
import { useExecutionTrades } from '@/hooks/useExecutionTrades';
import { useDraggable } from '@/hooks/useDraggable';
import { detectOrderType, resolvePointValue, roundToTick, tickDecimals, type DraftSide } from '@/lib/draftCalc';
import { getBridgeUrl, setBridgeUrl, DEFAULT_BRIDGE_URL_DISPLAY } from '@/lib/config';
import { createMockAdapter } from '@/lib/mockFeed';
import { checkNt8Status, createNt8Adapter, type Nt8Status } from '@/lib/nt8Bridge';
import { nt8Trading, type Nt8Account, type Nt8Bracket, type Nt8Order, type Nt8Position } from '@/lib/nt8Trading';
import { ReplaySession } from '@/lib/replaySession';
import { SimTrading, SIM_ACCOUNT } from '@/lib/simTrading';
import { setTradingBackend, trading } from '@/lib/tradingRouter';
import { TvDatafeed } from '@/lib/tvDatafeed';
import type { FeedAdapter } from '@/types/market';

type FeedStatus = 'connecting' | 'nt8' | 'mock';

/** 回放调试追踪(与 replaySession 共用 window.__rpLog;控制台 `__rpLog` 查看) */
function rpTrace(method: string, detail?: unknown): void {
  try {
    const w = window as unknown as { __rpLog?: { m: string; t: string; d: unknown }[] };
    if (!w.__rpLog) w.__rpLog = [];
    w.__rpLog.push({ m: method, t: new Date().toISOString(), d: detail ?? null });
    if (w.__rpLog.length > 300) w.__rpLog.shift();
  } catch {
    /* ignore */
  }
}

const ACCOUNT_KEY = 'nt8-terminal-account';
const PANEL_WIDTH_KEY = 'nt8-terminal-panel-width';
const THEME_KEY = 'nt8-terminal-theme';
const SETTINGS_POS_KEY = 'nt8-terminal-settings-pos';
const STATUS_POS_KEY = 'nt8-terminal-status-pos';
const REPLAY_STEP_KEY = 'nt8-terminal-replay-step';
/** 回放步长选项(秒):1/5/15/30 分钟、1 小时、1 天 */
const REPLAY_STEP_OPTIONS = [60, 300, 900, 1800, 3600, 86400];
const HIDDEN_ACCOUNTS_KEY = 'nt8-terminal-hidden-accounts';
const SYMBOL_KEY = 'nt8-terminal-symbol';
const INTERVAL_KEY = 'nt8-terminal-interval';
const QTY_KEY = 'nt8-terminal-qty';
const KIND_KEY = 'nt8-terminal-kind';

export default function ChartTerminal() {
  const [datafeed] = useState(() => new TvDatafeed(createMockAdapter()));
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const [nt8Info, setNt8Info] = useState<Nt8Status | null>(null);
  const [defaultSymbol, setDefaultSymbol] = useState<string>(() => {
    // 界面缓存:恢复上次的合约(不在合约列表里时启动逻辑会回退到主力合约)
    try { return localStorage.getItem(SYMBOL_KEY) || ''; } catch { return ''; }
  });
  /** 界面缓存:上次图表周期(只在创建 widget 时读取,切周期不重建图表) */
  const [initialInterval] = useState(() => {
    try { return localStorage.getItem(INTERVAL_KEY) || '1'; } catch { return '1'; }
  });
  const [bridgeUrlDraft, setBridgeUrlDraft] = useState(getBridgeUrl());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [symbolsEmpty, setSymbolsEmpty] = useState(false);

  // ---- 白天/黑夜主题(图表 + 应用外壳;localStorage 记忆) ----
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });

  // ---- 浮窗拖拽(设置浮窗 + 状态面板;位置记忆,useDraggable 统一实现) ----
  const settingsDrag = useDraggable(SETTINGS_POS_KEY);
  const statusDrag = useDraggable(STATUS_POS_KEY);

  // ---- 交易状态 ----
  const [widget, setWidget] = useState<TradingViewWidget | null>(null);
  /** widget 的 ref 镜像:onAdapterSwapped 等"只注册一次"的回调闭包会捕获到过期的 state,必须用 ref 取 */
  const widgetRef = useRef<TradingViewWidget | null>(null);
  /** 订单成交/持仓签名:变化时刷新图表交易历史箭头 */
  const tradeSigRef = useRef('');
  const [tradeSig, setTradeSig] = useState('');
  const [chartSymbol, setChartSymbol] = useState('');
  /** 图表周期纪元:onIntervalChanged 时 +1,驱动草稿线重建 */
  const [chartEpoch, setChartEpoch] = useState(0);
  const [tickSize, setTickSize] = useState(0.25);
  const [accounts, setAccounts] = useState<Nt8Account[]>([]);
  const [account, setAccount] = useState(() => {
    try { return localStorage.getItem(ACCOUNT_KEY) || ''; } catch { return ''; }
  });
  const [positions, setPositions] = useState<Nt8Position[]>([]);
  const [orders, setOrders] = useState<Nt8Order[]>([]);
  /** 持仓/订单轮询最近一次错误(面板顶部红条提示;成功即清除) */
  const [pollError, setPollError] = useState<string | null>(null);
  /** 待触发括号单(入场单未成交时的预设止盈/止损价) */
  const [brackets, setBrackets] = useState<Nt8Bracket[]>([]);

  // ---- 交易/草稿模式与票据状态(草稿线 hook 与面板共享) ----
  const [mode, setMode] = useState<'trade' | 'draft'>('trade');
  const [side, setSide] = useState<DraftSide>('BUY');
  const [kind, setKind] = useState<OrderKind>(() => {
    // 界面缓存:恢复上次的单类型
    try { return localStorage.getItem(KIND_KEY) === 'LMTSTP' ? 'LMTSTP' : 'MKT'; } catch { return 'MKT'; }
  });
  const [qty, setQty] = useState(() => {
    // 界面缓存:恢复上次的手数
    try { return Math.max(1, parseInt(localStorage.getItem(QTY_KEY) || '', 10) || 1); } catch { return 1; }
  });
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

  // ---- 历史回放 + 模拟交易(回放状态刻意不进 localStorage,刷新即回实盘) ----
  const [replayActive, setReplayActive] = useState(false);
  const [replayCursor, setReplayCursor] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  /** 步长(行情时间秒):单步/播放每次推进的市场时间跨度;localStorage 记忆 */
  const [replayStepSec, setReplayStepSec] = useState(() => {
    try {
      const v = parseInt(localStorage.getItem(REPLAY_STEP_KEY) || '', 10);
      return REPLAY_STEP_OPTIONS.includes(v) ? v : 60;
    } catch {
      return 60;
    }
  });
  /** 当前活跃的数据适配器(进入回放时被 ReplaySession 包装,退出时还原) */
  const adapterRef = useRef<FeedAdapter | null>(null);
  const sessionRef = useRef<ReplaySession | null>(null);
  /** 进入回放前的真实账户,退出时恢复 */
  const prevAccountRef = useRef('');

  // ---- 隐藏账户(账户页眼睛开关;localStorage 记忆) ----
  // (位置需在 connect 之前:connect/refreshTrading 引用 pruneHiddenAccounts,块级声明不能前向引用)
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

  /** 隐藏列表跟随最新账户数据:已不存在于 NT8 的账户(如已关闭)从隐藏列表清掉 */
  const pruneHiddenAccounts = useCallback((fresh: Nt8Account[]) => {
    const names = new Set(fresh.map((a) => a.name));
    setHiddenAccounts((cur) => {
      const next = cur.filter((n) => names.has(n));
      if (next.length !== cur.length) {
        try { localStorage.setItem(HIDDEN_ACCOUNTS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      }
      return next;
    });
  }, []);

  const connect = useCallback(async () => {
    // 重连前先退出回放:后端与数据适配器都要重建
    if (sessionRef.current) {
      sessionRef.current = null;
      setTradingBackend(null);
      setReplayActive(false);
      setReplayPlaying(false);
    }
    setStatus('connecting');
    setSymbolsEmpty(false);
    const st = await checkNt8Status();
    setNt8Info(st);
    const adapter = st ? createNt8Adapter() : createMockAdapter();
    adapterRef.current = adapter;
    datafeed.setAdapter(adapter);
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
        pruneHiddenAccounts(accs);
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
      // 注意用 widgetRef:本 effect 只在挂载时跑一次,闭包里的 widget state 永远是 null
      const w = widgetRef.current;
      if (w) w.onChartReady(() => {
        const chart = w.activeChart() as unknown as { resetCache?: () => void; resetData: () => void };
        // 库会按请求参数缓存 datafeed 响应:必须先 resetCache 再 resetData,
        // 否则换 adapter 后吃到的是旧缓存(表现为 resetData 后完全没有新请求)
        try { chart.resetCache?.(); } catch { /* ignore */ }
        chart.resetData();
      });
    };
    void connect();
  }, [connect, datafeed]);

  // ---- 交易数据轮询(0.5 秒;桥端是轻量快照,直连本地开销极低;回放期间走模拟引擎) ----
  const refreshTrading = useCallback(async () => {
    if ((status !== 'nt8' && !sessionRef.current) || !account) return;
    try {
      // brackets 端点依赖桥端升级(F5);未升级时单独容错,不拖垮订单/持仓轮询
      const [{ positions: p }, { orders: o }, bracketsRes, accsRes] = await Promise.all([
        trading.getPositions(account),
        trading.getOrders(account),
        trading.getBrackets(account).catch(() => null),
        // 账户余额/盈亏(账户信息页用);失败不影响其他数据
        trading.getAccounts().catch(() => null),
      ]);
      setPositions(p);
      setOrders(o);
      if (bracketsRes) setBrackets(bracketsRes.brackets);
      if (accsRes) {
        setAccounts(accsRes.accounts);
        // 回放期间轮询返回的是模拟账户,不能拿它清理真实账户的隐藏偏好
        if (!sessionRef.current) pruneHiddenAccounts(accsRes.accounts);
      }
      // 成交/持仓变化时推进签名,驱动图上交易历史箭头刷新(有变化才刷)
      const sig =
        JSON.stringify(o.map((x) => [x.orderId, x.filled])) +
        JSON.stringify(p.map((x) => [x.instrument, x.quantity]));
      if (sig !== tradeSigRef.current) {
        tradeSigRef.current = sig;
        setTradeSig(sig);
      }
      setPollError(null);
    } catch (err) {
      /* 轮询失败保持旧数据,但在面板上提示,避免"持仓不显示"无从下手 */
      setPollError(err instanceof Error ? err.message : '桥连接失败');
    }
  }, [status, account, pruneHiddenAccounts]);

  useEffect(() => {
    if ((status !== 'nt8' && !replayActive) || !account) return;
    void refreshTrading();
    const timer = setInterval(() => void refreshTrading(), 500);
    return () => clearInterval(timer);
  }, [status, account, refreshTrading, replayActive]);

  // ---- 回放进入/退出/步进 ----
  // 注意:进出回放通过 key 翻转重建图表 widget,而不是 resetData——
  // 实测本版库 resetData 不会重拉数据(实现为 mainSeries().rerequestData(),
  // 且 d.ts 声称的 resetCache 在运行时不存在);重建 widget 干净利落,
  // 图上绘图由各 hook 从状态重建
  const exitReplay = useCallback(() => {
    sessionRef.current = null;
    setTradingBackend(null);
    setReplayPlaying(false);
    setWidget(null);
    if (adapterRef.current) datafeed.setAdapter(adapterRef.current);
    setReplayActive(false);
    setAccount((cur) => (cur === SIM_ACCOUNT ? prevAccountRef.current : cur));
  }, [datafeed]);

  const enterReplay = useCallback(
    (startSec: number) => {
      const base = adapterRef.current;
      if (!base || !widget || sessionRef.current) return;
      const session = new ReplaySession(base, startSec);
      const sim = new SimTrading({
        getLastPrice: (s) => datafeed.getLastPrice(s),
        pointValueOf: (s) => (s === chartSymbol ? pointValue : resolvePointValue(s)),
        getCursorTime: () => session.getCursor(),
      });
      session.onBarRevealed((sym, _intervalSec, bar) => {
        sim.onBar(sym, bar);
        setReplayCursor(session.getCursor());
      });
      sessionRef.current = session;
      setTradingBackend(sim);
      prevAccountRef.current = account;
      setAccount(SIM_ACCOUNT);
      setReplayCursor(startSec);
      setWidget(null);
      rpTrace('ui.enterReplay', { startSec });
      datafeed.setAdapter(session); // 先切适配器,再翻转 key 重建图表(直接在回放数据上初始化)
      setReplayPlaying(false);
      setReplayActive(true);
    },
    [widget, datafeed, chartSymbol, pointValue, account],
  );

  const stepReplayAsync = useCallback((): Promise<boolean> => {
    const s = sessionRef.current;
    rpTrace('ui.step', { hasSession: !!s, stepSec: stepSecRef.current });
    if (!s) return Promise.resolve(false);
    return s.step(stepSecRef.current).then((ok) => {
      if (!ok) setReplayPlaying(false); // 到数据尽头自动停播
      return ok;
    });
  }, []);

  /** stepReplayAsync 里读步长:ref 镜像保证播放定时器闭包拿到的是最新值 */
  const stepSecRef = useRef(60);
  stepSecRef.current = replayStepSec;

  const stepReplay = useCallback(() => {
    void stepReplayAsync();
  }, [stepReplayAsync]);

  // 界面缓存:记忆步长选择
  useEffect(() => {
    try {
      localStorage.setItem(REPLAY_STEP_KEY, String(replayStepSec));
    } catch {
      /* ignore */
    }
  }, [replayStepSec]);

  // 调试钩子:window.__replay(回放控制)/__trading(交易后端路由),同决策 12 的调试约定
  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__replay = {
      enter: enterReplay,
      step: stepReplayAsync,
      exit: exitReplay,
      status: () => ({ active: replayActive, playing: replayPlaying, cursor: sessionRef.current?.getCursor() ?? 0 }),
    };
    w.__trading = trading;
    return () => {
      delete w.__replay;
      delete w.__trading;
    };
  }, [enterReplay, stepReplayAsync, exitReplay, replayActive, replayPlaying]);

  // 连续播放:按速度驱动 step
  useEffect(() => {
    rpTrace('ui.playEffect', { active: replayActive, playing: replayPlaying, speed: replaySpeed });
    if (!replayActive || !replayPlaying) return;
    const timer = setInterval(() => {
      void stepReplayAsync();
    }, 1000 / replaySpeed);
    return () => clearInterval(timer);
  }, [replayActive, replayPlaying, replaySpeed, stepReplayAsync]);

  // ---- widget 图表就绪后再暴露给订单线等逻辑,并追踪合约变化 ----
  const handleWidgetReady = useCallback((w: TradingViewWidget) => {
    widgetRef.current = w;
    w.onChartReady(() => {
      setWidget(w);
      const chart = w.activeChart();
      setChartSymbol(chart.symbol());
      chart.onSymbolChanged().subscribe(null, () => {
        setChartSymbol(chart.symbol());
      });
      // 界面缓存:周期变化即记忆,下次启动恢复
      // (注意:本版库没有 chart.interval(),只能从事件参数取)
      chart.onIntervalChanged().subscribe(null, (interval: string) => {
        try { localStorage.setItem(INTERVAL_KEY, interval); } catch { /* ignore */ }
        // 周期纪元 +1:草稿虚线整体重建,避免库在切周期时残留旧线
        setChartEpoch((n) => n + 1);
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

  // ---- 界面缓存:合约/单类型/手数 变化即写 localStorage ----
  useEffect(() => {
    if (chartSymbol) try { localStorage.setItem(SYMBOL_KEY, chartSymbol); } catch { /* ignore */ }
  }, [chartSymbol]);
  useEffect(() => {
    try { localStorage.setItem(KIND_KEY, kind); } catch { /* ignore */ }
  }, [kind]);
  useEffect(() => {
    try { localStorage.setItem(QTY_KEY, String(qty)); } catch { /* ignore */ }
  }, [qty]);

  // ---- 主题应用:<html> 挂类切应用外壳变量;图表用 changeTheme 原地切换 ----
  useEffect(() => {
    document.documentElement.classList.toggle('theme-light', theme === 'light');
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
    if (widget) {
      try { void (widget as any).changeTheme(theme); } catch { /* ignore */ }
    }
  }, [theme, widget]);

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
    account: status === 'nt8' || replayActive ? account : '',
    pointValue,
    refreshKey: tradeSig,
    enabled: showTradeHistory,
  });

  // ---- 右键下单:在图表上右键,按右击价位挂限价/止损单(手数取面板;回放时进模拟引擎) ----
  const ctxRef = useRef({ status, account, chartSymbol, tickSize, qty, refreshTrading, replayActive });
  ctxRef.current = { status, account, chartSymbol, tickSize, qty, refreshTrading, replayActive };
  useEffect(() => {
    if (!widget) return;
    widget.onContextMenu((_unixtime: number, price: number) => {
      const { status: st, account: acc, chartSymbol: sym, tickSize: tick, qty: q, replayActive: rp } = ctxRef.current;
      if ((st !== 'nt8' && !rp) || !acc || !sym || !(price > 0)) return [];
      const p = roundToTick(price, tick);
      const label = p.toFixed(tickDecimals(tick));
      // 智能判定:右击价低于市价的买单=限价、高于=止损;卖单相反(无市价兜底限价)
      const market = datafeed.getLastPrice(sym);
      const buyKind = detectOrderType('BUY', p, market);
      const sellKind = detectOrderType('SELL', p, market);
      const kindText = (k: 'LIMIT' | 'STOPMARKET') => (k === 'LIMIT' ? '限价' : '止损');
      const place = (action: 'BUY' | 'SELL', kindName: 'LIMIT' | 'STOPMARKET') => () => {
        void trading
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
    epoch: chartEpoch,
  });

  const refreshRefPrice = useCallback(() => {
    const lp = datafeed.getLastPrice(chartSymbol);
    if (lp) setRefPrice(lp);
  }, [datafeed, chartSymbol]);

  const handleAccountChange = useCallback((name: string) => {
    setAccount(name);
    try { localStorage.setItem(ACCOUNT_KEY, name); } catch { /* ignore */ }
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
            key={replayActive ? 'replay' : 'live'}
            datafeed={datafeed}
            symbol={defaultSymbol}
            initialInterval={initialInterval}
            theme={theme}
            onWidgetReady={handleWidgetReady}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[var(--tv-muted)]">
            正在初始化数据源…
          </div>
        )}

        {/* 常用合约收藏栏(顶部居中) */}
        <div className="absolute left-1/2 top-2 z-40 -translate-x-1/2">
          <SymbolFavorites
            listSymbols={() => datafeed.listSymbols()}
            current={chartSymbol}
            onSelect={(s) => {
              const w = widgetRef.current;
              if (!w) return;
              w.onChartReady(() => {
                try {
                  w.activeChart().setSymbol(s);
                } catch {
                  /* 合约解析失败时图表保持原样 */
                }
              });
            }}
          />
        </div>

        {/* NT8 已连接但合约列表为空的提示 */}
        {symbolsEmpty && status === 'nt8' && (
          <div className="absolute left-1/2 top-12 z-50 -translate-x-1/2 rounded-md border border-[#f0b90b]/40 bg-[var(--tv-panel)]/95 px-4 py-2 text-xs text-[#f0b90b] shadow-lg">
            NT8 已连接,但合约库为空:请在 NT8 中确认合约已加载,
            或直接在图表搜索框输入合约名(如 NQ SEP26)。
          </div>
        )}

        {/* 回放控制条(左上浮条;进入后下单走模拟引擎) */}
        <ReplayBar
          active={replayActive}
          cursor={replayCursor}
          playing={replayPlaying}
          speed={replaySpeed}
          stepSec={replayStepSec}
          onStart={enterReplay}
          onStep={stepReplay}
          onTogglePlay={() => setReplayPlaying((v) => !v)}
          onSpeedChange={setReplaySpeed}
          onStepSecChange={setReplayStepSec}
          onExit={exitReplay}
        />

        {/* 悬浮状态面板(左侧把手可拖动,位置记忆) */}
        <div
          data-draggable-panel
          style={statusDrag.pos ? { left: statusDrag.pos.x, top: statusDrag.pos.y, right: 'auto' } : undefined}
          className="absolute right-3 top-2 z-50 flex items-center gap-2 rounded-md border border-[var(--tv-border)] bg-[var(--tv-panel)]/95 px-2 py-1.5 shadow-lg backdrop-blur"
        >
          <span
            className="cursor-move text-[var(--tv-muted)] hover:text-[var(--tv-text)]"
            title="按住拖动"
            onMouseDown={statusDrag.onHandleMouseDown}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </span>
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
            data-draggable-panel
            className="fixed z-[100] w-80 rounded-md border border-[var(--tv-border)] bg-[var(--tv-panel)] text-[var(--tv-text)] shadow-xl"
            style={
              settingsDrag.pos
                ? { left: settingsDrag.pos.x, top: settingsDrag.pos.y }
                : { right: 16, top: 56 }
            }
          >
            <div
              onMouseDown={settingsDrag.onHandleMouseDown}
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
          enabled={status === 'nt8' || replayActive}
          symbol={chartSymbol}
          tickSize={tickSize}
          accounts={accounts}
          account={account}
          onAccountChange={handleAccountChange}
          hiddenAccounts={hiddenAccounts}
          onToggleHidden={toggleHiddenAccount}
          positions={positions}
          orders={orders}
          pollError={pollError}
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
