import { useState, type FormEvent } from 'react';
import { ChartNoAxesCombined, ChevronDown, ChevronUp, Clock3, Play, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import TradeHistory from '@/components/TradeHistory';
import { bridgeProviderName, type BridgeProvider } from '@/lib/config';
import type { NewReplaySessionInput, ReplaySession } from '@/lib/replayStore';

export interface ReplayDashboardProps {
  sessions: ReplaySession[];
  onCreate: (input: NewReplaySessionInput) => void | Promise<void>;
  onResume: (session: ReplaySession) => void | Promise<void>;
  onDelete: (id: string) => void | Promise<void>;
  defaultSymbol?: string;
  symbols?: string[];
  storageError?: string;
  provider?: BridgeProvider;
}

function localDateTime(time: number): string {
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function money(value: number | null): string {
  return value === null ? '—' : `${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
}

function unrealized(session: ReplaySession): number | null {
  let result = 0;
  for (const position of session.state.positions) {
    if (!position.quantity) continue;
    const last = session.lastPrices[position.instrument];
    const pointValue = session.pointValues[position.instrument];
    if (!Number.isFinite(last) || !Number.isFinite(pointValue) || pointValue <= 0) return null;
    result += (last - position.averagePrice) * position.quantity * pointValue;
  }
  return result;
}

const pnlColor = (value: number | null) => value === null || value === 0
  ? 'text-[var(--tv-text)]' : value > 0 ? 'text-[#26a69a]' : 'text-[#ef5350]';

export default function ReplayDashboard({
  sessions, onCreate, onResume, onDelete, defaultSymbol = '', symbols = [], storageError, provider = 'nt8',
}: ReplayDashboardProps) {
  const [name, setName] = useState(() => `回放 ${new Date().toLocaleDateString()}`);
  const [symbolDraft, setSymbolDraft] = useState<string | null>(null);
  const [startDraft, setStartDraft] = useState(() => localDateTime(Date.now() - 3 * 86400000));
  const [equityDraft, setEquityDraft] = useState('100000');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ReplaySession | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const selected = sessions.find(session => session.id === selectedId);
  const symbol = symbolDraft ?? defaultSymbol;
  const inputClass = 'h-9 w-full min-w-0 rounded-md border border-[var(--tv-border)] bg-[var(--tv-bg)] px-3 text-sm text-[var(--tv-text)]';
  const buttonClass = 'border-[var(--tv-border)] bg-[var(--tv-panel)] text-[var(--tv-text)] hover:bg-[var(--tv-border)] hover:text-[var(--tv-text)]';

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const startTime = Math.floor(new Date(startDraft).getTime() / 1000);
    const initialEquity = Number(equityDraft);
    if (!name.trim() || !symbol.trim() || !Number.isFinite(startTime) || startTime <= 0
      || startTime >= Date.now() / 1000 || !Number.isFinite(initialEquity) || initialEquity <= 0) {
      setActionError('请填写名称、完整合约名、过去的开始时间及大于零的初始资金。');
      return;
    }
    setBusy(true);
    setActionError('');
    try {
      await onCreate({ name: name.trim(), symbol: symbol.trim(), startTime, initialEquity });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const resume = async (session: ReplaySession) => {
    if (busy) return;
    setBusy(true);
    setActionError('');
    try {
      await onResume(session);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget || busy) return;
    setBusy(true);
    setDeleteError('');
    try {
      await onDelete(deleteTarget.id);
      setSelectedId(id => id === deleteTarget.id ? null : id);
      setDeleteTarget(null);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="h-full overflow-auto bg-[var(--tv-bg)] p-4 text-[var(--tv-text)] md:p-6" aria-label="回放模拟工作台">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold"><RotateCcw className="h-5 w-5 text-[#2962ff]" />回放模拟</h1>
            <p className="mt-1 text-sm text-[var(--tv-muted)]">两桥会话统一保存；继续回放和查看记录时，使用会话原来的行情源。</p>
          </div>
          <span className="rounded-full border border-[var(--tv-border)] px-3 py-1 text-xs text-[var(--tv-muted)]">{sessions.length} 个会话 · 本机保存</span>
        </header>

        {(storageError || actionError) && (
          <div role="alert" className="space-y-1 rounded-md border border-[#ef5350]/40 bg-[#ef5350]/10 p-3 text-sm text-[#ef5350]">
            {storageError && <p>{storageError}</p>}
            {actionError && <p>{actionError}</p>}
          </div>
        )}

        <section className="rounded-xl border border-[var(--tv-border)] bg-[var(--tv-panel)] p-4 md:p-5" aria-label="新建回放会话">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold"><Plus className="h-4 w-4" />新建会话 · {bridgeProviderName(provider)}</h2>
          <form onSubmit={submit} className="grid items-end gap-4 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1.2fr_1fr_auto]">
            <label className="space-y-1.5 text-xs text-[var(--tv-muted)]"><span>会话名称</span>
              <input aria-label="会话名称" required maxLength={100} value={name} onChange={event => setName(event.target.value)} className={inputClass} />
            </label>
            <label className="space-y-1.5 text-xs text-[var(--tv-muted)]"><span>合约</span>
              <input aria-label="回放合约" required list="replay-session-symbols" value={symbol} onChange={event => setSymbolDraft(event.target.value)} placeholder="例如 NQ SEP26" className={inputClass} />
              <datalist id="replay-session-symbols">{[...new Set(symbols)].map(value => <option key={value} value={value} />)}</datalist>
            </label>
            <label className="space-y-1.5 text-xs text-[var(--tv-muted)]"><span>开始时间（本地时间）</span>
              <input aria-label="回放会话开始时间" required type="datetime-local" max={localDateTime(Date.now())} value={startDraft} onChange={event => setStartDraft(event.target.value)} className={inputClass} />
            </label>
            <label className="space-y-1.5 text-xs text-[var(--tv-muted)]"><span>初始资金 · USD</span>
              <input aria-label="初始资金" required type="number" min="0.01" step="0.01" value={equityDraft} onChange={event => setEquityDraft(event.target.value)} className={inputClass} />
            </label>
            <Button type="submit" disabled={busy} className="h-9 gap-1.5 bg-[#2962ff] text-white hover:bg-[#2962ff]/90"><Play className="h-4 w-4" />创建并开始</Button>
          </form>
        </section>

        <section aria-label="已保存的回放会话" className="space-y-3">
          <h2 className="text-sm font-semibold">我的会话</h2>
          {sessions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--tv-border)] p-10 text-center text-sm text-[var(--tv-muted)]">
              尚无回放会话。创建后可以随时保存退出，再从上次进度继续。
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
              {sessions.map(session => {
                const unreal = unrealized(session);
                const cash = session.initialEquity + session.state.realized;
                const equity = unreal === null ? null : cash + unreal;
                const expanded = selectedId === session.id;
                return (
                  <article key={session.id} data-replay-session={session.id} className={`rounded-xl border bg-[var(--tv-panel)] p-4 ${expanded ? 'border-[#2962ff]' : 'border-[var(--tv-border)]'}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate font-semibold" title={session.name}>{session.name}</h3>
                        <p className="mt-1 text-xs text-[var(--tv-muted)]">{bridgeProviderName(session.provider ?? 'nt8')} · {session.symbol} · {session.state.executions.length} 笔成交</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <ChartNoAxesCombined className="h-5 w-5 text-[#2962ff]" />
                        <Button type="button" size="icon" variant="ghost" disabled={busy}
                          aria-label={`删除回放会话 ${session.name}`} title="删除会话"
                          onClick={() => { setDeleteError(''); setDeleteTarget(session); }}
                          className="h-8 w-8 text-[var(--tv-muted)] hover:bg-[#ef5350]/10 hover:text-[#ef5350]">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    <dl className="my-4 grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
                      <div><dt className="mb-1 text-[var(--tv-muted)]">账户净值</dt><dd className="font-mono tabular-nums">{money(equity)}</dd></div>
                      <div><dt className="mb-1 text-[var(--tv-muted)]">初始资金</dt><dd className="font-mono tabular-nums">{money(session.initialEquity)}</dd></div>
                      <div><dt className="mb-1 text-[var(--tv-muted)]">已实现盈亏</dt><dd className={`font-mono tabular-nums ${pnlColor(session.state.realized)}`}>{money(session.state.realized)}</dd></div>
                      <div><dt className="mb-1 text-[var(--tv-muted)]">浮动盈亏</dt><dd className={`font-mono tabular-nums ${pnlColor(unreal)}`}>{money(unreal)}</dd></div>
                    </dl>
                    <div className="space-y-1 border-t border-[var(--tv-border)] pt-3 text-[11px] text-[var(--tv-muted)]">
                      <p className="flex items-center gap-1.5"><Clock3 className="h-3 w-3" />回放至 {new Date(session.cursor * 1000).toLocaleString()}</p>
                      <p>保存于 {new Date(session.updatedAt).toLocaleString()} · {session.state.orders.length} 笔挂单</p>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button size="sm" variant="outline" aria-expanded={expanded} onClick={() => setSelectedId(expanded ? null : session.id)} className={`gap-1 text-xs ${buttonClass}`}>
                        表现与记录{expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      </Button>
                      <Button size="sm" disabled={busy} onClick={() => void resume(session)} className="gap-1 bg-[#2962ff] text-xs text-white hover:bg-[#2962ff]/90"><Play className="h-3.5 w-3.5" />继续回放</Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {selected && (
          <section className="rounded-xl border border-[var(--tv-border)] bg-[var(--tv-panel)] p-4" aria-label={`${selected.name} 的表现与记录`}>
            <div className="mb-4 flex items-center justify-between gap-3">
              <div><h2 className="font-semibold">{selected.name}</h2><p className="mt-1 text-xs text-[var(--tv-muted)]">开始于 {new Date(selected.startTime * 1000).toLocaleString()} · 初始资金 {money(selected.initialEquity)}</p></div>
              <Button size="sm" variant="ghost" onClick={() => setSelectedId(null)} className="text-[var(--tv-muted)]">收起</Button>
            </div>
            <TradeHistory key={selected.id} rows={selected.state.executions} title="会话交易记录" showFilters historyProvider={selected.provider ?? 'nt8'} toTime={selected.cursor} />
          </section>
        )}
      </div>
      <AlertDialog open={deleteTarget !== null} onOpenChange={open => { if (!open && !busy) setDeleteTarget(null); }}>
        <AlertDialogContent className="border-[var(--tv-border)] bg-[var(--tv-panel)] text-[var(--tv-text)]">
          <AlertDialogHeader>
            <AlertDialogTitle>删除回放会话？</AlertDialogTitle>
            <AlertDialogDescription className="break-words text-[var(--tv-muted)]">
              将删除「{deleteTarget?.name}」的回放进度和全部模拟交易记录，无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p role="alert" className="text-sm text-[#ef5350]">{deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy} className={buttonClass}>取消</AlertDialogCancel>
            <Button type="button" disabled={busy} onClick={() => void remove()} className="bg-[#ef5350] text-white hover:bg-[#ef5350]/90">
              {busy ? '删除中…' : '删除会话'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}
