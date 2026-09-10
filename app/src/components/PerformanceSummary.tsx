import { useMemo } from 'react';
import type { Nt8Execution } from '@/lib/nt8Trading';
import { analyzeTrades, formatMoney } from '@/lib/tradeAnalytics';

export default function PerformanceSummary({ rows, summary, recordCount }: { rows: Nt8Execution[]; summary?: ReturnType<typeof analyzeTrades>; recordCount?: number }) {
  const stats = useMemo(() => summary ?? analyzeTrades(rows), [rows, summary]);
  const count = recordCount ?? rows.length;
  return <section aria-label="交易表现统计" className="space-y-4 rounded-xl border border-[var(--tv-border)] bg-[var(--tv-panel)] p-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">交易表现</h2><span className="text-xs text-[var(--tv-muted)]">全部筛选结果 · {count} 笔{recordCount == null ? '成交' : '交易'} · {stats.trades.length} 个 FIFO 平仓批次</span></div>
    {stats.summaries.map(s => <div key={s.currency}>
      <p className="mb-3 text-xs font-medium text-[var(--tv-muted)]">{s.currency}{s.missing ? ` · ${s.missing} 个批次缺少点值或手续费，仅统计可计算部分` : ''}</p>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {[
          ['已配对净盈亏', formatMoney(s.net, s.currency)],
          ['胜率', s.winRate == null ? '—' : `${(s.winRate * 100).toFixed(1)}%`],
          ['盈亏因子', s.profitFactor == null ? '—' : s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)],
          ['最大回撤', formatMoney(s.maxDrawdown, s.currency)],
          ['已知手续费', formatMoney(s.fees, s.currency)],
          ['平均净盈亏 / 批次', formatMoney(s.net != null && s.known ? s.net / s.known : undefined, s.currency)],
        ].map(([label, value]) => <div key={label}><div className="text-xs text-[var(--tv-muted)]">{label}</div><div className={`mt-2 break-words text-lg font-semibold tabular-nums ${label === '已配对净盈亏' && s.net != null ? s.net > 0 ? 'text-[#26a69a]' : s.net < 0 ? 'text-[#ef5350]' : '' : ''}`}>{value}</div></div>)}
      </div>
      {s.missingFees > 0 && <p className="mt-3 text-xs text-amber-500">{s.missingFees} 笔成交未提供手续费。</p>}
    </div>)}
    {!count && <p className="text-sm text-[var(--tv-muted)]">暂无可统计的交易。</p>}
    <p className="text-xs leading-relaxed text-[var(--tv-muted)]">按账户、合约、币种独立 FIFO 配对，净盈亏扣除进出场按数量分摊的手续费。回撤基于已配对净盈亏曲线，不含持仓浮盈亏。{stats.openLots.length > 0 ? ` ${stats.openLots.length} 个剩余批次未配对，可能是未平仓或缺失另一侧历史。` : ''}{stats.invalid > 0 ? ` ${stats.invalid} 笔资料不全的成交未参与配对。` : ''}</p>
  </section>;
}
