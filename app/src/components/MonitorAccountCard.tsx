import { useCallback, useMemo, useState } from 'react';
import MonitorChart from '@/components/MonitorChart';
import { parseBridgeAccount } from '@/lib/bridgeAccounts';
import { bridgeProviderName } from '@/lib/config';
import { resolvePointValue } from '@/lib/draftCalc';
import { defaultInstrument, findProtection, openPositions, positionPnl, totalUnrealized, type MonitorSnapshot } from '@/lib/monitorData';
import { formatMoney } from '@/lib/tradeAnalytics';

const INTERVALS = [{ sec: 60, label: '1分' }, { sec: 300, label: '5分' }, { sec: 900, label: '15分' }, { sec: 3600, label: '60分' }] as const;
const pnlColor = (value: number | null) => value == null ? 'text-[var(--tv-muted)]' : value >= 0 ? 'text-[#26a69a]' : 'text-[#ef5350]';

/** 监控卡片:单个有持仓账户的余额、实时浮动盈亏和内嵌 K 线(持仓线 + TP/SL 线);只读 */
export default function MonitorAccountCard({ snapshot }: { snapshot: MonitorSnapshot }) {
  const { account, positions, orders } = snapshot;
  const open = useMemo(() => openPositions(positions), [positions]);
  // 只存用户显式选择;选中合约的持仓消失时自动回退到当前最大持仓,无需 effect
  const [choice, setChoice] = useState<string | null>(null);
  const selected = choice && open.some(p => p.instrument === choice) ? choice : (defaultInstrument(positions) ?? '');
  const [prices, setPrices] = useState<ReadonlyMap<string, number>>(new Map());
  const [pointValues, setPointValues] = useState<ReadonlyMap<string, number>>(new Map());
  const [intervalSec, setIntervalSec] = useState<number>(300);

  const handlePrice = useCallback((instrument: string, price: number) => {
    setPrices(prev => { const next = new Map(prev); next.set(instrument.toUpperCase(), price); return next; });
  }, []);
  const handlePointValue = useCallback((instrument: string, pointValue: number) => {
    setPointValues(prev => { const next = new Map(prev); next.set(instrument.toUpperCase(), pointValue); return next; });
  }, []);

  const currency = account.currency;
  const provider = account.provider ?? parseBridgeAccount(account.name).provider;
  const position = open.find(p => p.instrument === selected) ?? null;
  const protection = useMemo(() => findProtection(orders, selected), [orders, selected]);
  // 未接入实时价的合约先用点值兜底表,与终端其他估算口径一致;缺实时价时合计回退桥端值
  const effectivePointValues = useMemo(() => {
    const map = new Map(pointValues);
    for (const p of open) {
      const key = p.instrument.toUpperCase();
      if (!map.has(key)) map.set(key, resolvePointValue(p.instrument, undefined));
    }
    return map;
  }, [open, pointValues]);
  const total = totalUnrealized(positions, prices, effectivePointValues, account.unrealizedPnl);

  return <section className="space-y-3 rounded-xl border border-[var(--tv-border)] bg-[var(--tv-panel)] p-3 sm:p-4" data-monitor-card>
    <header className="flex flex-wrap items-center gap-2">
      <h2 className="min-w-0 truncate text-sm font-semibold" title={account.displayName || account.name}>{account.displayName || account.name}</h2>
      <span className="shrink-0 rounded bg-[var(--tv-border)] px-1.5 py-0.5 text-[10px] text-[var(--tv-muted)]">
        {bridgeProviderName(provider)}{account.connection ? ` · ${account.connection.replace(/^.*? · /, '')}` : ''}
      </span>
      {snapshot.syncError && <span className="shrink-0 text-[10px] text-amber-500" title={snapshot.syncError}>保护同步异常</span>}
    </header>

    <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
      <div><p className="text-[var(--tv-muted)]">净清算</p><p className="mt-0.5 font-medium">{formatMoney(account.netLiquidation, currency)}</p></div>
      <div><p className="text-[var(--tv-muted)]">现金</p><p className="mt-0.5 font-medium">{formatMoney(account.cashValue, currency)}</p></div>
      <div><p className="text-[var(--tv-muted)]">当日已实现</p><p className={`mt-0.5 font-medium ${pnlColor(account.realizedPnl ?? null)}`}>{formatMoney(account.realizedPnl, currency)}</p></div>
      <div>
        <p className="text-[var(--tv-muted)]">浮动盈亏{total.live ? ' · 实时' : ' · 桥端'}</p>
        <p className={`mt-0.5 font-medium ${pnlColor(total.value)}`}>{formatMoney(total.value, currency)}</p>
      </div>
    </div>

    <div className="flex flex-wrap items-center gap-1">
      {open.length > 1 && open.map(p => <button
        key={p.instrument} type="button" title={p.instrument} aria-pressed={selected === p.instrument}
        onClick={() => setChoice(p.instrument)}
        className={`max-w-40 truncate rounded px-2 py-1 text-[11px] ${selected === p.instrument ? 'bg-[#2962ff]/15 text-[#5b8cff]' : 'text-[var(--tv-muted)] hover:bg-[var(--tv-border)] hover:text-[var(--tv-text)]'}`}>
        {p.instrument}
      </button>)}
      <div role="group" aria-label="K线周期" className="ml-auto flex items-center rounded border border-[var(--tv-border)]">
        {INTERVALS.map(item => <button
          key={item.sec} type="button" aria-pressed={intervalSec === item.sec}
          onClick={() => setIntervalSec(item.sec)}
          className={`rounded px-1.5 py-0.5 text-[10px] ${intervalSec === item.sec ? 'bg-[#2962ff]/15 text-[#5b8cff]' : 'text-[var(--tv-muted)] hover:bg-[var(--tv-border)]'}`}>
          {item.label}
        </button>)}
      </div>
    </div>

    <ul className="space-y-1 text-xs">
      {open.map(p => {
        const key = p.instrument.toUpperCase();
        const pnl = positionPnl(p, prices.get(key), effectivePointValues.get(key));
        return <li key={p.instrument} className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="min-w-0 truncate font-medium" title={p.instrument}>{p.instrument}</span>
          <span className="text-[var(--tv-muted)]">{p.quantity > 0 ? '+' : ''}{p.quantity} @ {p.averagePrice}</span>
          <span className={`ml-auto ${pnlColor(pnl)}`}>{formatMoney(pnl, currency)}</span>
        </li>;
      })}
    </ul>

    {position && selected && <MonitorChart
      provider={provider} instrument={selected} intervalSec={intervalSec}
      position={position} protection={protection}
      onPrice={handlePrice} onPointValue={handlePointValue}
    />}
  </section>;
}
