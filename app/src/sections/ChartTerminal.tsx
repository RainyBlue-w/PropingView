import { useCallback, useEffect, useRef, useState } from 'react';
import { Columns2, Grid2X2, GripVertical, History, Moon, PanelRight, Play, RefreshCw, Settings, Square, Sun, Wallet, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import ChartWorkspace, { type ChartWorkspaceHandle } from '@/components/ChartWorkspace';
import SymbolFavorites from '@/components/SymbolFavorites';
import MobileNavigation from '@/components/MobileNavigation';
import BridgeConnectionStatus from '@/components/BridgeConnectionStatus';
import TradingPanel, { type OrderKind } from '@/sections/TradingPanel';
import AccountPages from '@/sections/AccountPages';
import CopyTradingPage from '@/sections/CopyTradingPage';
import ReplayBar from '@/sections/ReplayBar';
import ReplayDashboard from '@/sections/ReplayDashboard';
import { createReplaySession, deleteReplaySession, loadReplaySessions, saveReplaySession, type ReplaySession as SavedReplaySession, type NewReplaySessionInput } from '@/lib/replayStore';
import { startHistorySync } from '@/lib/historyStore';
import { rememberTradeAccounts } from '@/lib/tradeHistoryFilters';
import { useDraftLines } from '@/hooks/useDraftLines';
import { useDraggable } from '@/hooks/useDraggable';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useMobilePanelHeight } from '@/hooks/useMobilePanelHeight';
import { resolvePointValue, roundToTick, type DraftSide } from '@/lib/draftCalc';
import { getBridgeUrl, setBridgeUrl, defaultBridgeUrl, bridgeProviderName, bridgeStorageKey, getProvider, setProvider, type BridgeProvider } from '@/lib/config';
import { createMockAdapter } from '@/lib/mockFeed';
import { checkNt8Status, createNt8Adapter, type Nt8Status } from '@/lib/nt8Bridge';
import { BRIDGE_PROVIDERS, nt8Trading, type Nt8Account, type Nt8Bracket, type Nt8Order, type Nt8Position } from '@/lib/nt8Trading';
import { migrateLegacyAccount, parseBridgeAccount } from '@/lib/bridgeAccounts';
import { ReplaySession } from '@/lib/replaySession';
import { loadReplayFeed } from '@/lib/replayFeed';
import { SimTrading, SIM_ACCOUNT } from '@/lib/simTrading';
import { setTradingBackend, trading } from '@/lib/tradingRouter';
import { TvDatafeed } from '@/lib/tvDatafeed';
import type { FeedAdapter, SymbolInfo } from '@/types/market';

type FeedStatus = 'connecting' | 'live' | 'mock';

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
const SYMBOL_SEARCH_POS_KEY = 'nt8-terminal-symbol-search-pos';
const REPLAY_STEP_KEY = 'nt8-terminal-replay-step';
/** 回放步长选项(秒):1/5/15/30 分钟、1 小时、1 天 */
const REPLAY_STEP_OPTIONS = [60, 300, 900, 1800, 3600, 86400];
const HIDDEN_ACCOUNTS_KEY = 'nt8-terminal-hidden-accounts';
const INTERVAL_KEY = 'nt8-terminal-interval';
const QTY_KEY = 'nt8-terminal-qty';
const KIND_KEY = 'nt8-terminal-kind';
const CHART_COUNT_KEY = 'nt8-terminal-chart-count';
const TRADING_PANEL_KEY = 'nt8-terminal-trading-panel-open';
const ACCOUNT_PANEL_KEY = 'nt8-terminal-account-panel-open';

function panelIsOpen(key: string): boolean {
  try { return localStorage.getItem(key) !== '0'; } catch { return true; }
}

export default function ChartTerminal() {
  const [provider, setQuoteProvider] = useState<BridgeProvider>(getProvider);
  const providerName = bridgeProviderName(provider);
  const symbolKey = bridgeStorageKey('nt8-terminal-symbol', provider);
  const connectionGeneration = useRef(0);
  const quoteSwitchGeneration = useRef(0);
  const initialAccountSource = useRef(false);
  const [bridgeStatuses, setBridgeStatuses] = useState<Partial<Record<BridgeProvider, Nt8Status | null>>>({});
  const [page, setPage] = useState<'chart' | 'overview' | 'records' | 'replay' | 'copy'>('chart');
  const compact = useMediaQuery('(max-width: 1023px)');
  // 手机在图表下方打开一个紧凑面板；不覆盖桌面双面板的打开状态与宽度偏好。
  const [mobilePanel, setMobilePanel] = useState<'trading' | 'account' | 'replay' | null>(null);
  const [datafeed] = useState(() => new TvDatafeed(createMockAdapter()));
  const listSearchSymbols = useCallback(() => datafeed.listSymbols(true), [datafeed]);
  const resolveSearchSymbol = useCallback((symbol: string) => datafeed.lookupSymbol(symbol), [datafeed]);
  const [feedGeneration, setFeedGeneration] = useState(0);
  const [chartCount, setChartCount] = useState<1 | 2 | 4>(() => {
    try { const value = Number(localStorage.getItem(CHART_COUNT_KEY)); return value === 2 || value === 4 ? value : 1; }
    catch { return 1; }
  });
  const [showTradingPanel, setShowTradingPanel] = useState(() => panelIsOpen(TRADING_PANEL_KEY));
  const [showAccountPanel, setShowAccountPanel] = useState(() => panelIsOpen(ACCOUNT_PANEL_KEY));
  useEffect(() => {
    try {
      localStorage.setItem(CHART_COUNT_KEY, String(chartCount));
      localStorage.setItem(TRADING_PANEL_KEY, showTradingPanel ? '1' : '0');
      localStorage.setItem(ACCOUNT_PANEL_KEY, showAccountPanel ? '1' : '0');
    } catch { /* Preferences remain usable without browser storage. */ }
  }, [chartCount, showTradingPanel, showAccountPanel]);
  const [status, setStatus] = useState<FeedStatus>('connecting');
  const [defaultSymbol, setDefaultSymbol] = useState<string>(() => {
    // 界面缓存:恢复上次的合约(不在合约列表里时启动逻辑会回退到主力合约)
    try { return localStorage.getItem(symbolKey) || ''; } catch { return ''; }
  });
  /** 界面缓存:上次图表周期(只在创建 widget 时读取,切周期不重建图表) */
  const [initialInterval] = useState(() => {
    try { return localStorage.getItem(INTERVAL_KEY) || '1'; } catch { return '1'; }
  });
  const [bridgeUrlDraft, setBridgeUrlDraft] = useState(() => ({ nt8: getBridgeUrl('nt8'), atas: getBridgeUrl('atas') }));
  const [providerDraft, setProviderDraft] = useState<BridgeProvider>(provider);
  const [savingBridge, setSavingBridge] = useState(false);
  const [bridgeSettingsError, setBridgeSettingsError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [symbolsEmpty, setSymbolsEmpty] = useState(false);

  // ---- 白天/黑夜主题(图表 + 应用外壳;localStorage 记忆) ----
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
  });

  // ---- 合约搜索与设置位置；常用工具固定在页面右上角 ----
  const settingsDrag = useDraggable(SETTINGS_POS_KEY);
  const symbolSearchDrag = useDraggable(SYMBOL_SEARCH_POS_KEY);

  // ---- 交易状态 ----
  const [widget, setWidget] = useState<TradingViewWidget | null>(null);
  /** widget 的 ref 镜像:onAdapterSwapped 等"只注册一次"的回调闭包会捕获到过期的 state,必须用 ref 取 */
  const widgetRef = useRef<TradingViewWidget | null>(null);
  const workspaceRef = useRef<ChartWorkspaceHandle | null>(null);
  const unbindActiveWidget = useRef<() => void>(() => {});
  /** 订单成交/持仓签名:变化时刷新图表交易历史箭头 */
  const tradeSigRef = useRef('');
  const [tradeSig, setTradeSig] = useState('');
  const [chartSymbol, setChartSymbol] = useState('');
  /** 图表周期纪元:onIntervalChanged 时 +1,驱动草稿线重建 */
  const [chartEpoch, setChartEpoch] = useState(0);
  const [tickSize, setTickSize] = useState(0.25);
  const [accounts, setAccounts] = useState<Nt8Account[]>([]);
  const [liveAccounts, setLiveAccounts] = useState<Nt8Account[]>([]);
  const [liveAccountsError, setLiveAccountsError] = useState<string | null>(null);
  const [knownSymbols, setKnownSymbols] = useState<SymbolInfo[]>([]);
  const [replaySymbolInfo, setReplaySymbolInfo] = useState<SymbolInfo | null>(null);
  const knownSymbolsRef = useRef(knownSymbols);
  knownSymbolsRef.current = replaySymbolInfo ? [replaySymbolInfo] : knownSymbols;
  const [account, setAccount] = useState(() => {
    try { return migrateLegacyAccount(localStorage.getItem(ACCOUNT_KEY) || ''); } catch { return ''; }
  });
  const [positions, setPositions] = useState<Nt8Position[]>([]);
  const [orders, setOrders] = useState<Nt8Order[]>([]);
  /** 持仓/订单轮询最近一次错误(面板顶部红条提示;成功即清除) */
  const [pollError, setPollError] = useState<string | null>(null);
  /** 待触发括号单(入场单未成交时的预设止盈/止损价) */
  const [brackets, setBrackets] = useState<Nt8Bracket[]>([]);
  const accountProvider = parseBridgeAccount(account).provider;
  const accountConnected = !!bridgeStatuses[accountProvider]?.connected;
  const liveTradingEnabled = accountConnected && bridgeStatuses[accountProvider]?.tradingSupported !== false && provider === accountProvider && status === 'live';

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
  const dragState = useRef<{ startX: number; startWidth: number; width: number } | null>(null);

  // ---- 回放会话：完整快照持久化，刷新后从 dashboard 选择继续。 ----
  const [savedReplayData] = useState(loadReplaySessions);
  const [replaySessions, setReplaySessions] = useState(savedReplayData.sessions);
  const [replayStorageError, setReplayStorageError] = useState<string | null>(savedReplayData.errors.join('；') || null);
  const [replayOperationError, setReplayOperationError] = useState<string | null>(null);
  const replayRecordRef = useRef<SavedReplaySession | null>(null);
  const simRef = useRef<SimTrading | null>(null);
  const saveReplayRef = useRef<() => boolean>(() => true);
  const stepInFlight = useRef<Promise<boolean> | null>(null);
  const replayDispatching = useRef(false);
  const replayTransition = useRef(false);
  const navigationGeneration = useRef(0);
  const currentIntervalRef = useRef(initialInterval);
  const [widgetInterval, setWidgetInterval] = useState(initialInterval);
  const previousChartRef = useRef({ symbol: defaultSymbol, interval: initialInterval });
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

  useEffect(() => startHistorySync(), []);

  // 总览始终合并两桥账户，不受图表行情源或模拟账户选择影响。
  const refreshLiveAccounts = useCallback(async () => {
    const generation = connectionGeneration.current;
    try {
      const [result] = await Promise.all([
        nt8Trading.getAccounts(),
        Promise.all(BRIDGE_PROVIDERS.map(async source => {
          const info = await checkNt8Status(source);
          if (generation === connectionGeneration.current) setBridgeStatuses(current => ({ ...current, [source]: info }));
        })),
      ]);
      if (generation !== connectionGeneration.current) return;
      setLiveAccounts(result.accounts);
      if (!sessionRef.current) {
        setAccounts(result.accounts);
        setAccount(current => current || result.accounts[0]?.name || '');
      }
      rememberTradeAccounts(result.accounts);
      setLiveAccountsError(result.errors?.join('；') || null);
    } catch (err) {
      if (generation !== connectionGeneration.current) return;
      setLiveAccountsError(err instanceof Error ? err.message : '账户读取失败');
    }
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refreshLiveAccounts();
      if (!stopped) timer = setTimeout(poll, 3000);
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [refreshLiveAccounts]);

  // ---- 隐藏账户(账户页眼睛开关;localStorage 记忆) ----
  // 账户快照可能因部分连接离线而暂缺；隐藏偏好只随用户的眼睛开关变更。
  const [hiddenAccounts, setHiddenAccounts] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(HIDDEN_ACCOUNTS_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string').map(migrateLegacyAccount) : [];
    } catch { return []; }
  });
  const toggleHiddenAccount = useCallback((name: string) => {
    setHiddenAccounts((cur) => {
      const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
      try { localStorage.setItem(HIDDEN_ACCOUNTS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const connect = useCallback(async () => {
    const generation = ++connectionGeneration.current;
    try { await workspaceRef.current?.saveLayouts(); }
    catch (error) { window.alert(error instanceof Error ? error.message : '图表布局保存失败'); return; }
    if (generation !== connectionGeneration.current) return;
    navigationGeneration.current++;
    // 重连前先退出回放:后端与数据适配器都要重建
    if (sessionRef.current) {
      setReplayPlaying(false);
      await stepInFlight.current?.catch(() => false);
      if (!saveReplayRef.current()) return;
      sessionRef.current = null;
      simRef.current = null;
      replayRecordRef.current = null;
      widgetRef.current = null;
      setWidget(null);
      setTradingBackend(null);
      setReplayActive(false);
      setReplaySymbolInfo(null);
      setAccount(prevAccountRef.current);
      setDefaultSymbol(previousChartRef.current.symbol);
      setWidgetInterval(previousChartRef.current.interval);
    }
    setStatus('connecting');
    setSymbolsEmpty(false);
    const st = await checkNt8Status(provider);
    if (generation !== connectionGeneration.current) return;
    setBridgeStatuses(current => ({ ...current, [provider]: st }));
    const adapter = st?.connected ? createNt8Adapter(st, provider) : createMockAdapter();
    adapterRef.current = adapter;
    datafeed.setAdapter(adapter);
    try {
      const symbols = await datafeed.listSymbols();
      if (generation !== connectionGeneration.current) return;
      setKnownSymbols(symbols);
      if (symbols.length === 0 && st?.connected) setSymbolsEmpty(true);
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
          (st?.connected ? 'ES 09-26' : '')
        );
      });
    } catch {
      /* 保留当前默认合约 */
    }
    if (generation !== connectionGeneration.current) return;
    setStatus(st?.connected ? 'live' : 'mock');
    {
      try {
        const { accounts: accs } = await nt8Trading.getAccounts();
        if (generation !== connectionGeneration.current) return;
        setAccounts(accs);
        setLiveAccounts(accs);
        setAccount((cur) =>
          cur && accs.some((a) => a.name === cur) ? cur : accs[0]?.name ?? '',
        );
      } catch {
        if (generation === connectionGeneration.current) setAccounts([]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [datafeed, provider]);

  useEffect(() => {
    datafeed.onAdapterSwapped = () => {
      // A swapped adapter invalidates every chart, including nonselected panes and their subscriptions.
      unbindActiveWidget.current();
      widgetRef.current = null;
      setWidget(null);
      setFeedGeneration(value => value + 1);
    };
    void connect();
    // This numeric generation deliberately invalidates any in-flight connection on cleanup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { connectionGeneration.current++; datafeed.onAdapterSwapped = null; unbindActiveWidget.current(); };
  }, [connect, datafeed]);

  // ---- 交易数据轮询(0.5 秒;桥端是轻量快照,直连本地开销极低;回放期间走模拟引擎) ----
  const pollContext = `${accountConnected}|${account}|${replayActive}`;
  const pollContextRef = useRef(pollContext);
  pollContextRef.current = pollContext;
  const pollInFlight = useRef<string | null>(null);
  const refreshTrading = useCallback(async () => {
    if ((!accountConnected && !sessionRef.current) || !account) return;
    const context = pollContext;
    if (pollContextRef.current !== context) return;
    if (pollInFlight.current === context) return;
    pollInFlight.current = context;
    try {
      // brackets 端点依赖桥端升级(F5);未升级时单独容错,不拖垮订单/持仓轮询
      const [{ positions: p }, { orders: o }, bracketsRes, accsRes] = await Promise.all([
        trading.getPositions(account),
        trading.getOrders(account),
        trading.getBrackets(account).catch(() => null),
        // 账户余额/盈亏(账户信息页用);失败不影响其他数据
        trading.getAccounts().catch(() => null),
      ]);
      if (pollContextRef.current !== context) return;
      setPositions(p);
      setOrders(o);
      if (bracketsRes) setBrackets(bracketsRes.brackets);
      if (accsRes) {
        setAccounts(accsRes.accounts);
      }
      // 成交/持仓变化时推进签名,驱动图上交易历史箭头刷新(有变化才刷)
      const sig =
        JSON.stringify(o.map((x) => [x.orderId, x.filled])) +
        JSON.stringify(p.map((x) => [x.instrument, x.quantity]));
      if (sig !== tradeSigRef.current) {
        tradeSigRef.current = sig;
        setTradeSig(sig);
      }
      setPollError(bracketsRes?.syncError || null);
    } catch (err) {
      if (pollContextRef.current !== context) return;
      /* 轮询失败保持旧数据,但在面板上提示,避免"持仓不显示"无从下手 */
      setPollError(err instanceof Error ? err.message : '桥连接失败');
    } finally {
      if (pollInFlight.current === context) pollInFlight.current = null;
    }
  }, [accountConnected, account, pollContext]);

  useEffect(() => {
    if ((!accountConnected && !replayActive) || !account) return;
    void refreshTrading();
    const timer = setInterval(() => void refreshTrading(), 500);
    return () => clearInterval(timer);
  }, [accountConnected, account, refreshTrading, replayActive]);

  // ---- 回放进入/退出/步进 ----
  // 注意:进出回放通过 key 翻转重建图表 widget,而不是 resetData——
  // 实测本版库 resetData 不会重拉数据(实现为 mainSeries().rerequestData(),
  // 且 d.ts 声称的 resetCache 在运行时不存在);重建 widget 干净利落,
  // 图上绘图由各 hook 从状态重建
  const saveCurrentReplay = useCallback(() => {
    const record = replayRecordRef.current;
    const sim = simRef.current;
    const session = sessionRef.current;
    if (!record || !sim || !session) return true;
    const state = sim.exportState();
    const lastPrices = { ...record.lastPrices };
    for (const symbol of new Set([record.symbol, ...state.positions.map(p => p.instrument)])) {
      const price = datafeed.getLastPrice(symbol);
      if (price != null) lastPrices[symbol] = price;
    }
    const next = { ...record, state, lastPrices, cursor: session.getCursor(), updatedAt: Date.now() };
    replayRecordRef.current = next;
    setReplaySessions(rows => [next, ...rows.filter(r => r.id !== next.id)]);
    try {
      saveReplaySession(next);
      setReplayStorageError(null);
      return true;
    } catch (err) {
      setReplayPlaying(false);
      setReplayStorageError(err instanceof Error ? err.message : '回放会话保存失败');
      return false;
    }
  }, [datafeed]);
  saveReplayRef.current = saveCurrentReplay;

  useEffect(() => {
    const save = () => { saveReplayRef.current(); };
    window.addEventListener('pagehide', save);
    return () => window.removeEventListener('pagehide', save);
  }, []);

  const exitReplay = useCallback(async (): Promise<boolean> => {
    setReplayPlaying(false);
    await stepInFlight.current?.catch(() => false);
    if (!saveReplayRef.current()) return false;
    sessionRef.current = null;
    simRef.current = null;
    replayRecordRef.current = null;
    widgetRef.current = null;
    setTradingBackend(null);
    setWidget(null);
    if (adapterRef.current) datafeed.setAdapter(adapterRef.current);
    setReplayActive(false);
    setReplaySymbolInfo(null);
    setMobilePanel(null);
    setAccount((cur) => (cur === SIM_ACCOUNT ? prevAccountRef.current : cur));
    setAccounts(liveAccounts);
    setPositions([]); setOrders([]); setBrackets([]);
    setDefaultSymbol(previousChartRef.current.symbol);
    setWidgetInterval(previousChartRef.current.interval);
    currentIntervalRef.current = previousChartRef.current.interval;
    return true;
  }, [datafeed, liveAccounts]);

  const resumeReplay = useCallback(
    async (record: SavedReplaySession) => {
      const liveBase = adapterRef.current;
      if (sessionRef.current || replayTransition.current) return;
      replayTransition.current = true;
      const generation = navigationGeneration.current;
      setReplayOperationError(null);
      try {
      await workspaceRef.current?.saveLayouts();
      const { adapter: base, info } = await loadReplayFeed(record);
      if (generation !== navigationGeneration.current || adapterRef.current !== liveBase) return;
      const session = new ReplaySession(base, record.cursor);
      record = { ...record, provider: record.provider ?? 'nt8', pointValues: { ...record.pointValues, [record.symbol]: resolvePointValue(record.symbol, info.pointValue) } };
      setReplaySymbolInfo(info);
      setTickSize(info.tickSize || 0.25);
      setPointValue(resolvePointValue(record.symbol, info.pointValue));
      replayRecordRef.current = record;
      const sim = new SimTrading({
        getLastPrice: (s) => datafeed.getLastPrice(s),
        pointValueOf: (s) => replayRecordRef.current?.pointValues[s] ?? resolvePointValue(s),
        getCursorTime: () => session.getCursor(),
        onChange: () => { if (sessionRef.current === session && !replayDispatching.current) saveReplayRef.current(); },
      }, { initialEquity: record.initialEquity, state: record.state });
      session.onBarRevealed((sym, _intervalSec, bar) => {
        if (sessionRef.current !== session) return;
        replayDispatching.current = true;
        try { sim.onBar(sym, bar); } finally { replayDispatching.current = false; }
        setReplayCursor(session.getCursor());
      });
      sessionRef.current = session;
      simRef.current = sim;
      setTradingBackend(sim);
      prevAccountRef.current = account;
      previousChartRef.current = { symbol: chartSymbol || defaultSymbol, interval: currentIntervalRef.current };
      setAccount(SIM_ACCOUNT);
      setPositions([]); setOrders([]); setBrackets([]); setAccounts([]);
      setReplayCursor(record.cursor);
      setReplaySpeed(record.speed);
      setReplayStepSec(record.stepSec);
      setDefaultSymbol(record.symbol);
      setWidgetInterval(record.interval);
      currentIntervalRef.current = record.interval;
      widgetRef.current = null;
      setWidget(null);
      rpTrace('ui.enterReplay', { id: record.id, cursor: record.cursor });
      datafeed.setAdapter(session); // 先切适配器,再翻转 key 重建图表(直接在回放数据上初始化)
      setReplayPlaying(false);
      setReplayActive(true);
      setPage('replay');
      saveReplayRef.current();
      } finally { replayTransition.current = false; }
    },
    [datafeed, chartSymbol, defaultSymbol, account],
  );

  const newReplay = useCallback(async (input: NewReplaySessionInput) => {
    const record = createReplaySession({ ...input, provider });
    saveReplaySession(record);
    setReplaySessions(rows => [record, ...rows]);
    await resumeReplay(record);
  }, [resumeReplay, provider]);

  const removeReplay = useCallback((id: string) => {
    if (replayRecordRef.current?.id === id || replayTransition.current) {
      throw new Error('请先保存并退出当前回放，再删除会话。');
    }
    // 本地删除成功后再更新列表；当前回放的保存回调不能重新写回已删会话。
    deleteReplaySession(id);
    setReplaySessions(rows => rows.filter(session => session.id !== id));
  }, []);

  const enterReplay = useCallback((startTime: number) => newReplay({
    name: `${chartSymbol || defaultSymbol} 回放`, symbol: chartSymbol || defaultSymbol, startTime, initialEquity: 100000,
  }), [newReplay, chartSymbol, defaultSymbol]);

  const stepReplayAsync = useCallback((): Promise<boolean> => {
    const s = sessionRef.current;
    rpTrace('ui.step', { hasSession: !!s, stepSec: stepSecRef.current });
    if (!s) return Promise.resolve(false);
    if (stepInFlight.current) return stepInFlight.current;
    const task = s.step(stepSecRef.current).then((ok) => {
      if (sessionRef.current !== s) return false;
      setReplayCursor(s.getCursor());
      if (!ok) setReplayPlaying(false);
      return ok;
    }).catch(err => {
      setReplayPlaying(false);
      setReplayOperationError(err instanceof Error ? err.message : '回放推进失败');
      return false;
    }).finally(() => {
      stepInFlight.current = null;
      if (sessionRef.current === s) saveReplayRef.current();
    });
    stepInFlight.current = task;
    return task;
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
    if (widgetRef.current === w) return;
    unbindActiveWidget.current();
    widgetRef.current = w;
    (window as unknown as Record<string, unknown>).__lastWidget = w;
    // A draft belongs to the selected chart; switching panes starts a fresh ticket.
    setMode('trade');
    setLimitPrice('');
    setTpAmount('');
    setSlAmount('');
    setRefPrice(null);
    let unsubscribeChart = () => {};
    let initialized = false;
    let boundSymbol = '';
    const bindChart = () => {
      if (widgetRef.current !== w) return;
      unsubscribeChart();
      setWidget(w);
      const chart = w.activeChart();
      // 实盘恢复布局自身的合约；回放仍固定到当前会话的合约。
      const cachedSymbol = replayRecordRef.current?.symbol;
      if (cachedSymbol && chart.symbol() !== cachedSymbol) {
        try { chart.setSymbol(cachedSymbol); } catch { /* 解析失败保持原样 */ }
      }
      const syncSymbol = () => {
        const record = replayRecordRef.current;
        if (record && chart.symbol() !== record.symbol) {
          chart.setSymbol(record.symbol);
          return;
        }
        const nextSymbol = chart.symbol();
        setChartSymbol(nextSymbol);
        const info = knownSymbolsRef.current.find(s => s.symbol === nextSymbol);
        setTickSize(info?.tickSize || 0.25);
        setPointValue(resolvePointValue(nextSymbol, info?.pointValue));
        if (boundSymbol && boundSymbol !== nextSymbol) {
          setLimitPrice('');
          setTpAmount('');
          setSlAmount('');
          setRefPrice(null);
        }
        boundSymbol = nextSymbol;
      };
      // 界面缓存:周期变化即记忆,下次启动恢复
      const syncInterval = (interval: string) => {
        currentIntervalRef.current = interval;
        if (replayRecordRef.current) {
          replayRecordRef.current.interval = interval;
          if (!stepInFlight.current) saveReplayRef.current();
        } else try { localStorage.setItem(INTERVAL_KEY, interval); } catch { /* ignore */ }
        // 周期纪元 +1:草稿虚线整体重建,避免库在切周期时残留旧线
        setChartEpoch((n) => n + 1);
      };
      const symbolEvent = chart.onSymbolChanged();
      const intervalEvent = chart.onIntervalChanged();
      symbolEvent.subscribe(null, syncSymbol);
      intervalEvent.subscribe(null, syncInterval);
      unsubscribeChart = () => {
        symbolEvent.unsubscribe?.(null, syncSymbol);
        intervalEvent.unsubscribe?.(null, syncInterval);
      };
      // 原生加载会重建主图模型，必须重绑订阅并刷新未参与布局保存的交易线。
      syncSymbol();
      syncInterval(chart.resolution());
      initialized = true;
    };
    const onLoaded = () => { if (initialized) bindChart(); };
    w.onChartReady(bindChart);
    w.subscribe?.('chart_loaded', onLoaded);
    unbindActiveWidget.current = () => {
      unsubscribeChart();
      try { w.unsubscribe?.('chart_loaded', onLoaded); } catch { /* The previous widget may already be removed. */ }
      unbindActiveWidget.current = () => {};
    };
  }, []);

  // ---- 界面缓存:合约/单类型/手数 变化即写 localStorage ----
  useEffect(() => {
    if (chartSymbol && !sessionRef.current) try { localStorage.setItem(symbolKey, chartSymbol); } catch { /* ignore */ }
  }, [chartSymbol, symbolKey]);
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
  }, [theme]);

  // 合约切换后同步 tickSize / pointValue
  useEffect(() => {
    if (!chartSymbol) return;
    let cancelled = false;
    void datafeed.listSymbols().then((symbols) => {
      if (cancelled) return;
      const found = symbols.find((s) => s.symbol === chartSymbol);
      if (found?.tickSize) setTickSize(found.tickSize);
      setPointValue(resolvePointValue(chartSymbol, found?.pointValue));
      if (replayRecordRef.current) replayRecordRef.current.pointValues[chartSymbol] = resolvePointValue(chartSymbol, found?.pointValue);
    }).catch(() => { /* Keep the metadata from the last successful symbol list. */ });
    return () => { cancelled = true; };
  }, [chartSymbol, datafeed]);

  // ---- 图表订单线 ----
  const getMarketPrice = useCallback(
    () => datafeed.getLastPrice(chartSymbol),
    [datafeed, chartSymbol],
  );
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

  // Order lines, fills and context menus are owned by each ChartWorkspace pane.

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

  const switchQuoteProvider = useCallback(async (next: BridgeProvider, force = false) => {
    const generation = ++quoteSwitchGeneration.current;
    if (sessionRef.current || replayTransition.current) throw new Error('请先保存并退出回放，再更换行情源。');
    await workspaceRef.current?.saveLayouts();
    if (generation !== quoteSwitchGeneration.current) return;
    if (sessionRef.current || replayTransition.current) throw new Error('请先保存并退出回放。');
    if (next === provider && !force) return;
    connectionGeneration.current++;
    setProvider(next);
    setStatus('connecting');
    setDefaultSymbol(localStorage.getItem(bridgeStorageKey('nt8-terminal-symbol', next)) || '');
    setChartSymbol('');
    setKnownSymbols([]);
    setLimitPrice('');
    setRefPrice(null);
    setTickSize(0.25);
    setWidget(null);
    widgetRef.current = null;
    setQuoteProvider(next);
    setProviderDraft(next);
    if (next === provider) await connect();
  }, [provider, connect]);

  const handleAccountChange = useCallback((name: string) => {
    // A later account selection wins even when its provider already matches the current chart.
    quoteSwitchGeneration.current++;
    initialAccountSource.current = true;
    setAccount(name);
    setPositions([]);
    setOrders([]);
    setBrackets([]);
    setPollError(null);
    if (!sessionRef.current) try { localStorage.setItem(ACCOUNT_KEY, name); } catch { /* ignore */ }
    if (!sessionRef.current && name && parseBridgeAccount(name).provider !== provider) {
      void switchQuoteProvider(parseBridgeAccount(name).provider).catch(error => setPollError(error instanceof Error ? error.message : '行情源切换失败'));
    }
  }, [provider, switchQuoteProvider]);

  useEffect(() => {
    if (initialAccountSource.current || replayActive || !liveAccounts.length) return;
    const selected = liveAccounts.find(item => item.name === account) || liveAccounts[0];
    if (!bridgeStatuses[parseBridgeAccount(selected.name).provider]?.connected) return;
    initialAccountSource.current = true;
    handleAccountChange(selected.name);
  }, [account, liveAccounts, bridgeStatuses, replayActive, handleAccountChange]);

  // 当前账户被隐藏时,自动切到第一个可见账户(隐藏账户不可选中)
  useEffect(() => {
    if (account && hiddenAccounts.includes(account)) {
      const firstVisible = accounts.find((a) => !hiddenAccounts.includes(a.name));
      if (firstVisible) handleAccountChange(firstVisible.name);
    }
  }, [account, accounts, hiddenAccounts, handleAccountChange]);

  // ---- 分隔条拖拽 ----
  const onDividerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const divider = e.currentTarget;
      divider.setPointerCapture(e.pointerId);
      const columns = Math.max(1, Number(showTradingPanel) + Number(showAccountPanel));
      dragState.current = { startX: e.clientX, startWidth: panelWidth, width: panelWidth };
      const onMove = (ev: PointerEvent) => {
        if (!dragState.current) return;
        const delta = dragState.current.startX - ev.clientX;
        const w = Math.min(640, Math.max(260, dragState.current.startWidth + delta / columns));
        dragState.current.width = w;
        setPanelWidth(w);
      };
      const onUp = () => {
        if (dragState.current) {
          try { localStorage.setItem(PANEL_WIDTH_KEY, String(dragState.current.width)); } catch { /* ignore */ }
        }
        dragState.current = null;
        divider.removeEventListener('pointermove', onMove);
        divider.removeEventListener('pointerup', onUp);
        divider.removeEventListener('pointercancel', onUp);
        divider.removeEventListener('lostpointercapture', onUp);
      };
      divider.addEventListener('pointermove', onMove);
      divider.addEventListener('pointerup', onUp);
      divider.addEventListener('pointercancel', onUp);
      divider.addEventListener('lostpointercapture', onUp);
    },
    [panelWidth, showTradingPanel, showAccountPanel],
  );

  const navigate = async (next: typeof page) => {
    navigationGeneration.current++;
    setReplayPlaying(false);
    if (sessionRef.current && next !== 'replay' && !await exitReplay()) return;
    setMobilePanel(null);
    setPage(next);
  };
  const chartVisible = page === 'chart' || (page === 'replay' && replayActive);
  const tradingPanelVisible = compact ? mobilePanel === 'trading' : showTradingPanel;
  const accountPanelVisible = compact ? mobilePanel === 'account' : showAccountPanel;
  const replayPanelVisible = replayActive && (!compact || mobilePanel === 'replay');
  const sidebarVisible = tradingPanelVisible || accountPanelVisible || replayPanelVisible;
  const mobilePanelHeight = useMobilePanelHeight(compact && sidebarVisible && chartVisible);
  const toggleTradingPanel = () => compact
    ? setMobilePanel(value => value === 'trading' ? null : 'trading')
    : setShowTradingPanel(value => !value);
  const toggleAccountPanel = () => compact
    ? setMobilePanel(value => value === 'account' ? null : 'account')
    : setShowAccountPanel(value => !value);
  const searchDragHandle = compact ? undefined : <button
    type="button" aria-label="拖动合约搜索栏" title="拖动合约搜索栏；双击恢复默认位置"
    onPointerDown={symbolSearchDrag.onHandlePointerDown} onDoubleClick={symbolSearchDrag.reset}
    className="shrink-0 touch-none cursor-grab rounded p-1 text-[var(--tv-muted)] hover:bg-[var(--tv-border)] hover:text-[var(--tv-text)] active:cursor-grabbing"
  ><GripVertical className="h-3.5 w-3.5" /></button>;

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-[var(--tv-bg)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] lg:pt-[env(safe-area-inset-top)]">
      {compact ? <MobileNavigation
        page={page} onNavigate={next => void navigate(next)} chartVisible={chartVisible}
        tradingPanelVisible={tradingPanelVisible} accountPanelVisible={accountPanelVisible}
        replayActive={replayActive} replayPanelVisible={replayPanelVisible}
        onToggleTradingPanel={toggleTradingPanel} onToggleAccountPanel={toggleAccountPanel}
        onToggleReplayPanel={() => setMobilePanel(value => value === 'replay' ? null : 'replay')}
        bridgeStatuses={bridgeStatuses}
        showTradeHistory={showTradeHistory} onToggleTradeHistory={toggleTradeHistory}
        theme={theme} onToggleTheme={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}
        onReconnect={() => void connect()} onSettings={() => setSettingsOpen(value => !value)}
      /> : <nav aria-label="主导航" className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--tv-border)] bg-[var(--tv-panel)] px-2 py-1 text-sm text-[var(--tv-text)] lg:h-12 lg:flex-nowrap lg:px-3 lg:py-0">
        <span className="mr-3 hidden 2xl:inline text-xs font-semibold tracking-widest">TRADING TERMINAL</span>
        <div className="flex w-full min-w-0 items-center gap-1 lg:w-auto">
        {([{ id: 'chart', label: '交易图表' }, { id: 'overview', label: '账户总览' }, { id: 'records', label: '交易记录' }, { id: 'replay', label: '回放模拟' }, { id: 'copy', label: '复制交易' }] as const).map(item =>
          <button key={item.id} aria-current={page === item.id ? 'page' : undefined} onClick={() => void navigate(item.id)}
            className={`whitespace-nowrap rounded-md px-2 py-2 sm:px-4 ${page === item.id ? 'bg-[#2962ff]/15 text-[#5b8cff]' : 'text-[var(--tv-muted)] hover:text-[var(--tv-text)]'}`}>{item.label}</button>)}
        </div>
        {replayActive && <span className="ml-2 hidden max-w-40 truncate text-xs text-amber-500 xl:inline">{replayRecordRef.current?.name}</span>}
        <div role="toolbar" aria-label="页面工具栏" className="ml-auto flex w-full shrink-0 flex-wrap items-center gap-1 border-t border-[var(--tv-border)] pt-1 lg:w-auto lg:flex-nowrap lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
          <div role="group" aria-label="图表布局" className="mr-1 flex items-center rounded border border-[var(--tv-border)]">
            {([{ count: 1, label: '单图', icon: Square }, { count: 2, label: '双图', icon: Columns2 }, { count: 4, label: '四图', icon: Grid2X2 }] as const).map(item => <button
              key={item.count} type="button" aria-label={item.label} aria-pressed={(replayActive ? 1 : chartCount) === item.count}
              title={replayActive ? '回放使用当前会话的单图表' : item.label} disabled={!chartVisible || replayActive}
              onClick={() => setChartCount(item.count)} className={`rounded px-2 py-3 disabled:opacity-40 lg:p-1.5 ${(replayActive ? 1 : chartCount) === item.count ? 'bg-[#2962ff]/15 text-[#5b8cff]' : 'text-[var(--tv-muted)] hover:bg-[var(--tv-border)]'}`}>
              <item.icon className="h-3.5 w-3.5" />
            </button>)}
          </div>
          <Button variant="ghost" size="sm" disabled={!chartVisible} aria-label="交易面板" aria-pressed={chartVisible && tradingPanelVisible} aria-controls="trading-page-trade"
            onClick={toggleTradingPanel}
            className={`h-10 gap-1 px-2 text-xs lg:h-7 ${chartVisible && tradingPanelVisible ? 'bg-[#2962ff]/15 text-[#5b8cff]' : 'text-[var(--tv-muted)]'}`}>
            <PanelRight className="h-3.5 w-3.5" /><span>交易面板</span>
          </Button>
          <Button variant="ghost" size="sm" disabled={!chartVisible} aria-label="账户信息" aria-pressed={chartVisible && accountPanelVisible} aria-controls="trading-page-accounts"
            onClick={toggleAccountPanel}
            className={`h-10 gap-1 px-2 text-xs lg:h-7 ${chartVisible && accountPanelVisible ? 'bg-[#2962ff]/15 text-[#5b8cff]' : 'text-[var(--tv-muted)]'}`}>
            <Wallet className="h-3.5 w-3.5" /><span>账户信息</span>
          </Button>
          {compact && replayActive && <Button variant="ghost" size="sm" aria-label="回放控制" aria-pressed={replayPanelVisible}
            onClick={() => setMobilePanel(value => value === 'replay' ? null : 'replay')}
            className={`h-10 gap-1 px-2 text-xs ${replayPanelVisible ? 'bg-amber-500/15 text-amber-500' : 'text-[var(--tv-muted)]'}`}>
            <Play className="h-3.5 w-3.5" />回放控制
          </Button>}
          <BridgeConnectionStatus statuses={bridgeStatuses} />

          <Button
            variant="ghost"
            size="icon"
            className={`h-10 w-10 hover:bg-[var(--tv-border)] lg:h-7 lg:w-7 ${
              showTradeHistory ? 'text-[#2962ff]' : 'text-[var(--tv-muted)]'
            }`}
            aria-label={showTradeHistory ? '隐藏交易历史' : '显示交易历史'}
            aria-pressed={showTradeHistory}
            title={showTradeHistory ? '隐藏交易历史' : '显示交易历史'}
            onClick={toggleTradeHistory}
          >
            <History className="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 text-[var(--tv-text)] hover:bg-[var(--tv-border)] lg:h-7 lg:w-7"
            aria-label="重新连接数据桥"
            title="重新连接数据桥"
            onClick={() => void connect()}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 text-[var(--tv-text)] hover:bg-[var(--tv-border)] lg:h-7 lg:w-7"
            aria-label={theme === 'dark' ? '切换为白天模式' : '切换为黑夜模式'}
            title={theme === 'dark' ? '切换为白天模式' : '切换为黑夜模式'}
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          >
            {theme === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-10 w-10 text-[var(--tv-text)] hover:bg-[var(--tv-border)] lg:h-7 lg:w-7"
            aria-label="数据桥设置"
            title="数据桥设置"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <Settings className="h-3.5 w-3.5" />
          </Button>
        </div>

      </nav>}
      {replayActive && (replayStorageError || replayOperationError) && <div role="alert" className="flex shrink-0 items-center justify-between gap-3 bg-red-500/10 px-4 py-2 text-sm text-red-400">
        <span>{replayStorageError ? `会话尚未保存：${replayStorageError}` : replayOperationError}</span>
        {replayStorageError && <button className="shrink-0 underline" onClick={() => saveReplayRef.current()}>重试保存</button>}
      </div>}
        {/* 数据桥设置浮窗(可拖动:标题栏为手柄,非模态不挡图表) */}
        {settingsOpen && (
          <div
            ref={compact ? undefined : settingsDrag.panelRef}
            data-draggable-panel
            className="fixed z-[100] max-h-[calc(100dvh-16px)] w-80 max-w-[calc(100%-16px)] overflow-y-auto rounded-md border border-[var(--tv-border)] bg-[var(--tv-panel)] text-[var(--tv-text)] shadow-xl"
            style={
              compact ? { left: 8, right: 8, top: 8, width: 'auto' } : settingsDrag.pos
                ? { left: settingsDrag.pos.x, top: settingsDrag.pos.y }
                : { right: 16, top: 56 }
            }
          >
            <div
              onPointerDown={compact ? undefined : settingsDrag.onHandlePointerDown}
              className="flex touch-none cursor-move items-center justify-between border-b border-[var(--tv-border)] px-3 py-2 select-none"
              title="按住拖动"
            >
              <span className="text-sm font-semibold">数据桥设置</span>
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setSettingsOpen(false)}
                className="rounded p-0.5 text-[var(--tv-muted)] hover:bg-[var(--tv-border)] hover:text-[var(--tv-text)]"
                title="关闭"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="p-3">
              <label className="mb-1 block text-xs text-[var(--tv-muted)]" htmlFor="bridge-provider">图表行情源</label>
              <select id="bridge-provider" aria-label="图表行情源" value={providerDraft} disabled={replayActive || savingBridge}
                onChange={event => {
                  const next = event.target.value as BridgeProvider;
                  setProviderDraft(next);
                  setBridgeSettingsError(null);
                }}
                className="mb-3 h-9 w-full rounded-md border border-[var(--tv-border)] bg-[var(--tv-bg)] px-2 text-sm text-[var(--tv-text)] disabled:opacity-50">
                <option value="nt8">NinjaTrader 8</option>
                <option value="atas">ATAS X · dxFeed</option>
              </select>
              <p className="mb-2 text-xs text-[var(--tv-muted)]">
                NT8 与 ATAS X 账户同时显示，并按来源和连接分组。选择交易账户时会切到对应行情源。
                远程访问默认使用当前网站代理，地址留空恢复默认。
              </p>
              {replayActive && <p role="status" className="mb-2 text-xs text-amber-500">请先保存并退出回放，再修改数据桥连接。</p>}
              {bridgeSettingsError && <p role="alert" className="mb-2 text-xs text-red-400">{bridgeSettingsError}</p>}
              {BRIDGE_PROVIDERS.map(source => <label key={source} className="mb-3 block text-xs text-[var(--tv-muted)]">
                {bridgeProviderName(source)} 数据桥地址
                <Input aria-label={`${bridgeProviderName(source)} 数据桥地址`} disabled={replayActive || savingBridge}
                  value={bridgeUrlDraft[source]} onChange={event => setBridgeUrlDraft(current => ({ ...current, [source]: event.target.value }))}
                  placeholder={defaultBridgeUrl(source)} className="mt-1 h-11 border-[var(--tv-border)] bg-[var(--tv-bg)] text-base text-[var(--tv-text)] md:text-base lg:h-9 lg:text-sm" />
              </label>)}
              <div className="mt-3 flex justify-end">
                <Button
                  disabled={replayActive || savingBridge}
                  onClick={async () => {
                    if (sessionRef.current || replayTransition.current || savingBridge) return;
                    setSavingBridge(true);
                    setBridgeSettingsError(null);
                    try {
                      await workspaceRef.current?.saveLayouts();
                      if (sessionRef.current || replayTransition.current) throw new Error('请先保存并退出回放。');
                      BRIDGE_PROVIDERS.forEach(source => setBridgeUrl(bridgeUrlDraft[source], source));
                      await switchQuoteProvider(providerDraft, true);
                      await refreshLiveAccounts();
                      setSettingsOpen(false);
                    } catch (error) {
                      setBridgeSettingsError(error instanceof Error ? error.message : '数据桥设置保存失败');
                      setSavingBridge(false);
                    }
                    finally { setSavingBridge(false); }
                  }}
                >
                  {savingBridge ? '正在保存…' : '保存并重连'}
                </Button>
              </div>
            </div>
          </div>
        )}
      <div className="relative min-h-0 flex-1">
      <div ref={mobilePanelHeight.containerRef} inert={!chartVisible} aria-hidden={!chartVisible} className={`absolute inset-0 flex flex-col lg:flex-row ${chartVisible ? '' : 'invisible opacity-0 pointer-events-none'}`}>
      {/* 图表区 */}
      <div data-chart-area className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1">
        {defaultSymbol && status !== 'connecting' ? (
          <ChartWorkspace
            ref={workspaceRef}
            key={`${provider}-${replayActive ? replayRecordRef.current?.id : 'live'}-${feedGeneration}`}
            provider={replayActive ? replayRecordRef.current?.provider || 'nt8' : provider}
            count={replayActive ? 1 : chartCount}
            singleChart={compact}
            datafeed={datafeed}
            symbol={defaultSymbol}
            initialInterval={widgetInterval}
            symbols={replayActive && replaySymbolInfo ? [replaySymbolInfo] : knownSymbols}
            replay={replayActive}
            theme={theme}
            account={account}
            tradingEnabled={liveTradingEnabled || replayActive}
            orders={orders}
            positions={positions}
            brackets={brackets}
            qty={qty}
            showTradeHistory={showTradeHistory}
            tradeSig={tradeSig}
            onChanged={refreshTrading}
            onActiveWidget={handleWidgetReady}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-[var(--tv-muted)]">
            正在初始化数据源…
          </div>
        )}
        </div>

        {/* 桌面合约栏可拖动；手机固定在图表上方，避免遮住原生图表工具栏。 */}
        <div
          ref={compact ? undefined : symbolSearchDrag.panelRef}
          data-draggable-panel
          data-symbol-search
          className={compact ? 'relative order-first z-40 mx-1 my-0.5 shrink-0' : 'absolute z-40 max-w-[calc(100%-16px)]'}
          style={compact ? undefined : symbolSearchDrag.pos
            ? { left: symbolSearchDrag.pos.x, top: symbolSearchDrag.pos.y }
            : { top: !replayActive && chartCount > 1 ? 34 : 8, left: '50%', transform: 'translateX(-50%)' }}
        >
          {replayActive ? <div aria-label="回放会话合约" className="flex items-center gap-2 rounded-md border border-[var(--tv-border)] bg-[var(--tv-panel)] px-2 py-1 text-xs text-[var(--tv-text)]">
            {searchDragHandle}<span>{replayRecordRef.current?.symbol}</span><span className="text-amber-500">回放</span>
          </div> : <SymbolFavorites key={provider} provider={provider}
            dragHandle={searchDragHandle}
            listSymbols={listSearchSymbols}
            resolveSymbol={resolveSearchSymbol}
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
          />}
        </div>

        {/* NT8 已连接但合约列表为空的提示 */}
        {symbolsEmpty && status === 'live' && (
          <div className="absolute left-1/2 top-12 z-50 -translate-x-1/2 rounded-md border border-[#f0b90b]/40 bg-[var(--tv-panel)]/95 px-4 py-2 text-xs text-[#f0b90b] shadow-lg">
            {providerName} 已连接，但合约库为空：请在 {providerName} 中确认合约已加载，
            或直接在图表搜索框输入合约名(如 NQ SEP26)。
          </div>
        )}


      </div>

      {/* 分隔条 */}
      {compact && sidebarVisible && <div
        {...mobilePanelHeight.separatorProps}
        data-mobile-panel-resizer
        role="separator" aria-orientation="horizontal" aria-label="调整下方面板高度"
        aria-controls="chart-sidebar" tabIndex={0}
        title="上下拖动调整面板高度"
        className="flex h-3 shrink-0 touch-none select-none cursor-row-resize items-center justify-center border-y border-[var(--tv-border)] bg-[var(--tv-panel)] text-[var(--tv-muted)] hover:text-[#2962ff] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#2962ff] active:text-[#2962ff]"
      ><span className="h-1 w-10 rounded-full bg-current" /></div>}
      {!compact && sidebarVisible && <div
        onPointerDown={onDividerDown}
        className="w-1 shrink-0 touch-none cursor-col-resize bg-[var(--tv-border)] transition-colors hover:bg-[#2962ff]"
        title="拖拽调整面板宽度"
      />}

      {/* 交易面板 */}
      <div
        style={compact ? mobilePanelHeight.panelStyle : { width: panelWidth * Math.max(1, Number(showTradingPanel) + Number(showAccountPanel)), maxWidth: 'calc(100% - 360px)' }}
        id="chart-sidebar" data-sidebar hidden={!sidebarVisible}
        className={`${sidebarVisible ? 'flex' : 'hidden'} ${compact ? 'w-full' : 'border-l'} min-h-0 min-w-0 shrink-0 flex-col overflow-hidden border-[var(--tv-border)] bg-[var(--tv-panel)]`}
      >
        {compact && replayPanelVisible && <div className="flex h-8 shrink-0 items-center justify-between border-b border-[var(--tv-border)] px-2 text-[var(--tv-text)]">
          <h2 className="text-xs font-semibold">回放控制</h2>
          <button type="button" aria-label="关闭回放控制" onClick={() => setMobilePanel(null)} className="rounded p-1.5"><X className="h-4 w-4" /></button>
        </div>}
        {replayActive && <div hidden={!replayPanelVisible} className={`${replayPanelVisible ? '' : 'hidden'} ${compact ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain' : 'shrink-0'} border-b border-[var(--tv-border)]`} data-replay-panel><ReplayBar
            active={replayActive}
            enabled={status === 'live' && !!widget}
            cursor={replayCursor}
            playing={replayPlaying}
            speed={replaySpeed}
            stepSec={replayStepSec}
            onStart={start => void enterReplay(start)}
            onStep={stepReplay}
            onTogglePlay={() => setReplayPlaying(v => !v)}
            onSpeedChange={speed => { setReplaySpeed(speed); if (replayRecordRef.current) replayRecordRef.current.speed = speed; if (!stepInFlight.current) saveReplayRef.current(); }}
            onStepSecChange={step => { setReplayStepSec(step); if (replayRecordRef.current) replayRecordRef.current.stepSec = step; if (!stepInFlight.current) saveReplayRef.current(); }}
            onExit={() => void exitReplay()}
          /></div>}
        <div className={`${compact && replayPanelVisible ? 'hidden' : ''} min-h-0 flex-1`}><TradingPanel
          showTradingPanel={tradingPanelVisible}
          showAccountPanel={accountPanelVisible}
          onCloseTradingPanel={() => compact ? setMobilePanel(null) : setShowTradingPanel(false)}
          onCloseAccountPanel={() => compact ? setMobilePanel(null) : setShowAccountPanel(false)}
          enabled={!!widget && (liveTradingEnabled || replayActive)}
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
        /></div>
      </div>
      </div>
      {page === 'copy' && <div className="absolute inset-0"><CopyTradingPage /></div>}
      {(page === 'overview' || page === 'records') && <div className="absolute inset-0"><AccountPages
        page={page} accounts={liveAccounts} error={liveAccountsError} enabled={BRIDGE_PROVIDERS.some(source => bridgeStatuses[source]?.connected)} onRefresh={refreshLiveAccounts}
      /></div>}
      {page === 'replay' && !replayActive && <div className="absolute inset-0"><ReplayDashboard
        sessions={replaySessions} onCreate={newReplay} onResume={resumeReplay} onDelete={removeReplay}
        defaultSymbol={chartSymbol || defaultSymbol} symbols={knownSymbols.map(s => s.symbol)}
        storageError={replayStorageError || undefined} provider={provider}
      /></div>}
      </div>
    </div>
  );
}
