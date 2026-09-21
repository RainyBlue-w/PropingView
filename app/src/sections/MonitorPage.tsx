import { useEffect, useRef, useState } from 'react';
import { Activity, RefreshCw } from 'lucide-react';
import MonitorAccountCard from '@/components/MonitorAccountCard';
import { hasOpenPosition, type MonitorSnapshot } from '@/lib/monitorData';
import { nt8Trading, type Nt8Account, type Nt8Position } from '@/lib/nt8Trading';

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * 监控面板:有持仓的真实账户各一张卡片(余额、实时浮动盈亏、K 线 + 持仓/止盈止损线)。
 * 始终读取两桥实盘账户(不经 tradingRouter),回放期间也显示实盘;隐藏账户偏好不影响本页;完全只读。
 */
export default function MonitorPage() {
  const [snapshots, setSnapshots] = useState<MonitorSnapshot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const snapshotRef = useRef(new Map<string, MonitorSnapshot>());
  const generation = useRef(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped) return;
      const version = ++generation.current;
      try {
        const { accounts, errors } = await nt8Trading.getAccounts();
        const positionResults = await Promise.allSettled(accounts.map(a => nt8Trading.getPositions(a.name)));
        if (stopped || version !== generation.current) return;
        const kept: { account: Nt8Account; positions: Nt8Position[] }[] = [];
        accounts.forEach((account, index) => {
          const result = positionResults[index];
          if (result.status === 'fulfilled') {
            if (hasOpenPosition(result.value.positions)) kept.push({ account, positions: result.value.positions });
            else snapshotRef.current.delete(account.name);
          }
          // 单个账户持仓查询失败:保留旧卡片,避免一次抖动丢监控
        });
        const detailResults = await Promise.allSettled(kept.map(({ account }) => Promise.all([
          nt8Trading.getOrders(account.name),
          nt8Trading.getBrackets(account.name).catch(() => null),
        ])));
        if (stopped || version !== generation.current) return;
        kept.forEach(({ account, positions }, index) => {
          const detail = detailResults[index];
          if (detail.status !== 'fulfilled') return; // 保留旧快照
          const [{ orders }, bracketResult] = detail.value;
          snapshotRef.current.set(account.name, {
            account, positions, orders,
            brackets: bracketResult?.brackets ?? [],
            syncError: bracketResult?.syncError || undefined,
          });
        });
        setSnapshots(accounts.filter(a => snapshotRef.current.has(a.name)).map(a => snapshotRef.current.get(a.name)!));
        setError(errors?.length ? `部分数据桥账户读取失败：${errors.join('；')}` : null);
        setLastRefresh(Date.now());
      } catch (err) {
        if (!stopped) setError(`账户读取失败：${errorText(err)}`);
      }
      if (!stopped) timer = setTimeout(() => { void poll(); }, 3000);
    };
    void poll();
    // This numeric generation invalidates earlier requests; it is not a DOM reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { stopped = true; generation.current++; clearTimeout(timer); };
  }, [refreshKey]);

  return <div className="h-full overflow-auto bg-[var(--tv-bg)] p-3 text-[var(--tv-text)] sm:p-6 lg:p-8" data-monitor-page>
    <div className="mx-auto max-w-7xl space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-2 text-xs text-[var(--tv-muted)]">只读监控 · 实盘账户</p>
          <h1 className="flex items-center gap-2 text-xl font-semibold sm:text-2xl"><Activity size={21} />监控面板</h1>
          <p className="mt-2 text-xs leading-5 text-[var(--tv-muted)] sm:text-sm">有持仓的账户各一张卡片：余额、实时浮动盈亏、K 线图与持仓 / 止盈止损线。出现持仓自动出现，平仓后自动消失。</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-[var(--tv-muted)]">
          {lastRefresh && <span>最后刷新 {new Date(lastRefresh).toLocaleTimeString('zh-CN', { hour12: false })}</span>}
          <button className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-[var(--tv-border)] px-3 py-1.5 text-xs hover:bg-[var(--tv-border)]"
            aria-label="刷新监控面板" onClick={() => setRefreshKey(value => value + 1)}><RefreshCw size={14} />刷新</button>
        </div>
      </header>

      {error && <p role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">{error}</p>}

      {!snapshots.length && !error && <div className="rounded-xl border border-[var(--tv-border)] bg-[var(--tv-panel)] p-6 text-center text-sm text-[var(--tv-muted)]">
        {lastRefresh ? '当前没有持仓账户。' : '正在读取账户持仓…'}
      </div>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">
        {snapshots.map(snapshot => <MonitorAccountCard key={snapshot.account.name} snapshot={snapshot} />)}
      </div>
    </div>
  </div>;
}
