import { displayBridgeAccount } from '@/lib/bridgeAccounts';
import { useMemo, useState } from 'react';
import { LayoutGrid, List, RefreshCw, Wallet } from 'lucide-react';
import type { Nt8Account } from '@/lib/nt8Trading';
import { formatMoney, normalizeCurrency } from '@/lib/tradeAnalytics';
import { syncHistoryNow, useHistoryArchive } from '@/lib/historyStore';
import TradeHistory from '@/components/TradeHistory';

interface Props { page: 'overview' | 'records'; accounts: Nt8Account[]; error: string | null; enabled: boolean; onRefresh: () => void }
const panel = 'rounded-xl border border-[var(--tv-border)] bg-[var(--tv-panel)]';
const field = 'rounded-md border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 py-2 text-sm text-[var(--tv-text)]';
const pnlColor = (v?: number) => v == null || v === 0 ? '' : v > 0 ? 'text-[#26a69a]' : 'text-[#ef5350]';
const providerName = 'NT8 / ATAS X';
const MODE_KEY = 'nt8-terminal-account-overview-mode';

export default function AccountPages({ page, accounts, error, enabled, onRefresh }: Props) {
  const archive = useHistoryArchive();
  const [mode, setMode] = useState<'cards' | 'list'>(() => { try { return localStorage.getItem(MODE_KEY) === 'list' ? 'list' : 'cards'; } catch { return 'cards'; } });
  const groups = useMemo(() => {
    const map = new Map<string, Nt8Account[]>();
    for (const account of accounts) { const connection = account.connection || '本地账户'; const group = map.get(connection) || []; group.push(account); map.set(connection, group); }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [accounts]);
  const chooseMode = (value: 'cards' | 'list') => { setMode(value); try { localStorage.setItem(MODE_KEY, value); } catch { /* Display remains usable without browser storage. */ } };
  return <div className="h-full overflow-auto bg-[var(--tv-bg)] p-6 text-[var(--tv-text)] sm:p-8"><div className="mx-auto max-w-7xl space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div><p className="mb-2 text-xs tracking-widest text-[var(--tv-muted)]">{providerName} TERMINAL</p><h1 className="text-2xl font-semibold">{page === 'overview' ? '账户总览' : '交易记录'}</h1><p className="mt-2 text-sm text-[var(--tv-muted)]">{page === 'overview' ? '按连接分组查看所有账户的资金与盈亏。' : '按完整成交历史配对，查看每笔交易的入场、离场与盈亏。'}</p></div>
      <div className="flex items-center gap-2">
        {page === 'overview' && <div role="group" aria-label="账户显示模式" className="flex rounded-lg border border-[var(--tv-border)] p-1">
          <button aria-label="卡片模式" aria-pressed={mode === 'cards'} onClick={() => chooseMode('cards')} className={`flex items-center gap-2 rounded px-3 py-1.5 text-sm ${mode === 'cards' ? 'bg-[#2962ff] text-white' : 'text-[var(--tv-muted)]'}`}><LayoutGrid size={15} />卡片</button>
          <button aria-label="列表模式" aria-pressed={mode === 'list'} onClick={() => chooseMode('list')} className={`flex items-center gap-2 rounded px-3 py-1.5 text-sm ${mode === 'list' ? 'bg-[#2962ff] text-white' : 'text-[var(--tv-muted)]'}`}><List size={15} />列表</button>
        </div>}
        <button className={`${field} inline-flex items-center gap-2 disabled:opacity-50`} disabled={page === 'records' && archive.syncing} onClick={() => { if (page === 'records') void syncHistoryNow(); else onRefresh(); }} aria-label={page === 'overview' ? '刷新账户' : '同步成交记录'}><RefreshCw size={15} className={page === 'records' && archive.syncing ? 'animate-spin' : ''} />{page === 'overview' ? '刷新' : archive.syncing ? '同步中' : '同步记录'}</button>
      </div>
    </div>
    {page === 'overview' ? <>
      {!enabled && <div role="status" className={`${panel} p-4 text-sm text-amber-500`}>尚未连接 {providerName}，显示最后取得的账户数据。</div>}
      {error && <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-400">{error}</div>}
      <div className="text-sm text-[var(--tv-muted)]">{accounts.length} 个账户 · {groups.length} 个连接分组</div>
      {groups.map(([connection, group]) => <section key={connection} aria-label={`账户分组 ${connection}`} className="space-y-3">
        <h2 className="flex items-center gap-2 font-medium"><span className="h-2 w-2 rounded-full bg-[#638dff]" />{connection}<span className="text-xs font-normal text-[var(--tv-muted)]">{group.length} 个账户</span></h2>
        {mode === 'cards' ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{group.map(a => <article key={a.name} className={`${panel} p-5`}>
          <div className="mb-5 flex items-center justify-between gap-2"><div className="flex min-w-0 items-center gap-2"><Wallet size={17} className="shrink-0 text-[#638dff]" /><h3 className="truncate font-semibold">{a.displayName || displayBridgeAccount(a.name)}</h3></div><span className="rounded bg-[var(--tv-bg)] px-2 py-1 text-xs text-[var(--tv-muted)]">{normalizeCurrency(a.currency)}</span></div>
          <div className="mb-5"><p className="text-xs text-[var(--tv-muted)]">净清算价值</p><p className="mt-2 break-words text-2xl font-semibold tabular-nums">{formatMoney(a.netLiquidation, a.currency)}</p></div>
          <dl className="space-y-3 text-sm">{[{ label: '现金余额', value: a.cashValue }, { label: '已实现盈亏', value: a.realizedPnl, pnl: true }, { label: '未实现盈亏', value: a.unrealizedPnl, pnl: true }].map(item => <div key={item.label} className="flex flex-wrap justify-between gap-2"><dt className="text-[var(--tv-muted)]">{item.label}</dt><dd className={`font-mono ${item.pnl ? pnlColor(item.value) : ''}`}>{formatMoney(item.value, a.currency)}</dd></div>)}</dl>
        </article>)}</div> : <div className={`${panel} overflow-x-auto`}><table className="account-table"><thead><tr><th>账户</th><th>币种</th><th>现金余额</th><th>净清算价值</th><th>已实现盈亏</th><th>未实现盈亏</th></tr></thead><tbody>{group.map(a => <tr key={a.name}><td className="font-medium">{a.displayName || displayBridgeAccount(a.name)}</td><td>{normalizeCurrency(a.currency)}</td><td>{formatMoney(a.cashValue, a.currency)}</td><td>{formatMoney(a.netLiquidation, a.currency)}</td><td className={pnlColor(a.realizedPnl)}>{formatMoney(a.realizedPnl, a.currency)}</td><td className={pnlColor(a.unrealizedPnl)}>{formatMoney(a.unrealizedPnl, a.currency)}</td></tr>)}</tbody></table></div>}
      </section>)}
      {!accounts.length && <div className={`${panel} p-12 text-center text-[var(--tv-muted)]`}>暂无账户数据，连接 {providerName} 后会列出全部账户。</div>}
      <p className="text-xs text-[var(--tv-muted)]">余额和盈亏沿用 {providerName} 账户口径；缺失字段显示 —，不同币种分别显示。</p>
    </> : <>
      <div role="status" className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-[var(--tv-muted)]"><span>本机已保存 {archive.rows.length} 笔成交</span><span>{archive.loading ? '正在打开本地归档…' : archive.syncing ? '正在同步两桥成交记录…' : archive.lastSynced ? `上次同步：${new Date(archive.lastSynced * 1000).toLocaleString('zh-CN')}` : '等待首次同步'}</span></div>
      {archive.error && <div role="alert" className={`${panel} p-4 text-sm text-amber-500`}>{archive.error}</div>}
      {archive.archiveError && <div role="alert" className={`${panel} p-4 text-sm text-amber-500`}>{providerName} 磁盘归档：{archive.archiveError}</div>}
      {archive.legacy && <div role="status" className={`${panel} p-4 text-sm text-amber-500`}>当前桥尚未支持磁盘归档，网页仅能保存 {providerName} 此刻提供的记录；网页关闭期间的成交需升级数据桥后持续归档。旧桥未返回的历史无法补回。</div>}
      <TradeHistory rows={archive.rows} accounts={accounts} />
      <p className="text-xs text-[var(--tv-muted)]">成交以账户、合约和成交编号去重，部分成交逐笔保留。{providerName} 桥保存磁盘归档，浏览器保存本地查询副本；归档启用前已被上游清除的记录无法自动恢复。</p>
    </>}
  </div></div>;
}
