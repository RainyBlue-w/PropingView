import { displayBridgeAccount } from '@/lib/bridgeAccounts';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { ArrowDown, ArrowUp, ChartCandlestick, Minus } from 'lucide-react';
import type { Nt8Account, Nt8Execution } from '@/lib/nt8Trading';
import type { FeedAdapter } from '@/types/market';
import type { BridgeProvider } from '@/lib/config';
import { executionDirection, executionTime, formatMoney } from '@/lib/tradeAnalytics';
import { getTradeAccountGroups, rememberTradeAccounts, subscribeTradeAccountGroups, tradeHistoryFilterOptions } from '@/lib/tradeHistoryFilters';
import { buildTradeRecords, filterTradeRecords, summarizeTradeRecords } from '@/lib/tradeRecords';
import PerformanceSummary from './PerformanceSummary';
import TradeDetailsLoader from './TradeDetailsLoader';

interface Props { rows: Nt8Execution[]; accounts?: Nt8Account[]; title?: string; showFilters?: boolean; adapter?: FeedAdapter; toTime?: number; historyProvider?: BridgeProvider }
const field = 'rounded-md border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 py-2 text-sm text-[var(--tv-text)]';

export default function TradeHistory({ rows, accounts, title = '配对交易记录', showFilters = true, adapter, toTime, historyProvider }: Props) {
  const accountLabels = useMemo(() => new Map([
    ...rows.filter(row => row.account && row.accountDisplayName).map(row => [row.account!, row.accountDisplayName!] as const),
    ...(accounts || []).map(account => [account.name, account.displayName || displayBridgeAccount(account.name)] as const),
  ]), [rows, accounts]);
  const accountLabel = (id: string) => accountLabels.get(id) || displayBridgeAccount(id);
  const [group, setGroup] = useState('');
  const [account, setAccount] = useState('');
  const [symbol, setSymbol] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const accountGroups = useSyncExternalStore(subscribeTradeAccountGroups, getTradeAccountGroups);
  useEffect(() => { if (accounts) rememberTradeAccounts(accounts); }, [accounts]);
  const options = useMemo(() => tradeHistoryFilterOptions(rows, accountGroups, group), [rows, accountGroups, group]);
  const records = useMemo(() => buildTradeRecords(rows), [rows]);
  const { records: filtered, dateError } = useMemo(() => filterTradeRecords(records, { group, account, symbol, startDate, endDate }, accountGroups), [records, accountGroups, group, account, symbol, startDate, endDate]);
  const summary = useMemo(() => summarizeTradeRecords(filtered), [filtered]);
  const selected = records.find(record => record.id === selectedId);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 100));
  const currentPage = Math.min(page, pageCount - 1);
  const shown = filtered.slice(currentPage * 100, (currentPage + 1) * 100);
  return <div className="space-y-5">
    {showFilters && <div className="flex flex-wrap items-end gap-4 rounded-xl border border-[var(--tv-border)] bg-[var(--tv-panel)] p-5">
      <label className="text-xs text-[var(--tv-muted)]">账户组<select aria-label="记录账户组" className={`${field} mt-2 block min-w-44`} value={group} onChange={e => { setGroup(e.target.value); setAccount(''); setPage(0); }}><option value="">全部账户组</option>{options.groups.map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="text-xs text-[var(--tv-muted)]">账户<select aria-label="记录账户" className={`${field} mt-2 block min-w-44`} value={account} onChange={e => { setAccount(e.target.value); setPage(0); }}><option value="">全部账户</option>{options.accounts.map(value => <option key={value} value={value}>{accountLabel(value)}</option>)}</select></label>
      <label className="text-xs text-[var(--tv-muted)]">合约<select aria-label="记录合约" className={`${field} mt-2 block min-w-44`} value={symbol} onChange={e => { setSymbol(e.target.value); setPage(0); }}><option value="">全部合约</option>{options.symbols.map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="text-xs text-[var(--tv-muted)]">开始日期<input aria-label="记录开始日期" aria-invalid={Boolean(dateError)} aria-describedby={dateError ? 'trade-history-date-error' : undefined} type="date" className={`${field} mt-2 block`} value={startDate} onChange={e => { setStartDate(e.target.value); setPage(0); }} /></label>
      <label className="text-xs text-[var(--tv-muted)]">结束日期<input aria-label="记录结束日期" aria-invalid={Boolean(dateError)} aria-describedby={dateError ? 'trade-history-date-error' : undefined} type="date" className={`${field} mt-2 block`} value={endDate} onChange={e => { setEndDate(e.target.value); setPage(0); }} /></label>
      <button className={field} onClick={() => { setGroup(''); setAccount(''); setSymbol(''); setStartDate(''); setEndDate(''); setPage(0); }}>重置筛选</button>
      <p className="w-full text-xs text-[var(--tv-muted)]">账户组按 NT8 / ATAS X 来源与连接划分 · {startDate || endDate ? '所选日期包含起止日全天' : '全部日期'} · 已平仓按离场时间筛选、未配对按成交时间筛选 · 最新记录在前 · 本机时区</p>
      {dateError && <p id="trade-history-date-error" role="alert" className="w-full text-sm text-[#ef5350]">{dateError}</p>}
    </div>}
    <PerformanceSummary rows={rows} summary={summary} recordCount={filtered.length} />
    <section aria-label="配对交易记录" className="overflow-hidden rounded-xl border border-[var(--tv-border)] bg-[var(--tv-panel)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--tv-border)] px-5 py-4"><h2 className="font-medium">{title}</h2><span className="text-xs text-[var(--tv-muted)]">共 {filtered.length} 笔交易 · 点击记录查看图表</span></div>
      <div className="border-b border-[var(--tv-border)] px-5 py-3 text-xs text-[var(--tv-muted)]">同一账户、合约和币种按先进先出配对，部分平仓分别列出。盈亏额为扣除手续费后的净盈亏；缺少计算资料时显示 —。</div>
      <div className="overflow-x-auto"><table className="account-table"><thead><tr><th>入场时间</th><th>离场时间</th><th>账户</th><th>合约</th><th>方向</th><th>数量</th><th>入场价格</th><th>离场价格</th><th>盈亏额</th><th>状态</th><th>详情</th></tr></thead><tbody>
        {shown.map(record => { const e = record.entry, exit = record.exit; const direction = executionDirection(e.side); return <tr key={record.id} data-trade-record={record.status} onClick={() => setSelectedId(record.id)} className="cursor-pointer hover:bg-[#2962ff]/10">
          <td className="whitespace-nowrap">{Number.isFinite(executionTime(e)) ? new Date(executionTime(e) * 1000).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
          <td className="whitespace-nowrap">{exit ? new Date(executionTime(exit) * 1000).toLocaleString('zh-CN', { hour12: false }) : '—'}</td>
          <td>{accountLabel(e.account || '')}</td><td className="whitespace-nowrap font-medium">{e.instrument || '未知合约'}</td>
          <td><span className={`inline-flex items-center gap-1 whitespace-nowrap ${direction > 0 ? 'text-[#26a69a]' : direction < 0 ? 'text-[#ef5350]' : 'text-[var(--tv-muted)]'}`}>{direction > 0 ? <ArrowUp size={15} aria-hidden="true" /> : direction < 0 ? <ArrowDown size={15} aria-hidden="true" /> : <Minus size={15} aria-hidden="true" />}{direction > 0 ? '做多' : direction < 0 ? '做空' : '方向未知'}</span></td>
          <td>{Number.isFinite(record.qty) ? record.qty : '—'}</td><td className="font-mono">{Number.isFinite(e.price) ? e.price : '—'}</td><td className="font-mono">{exit ? exit.price : '—'}</td>
          <td className={`whitespace-nowrap font-mono ${record.net == null ? 'text-[var(--tv-muted)]' : record.net >= 0 ? 'text-[#26a69a]' : 'text-[#ef5350]'}`}>{formatMoney(record.net, record.currency)}</td>
          <td className={`whitespace-nowrap text-xs ${record.status === 'closed' ? 'text-[var(--tv-muted)]' : 'text-amber-500'}`}>{record.status === 'closed' ? '已平仓' : record.status === 'unpaired' ? '未配对' : '资料不全'}</td>
          <td><button className="rounded p-1.5 text-[#638dff] hover:bg-[#2962ff]/10" aria-label={`查看交易详情 ${record.id}`} onClick={event => { event.stopPropagation(); setSelectedId(record.id); }}><ChartCandlestick size={17} /></button></td>
        </tr>; })}
        {!shown.length && <tr><td colSpan={11} className="py-12 text-center text-[var(--tv-muted)]">暂无符合筛选条件的交易记录</td></tr>}
      </tbody></table></div>
      <div className="flex items-center justify-between border-t border-[var(--tv-border)] px-5 py-4 text-sm"><span className="text-[var(--tv-muted)]">第 {currentPage + 1} / {pageCount} 页 · 每页 100 笔</span><div className="flex gap-2"><button className={`${field} disabled:opacity-40`} disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button><button className={`${field} disabled:opacity-40`} disabled={currentPage >= pageCount - 1} onClick={() => setPage(currentPage + 1)}>下一页</button></div></div>
    </section>
    {selected && <TradeDetailsLoader key={selected.id} row={selected.exit ?? selected.entry} rows={rows} trade={selected.pair} unpairedQty={selected.status === 'unpaired' ? selected.qty : undefined} adapter={adapter} toTime={toTime} historyProvider={historyProvider} onClose={() => setSelectedId(null)} />}
  </div>;
}
