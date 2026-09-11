import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Plus, RefreshCw, Square, Trash2, X } from 'lucide-react';
import { bridgeProviderName } from '@/lib/config';
import { copyAccountKey, copyTrading, validateCopyRule, type CopyAccount, type CopyAccountInfo, type CopyFollower, type CopyRuleConfig, type CopySnapshot } from '@/lib/copyTrading';

const panel = 'rounded-xl border border-[var(--tv-border)] bg-[var(--tv-panel)]';
const field = 'min-h-9 w-full min-w-0 rounded-md border border-[var(--tv-border)] bg-[var(--tv-bg)] px-2.5 py-1.5 text-sm text-[var(--tv-text)]';
const button = 'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-[var(--tv-border)] px-3 py-1.5 text-xs hover:bg-[var(--tv-border)] disabled:cursor-not-allowed disabled:opacity-40';
const blankAccount = (): CopyAccount => ({ provider: 'nt8', name: '' });
const blankFollower = (): CopyFollower => ({ account: blankAccount(), multiplier: 1, maxOrderQuantity: 1, mappings: [] });
const freshRule = (): CopyRuleConfig => ({ id: '', name: '', leader: blankAccount(), followers: [blankFollower()] });
const errorText = (error: unknown) => error instanceof Error ? error.message : '复制服务请求失败，请稍后重试。';
const timeText = (value?: number) => value ? new Date(value < 1e12 ? value * 1000 : value).toLocaleString('zh-CN', { hour12: false }) : '—';
const states = { running: ['运行中', 'text-[#26a69a]'], stopped: ['已停用', 'text-[var(--tv-muted)]'], error: ['异常暂停', 'text-[#ef5350]'] } as const;

export default function CopyTradingPage() {
  const [snapshot, setSnapshot] = useState<CopySnapshot | null>(null);
  const [accounts, setAccounts] = useState<CopyAccountInfo[]>([]);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CopyRuleConfig | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [logRule, setLogRule] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const busyRef = useRef(false);
  const alive = useRef(false);
  const requestVersion = useRef(0);

  useEffect(() => {
    alive.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped) return;
      if (!busyRef.current) {
        const version = ++requestVersion.current;
        const results = await Promise.allSettled([copyTrading.getStatus(), copyTrading.getAccounts()]);
        if (!stopped && version === requestVersion.current) {
          const [status, directory] = results;
          if (status.status === 'fulfilled') { setSnapshot(status.value); setServiceError(null); }
          else setServiceError(`复制服务未连接或暂不可用：${errorText(status.reason)}`);
          if (directory.status === 'fulfilled') { setAccounts(directory.value.accounts); setAccountError(null); }
          else setAccountError(`账户目录读取失败：${errorText(directory.reason)}`);
        }
      }
      if (!stopped) timer = setTimeout(() => { void poll(); }, 3000);
    };
    void poll();
    // This numeric generation invalidates earlier requests; it is not a DOM reference.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { stopped = true; alive.current = false; requestVersion.current++; clearTimeout(timer); };
  }, [refreshKey]);

  const mutate = async (key: string, action: () => Promise<CopySnapshot>, completed?: () => void) => {
    if (busyRef.current) return;
    busyRef.current = true;
    requestVersion.current++;
    setBusy(key); setActionError(null);
    try {
      const next = await action();
      if (!alive.current) return;
      setSnapshot(next); setServiceError(null); completed?.();
    } catch (error) { if (alive.current) setActionError(errorText(error)); }
    finally { busyRef.current = false; if (alive.current) setBusy(null); }
  };

  const accountNames = useMemo(() => new Map(accounts.map(account => [copyAccountKey(account), account.displayName || account.name])), [accounts]);
  const label = (account: CopyAccount) => `${bridgeProviderName(account.provider)} · ${accountNames.get(copyAccountKey(account)) || account.name || '未选择'}`;
  const rules = snapshot?.rules || [];
  const editingRule = draft?.id ? rules.find(rule => rule.config.id === draft.id) : null;
  const locked = !!busy || editingRule?.status === 'running';
  const logs = [...(snapshot?.logs || [])].filter(log => !logRule || log.ruleId === logRule).sort((a, b) => b.time - a.time);
  const updateFollower = (index: number, patch: Partial<CopyFollower>) => setDraft(current => current && ({ ...current, followers: current.followers.map((row, i) => i === index ? { ...row, ...patch } : row) }));
  const edit = (config: CopyRuleConfig) => { setDraft(structuredClone(config)); setActionError(null); };
  const save = () => {
    if (!draft) return;
    const error = validateCopyRule(draft);
    if (error) { setActionError(error); return; }
    const config = { ...draft, name: draft.name.trim(), followers: draft.followers.map(follower => ({ ...follower,
      mappings: follower.mappings.map(mapping => ({ sourceSymbol: mapping.sourceSymbol.trim(), targetSymbol: mapping.targetSymbol.trim() })) })) };
    void mutate('save', () => copyTrading.saveRule(config), () => setDraft(null));
  };

  return <div className="h-full overflow-auto bg-[var(--tv-bg)] p-3 text-[var(--tv-text)] sm:p-6 lg:p-8" data-copy-trading-page>
    <div className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div><p className="mb-2 text-xs text-[var(--tv-muted)]">成交跟随 · 独立后台运行</p><h1 className="flex items-center gap-2 text-xl font-semibold sm:text-2xl"><Copy size={21} />复制交易</h1>
          <p className="mt-2 text-xs leading-5 text-[var(--tv-muted)] sm:text-sm">主账户实际成交后，跟随账户按倍率提交市价单。关闭网页后，已启用规则仍由后台运行。</p></div>
        <div className="flex flex-wrap gap-2">
          <button className={button} disabled={!!busy} onClick={() => setRefreshKey(value => value + 1)} aria-label="刷新复制服务"><RefreshCw size={14} />刷新</button>
          <button className={button} disabled={!!busy || !snapshot} onClick={() => void mutate('stop-all', copyTrading.stopAll)}><Square size={13} />全部停止</button>
          <button className={`${button} border-[#2962ff]/50 bg-[#2962ff]/15 text-[#5b8cff]`} disabled={!!busy} onClick={() => edit(freshRule())}><Plus size={14} />新建规则</button>
        </div>
      </header>

      <div className={`${panel} space-y-1.5 p-3 text-xs leading-5 text-[var(--tv-muted)] sm:p-4`}>
        <p>启用前，主账户和全部跟随账户须空仓且无工作订单。只跟随启用后的成交；未成交挂单不会复制，主账户止盈止损成交后才跟随。</p>
        <p>目标仓位按主账户净持仓 × 倍率向零取整，再按差量下单。跨桥须明确填写合约映射；未映射品种、断线、执行失败或手动改动跟随仓位会暂停。服务重启后规则停用。</p>
        <p className="text-amber-500">停用规则或全部停止只停止后续跟随，不会平仓。</p>
      </div>
      {serviceError && <div role="alert" className={`${panel} p-3 text-sm text-amber-500`}>{serviceError} <span>页面保留最后收到的状态。</span></div>}
      {actionError && <div role="alert" className="rounded-lg border border-[#ef5350]/40 bg-[#ef5350]/10 p-3 text-sm text-[#ef5350]">{actionError}</div>}
      {!snapshot && !serviceError && <p role="status" className="text-sm text-[var(--tv-muted)]">正在连接复制服务…</p>}

      <div className={`grid gap-5 ${draft ? 'xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]' : ''}`}>
        <section aria-label="复制规则" className="min-w-0 space-y-3">
          <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">复制规则</h2><span className="text-xs text-[var(--tv-muted)]">{rules.length} 条 · {rules.filter(rule => rule.status === 'running').length} 条运行中</span></div>
          {snapshot && !rules.length && <div className={`${panel} p-6 text-sm text-[var(--tv-muted)]`}>尚无复制规则。新建并保存后，规则默认停用。</div>}
          {rules.map(rule => <article key={rule.config.id} data-copy-rule={rule.config.id} className={`${panel} space-y-3 p-4`}>
            <div className="flex items-start justify-between gap-3"><h3 className="min-w-0 break-words font-medium">{rule.config.name}</h3><span className={`shrink-0 text-xs ${states[rule.status][1]}`}>{states[rule.status][0]}</span></div>
            <dl className="space-y-1 text-xs"><div><dt className="inline text-[var(--tv-muted)]">主账户：</dt><dd className="inline break-all">{label(rule.config.leader)}</dd></div>
              {rule.config.followers.map((follower, index) => <div key={copyAccountKey(follower.account)}><dt className="inline text-[var(--tv-muted)]">跟随 {index + 1}：</dt><dd className="inline break-all">{label(follower.account)} · {follower.multiplier} 倍 · 单笔 ≤ {follower.maxOrderQuantity} 手</dd></div>)}
            </dl>
            <p className="text-[11px] leading-5 text-[var(--tv-muted)]">已复制 {rule.copiedOrders} 笔 · 最近检查 {timeText(rule.lastPollAt)}</p>
            {rule.error && <p role="alert" className="break-words text-xs text-[#ef5350]">{rule.error}</p>}
            <div className="flex flex-wrap gap-2">
              {rule.status === 'running' ? <button className={button} disabled={!!busy} onClick={() => void mutate(rule.config.id, () => copyTrading.stopRule(rule.config.id))}>停止跟随</button>
                : <button className={`${button} text-[#26a69a]`} disabled={!!busy || !!serviceError} onClick={() => void mutate(rule.config.id, () => copyTrading.startRule(rule.config.id))}>启用跟随</button>}
              <button className={button} disabled={!!busy || rule.status === 'running'} onClick={() => edit(rule.config)}>编辑</button>
              <button className={button} disabled={!!busy || rule.status === 'running'} onClick={() => void mutate(rule.config.id, () => copyTrading.deleteRule(rule.config.id), () => { if (draft?.id === rule.config.id) setDraft(null); })} aria-label={`删除规则 ${rule.config.name}`}><Trash2 size={13} />删除</button>
            </div>
          </article>)}
        </section>

        {draft && <section aria-label="规则编辑" className={`${panel} min-w-0 self-start p-3 sm:p-5`}>
          <div className="mb-4 flex items-center justify-between gap-3"><h2 className="font-semibold">{draft.id ? '编辑规则' : '新建规则'}</h2><button className={button} disabled={!!busy} aria-label="关闭规则编辑" onClick={() => setDraft(null)}><X size={14} /></button></div>
          {editingRule?.status === 'running' && <p role="status" className="mb-3 text-xs text-amber-500">规则已由其他页面启用，请停止后再编辑。</p>}
          {accountError && <p role="alert" className="mb-3 text-xs text-amber-500">{accountError}</p>}
          <fieldset disabled={locked} className="min-w-0 space-y-4 disabled:opacity-60">
            <label className="block space-y-1 text-xs text-[var(--tv-muted)]"><span>规则名称</span><input aria-label="复制规则名称" className={field} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder="例如：主账户跟随组" /></label>
            <AccountSelect label="主账户" value={draft.leader} accounts={accounts} onChange={leader => setDraft({ ...draft, leader })} />
            <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">跟随账户</h3><button className={button} onClick={() => setDraft({ ...draft, followers: [...draft.followers, blankFollower()] })}><Plus size={13} />添加账户</button></div>
            {draft.followers.map((follower, index) => <div key={index} className="min-w-0 space-y-3 rounded-lg border border-[var(--tv-border)] p-3" data-copy-follower={index}>
              <div className="flex items-center justify-between gap-2"><h4 className="text-xs font-medium">跟随账户 {index + 1}</h4><button className={button} aria-label={`移除跟随账户 ${index + 1}`} onClick={() => setDraft({ ...draft, followers: draft.followers.filter((_, i) => i !== index) })}><Trash2 size={13} /></button></div>
              <AccountSelect label={`跟随账户 ${index + 1}`} value={follower.account} accounts={accounts} onChange={account => updateFollower(index, { account })} />
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1 text-xs text-[var(--tv-muted)]"><span>倍率</span><input className={field} aria-label={`跟随 ${index + 1} 倍率`} type="number" min="0" step="0.1" value={follower.multiplier} onChange={event => updateFollower(index, { multiplier: Number(event.target.value) })} /></label>
                <label className="space-y-1 text-xs text-[var(--tv-muted)]"><span>最大单笔手数</span><input className={field} aria-label={`跟随 ${index + 1} 最大单笔手数`} type="number" min="1" step="1" value={follower.maxOrderQuantity} onChange={event => updateFollower(index, { maxOrderQuantity: Number(event.target.value) })} /></label>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs">合约映射{follower.account.provider !== draft.leader.provider ? '（跨桥必填）' : '（同桥可留空）'}</span><button className={button} onClick={() => updateFollower(index, { mappings: [...follower.mappings, { sourceSymbol: '', targetSymbol: '' }] })}><Plus size={13} />添加映射</button></div>
              <p className="text-[11px] leading-5 text-[var(--tv-muted)]">使用两边的完整原生合约名称。同桥无映射时使用原合约；跨桥只跟随已映射品种。</p>
              {follower.mappings.map((mapping, mappingIndex) => <div key={mappingIndex} className="flex min-w-0 items-end gap-2">
                <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-2">
                  <label className="min-w-0 space-y-1 text-[11px] text-[var(--tv-muted)]"><span>主合约</span><input className={field} aria-label={`跟随 ${index + 1} 映射 ${mappingIndex + 1} 主合约`} value={mapping.sourceSymbol} onChange={event => updateFollower(index, { mappings: follower.mappings.map((row, i) => i === mappingIndex ? { ...row, sourceSymbol: event.target.value } : row) })} /></label>
                  <label className="min-w-0 space-y-1 text-[11px] text-[var(--tv-muted)]"><span>跟随合约</span><input className={field} aria-label={`跟随 ${index + 1} 映射 ${mappingIndex + 1} 跟随合约`} value={mapping.targetSymbol} onChange={event => updateFollower(index, { mappings: follower.mappings.map((row, i) => i === mappingIndex ? { ...row, targetSymbol: event.target.value } : row) })} /></label>
                </div>
                <button className={`${button} shrink-0 px-2`} aria-label={`移除跟随 ${index + 1} 映射 ${mappingIndex + 1}`} onClick={() => updateFollower(index, { mappings: follower.mappings.filter((_, i) => i !== mappingIndex) })}><X size={13} /></button>
              </div>)}
            </div>)}
            <button className={`${button} w-full border-[#2962ff] bg-[#2962ff] text-white hover:bg-[#2962ff]/80`} onClick={save}>{busy === 'save' ? '正在保存…' : '保存规则（保持停用）'}</button>
          </fieldset>
        </section>}
      </div>

      <section aria-label="复制交易日志" className={`${panel} min-w-0 p-3 sm:p-5`}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-sm font-semibold">运行日志</h2><select className={`${field} max-w-64`} aria-label="日志规则筛选" value={logRule} onChange={event => setLogRule(event.target.value)}><option value="">全部规则</option>{rules.map(rule => <option key={rule.config.id} value={rule.config.id}>{rule.config.name}</option>)}</select></div>
        <div className="max-h-96 space-y-2 overflow-y-auto">
          {!logs.length && <p className="py-4 text-xs text-[var(--tv-muted)]">暂无运行日志。</p>}
          {logs.map(log => <article key={log.id} className="rounded-lg border border-[var(--tv-border)] p-3 text-xs" data-copy-log={log.id}>
            <div className="mb-1 flex flex-wrap justify-between gap-2 text-[11px] text-[var(--tv-muted)]"><span>{rules.find(rule => rule.config.id === log.ruleId)?.config.name || log.ruleId || '复制服务'}</span><time>{timeText(log.time)}</time></div>
            <p className={`break-words leading-5 ${log.level === 'error' ? 'text-[#ef5350]' : ''}`}>{log.message}</p>
            {log.followerAccount && <p className="mt-1 break-all text-[11px] text-[var(--tv-muted)]">跟随账户：{typeof log.followerAccount === 'string' ? log.followerAccount : label(log.followerAccount)}</p>}
            {(log.sourceSymbol || log.targetSymbol || log.quantity != null) && <p className="mt-1 break-all font-mono text-[11px] text-[var(--tv-muted)]">{log.sourceSymbol || '—'} → {log.targetSymbol || '—'}{log.quantity != null ? ` · ${log.quantity} 手` : ''}</p>}
            {(log.sourceExecutionId || log.targetOrderId) && <p className="mt-1 break-all text-[11px] text-[var(--tv-muted)]">{log.sourceExecutionId ? `源成交 ${log.sourceExecutionId}` : ''}{log.targetOrderId ? ` · 跟随订单 ${log.targetOrderId}` : ''}</p>}
          </article>)}
        </div>
      </section>
    </div>
  </div>;
}

function AccountSelect({ label, value, accounts, onChange }: { label: string; value: CopyAccount; accounts: CopyAccountInfo[]; onChange: (value: CopyAccount) => void }) {
  const groups = new Map<string, CopyAccountInfo[]>();
  for (const account of accounts) {
    const group = `${bridgeProviderName(account.provider)} · ${account.group || '本地账户'}`;
    groups.set(group, [...(groups.get(group) || []), account]);
  }
  const selected = value.name ? copyAccountKey(value) : '';
  const missing = value.name && !accounts.some(account => copyAccountKey(account) === selected);
  return <label className="block min-w-0 space-y-1 text-xs text-[var(--tv-muted)]"><span>{label}</span><select aria-label={label} className={field} value={selected} onChange={event => {
    const account = accounts.find(row => copyAccountKey(row) === event.target.value);
    onChange(account ? { provider: account.provider, name: account.name } : blankAccount());
  }}><option value="">请选择账户</option>{missing && <option value={selected}>{bridgeProviderName(value.provider)} · {value.name}（当前未连接）</option>}
    {[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([group, rows]) => <optgroup key={group} label={group}>{rows.map(account => <option key={copyAccountKey(account)} value={copyAccountKey(account)}>{bridgeProviderName(account.provider)} · {account.displayName || account.name}</option>)}</optgroup>)}
  </select></label>;
}
