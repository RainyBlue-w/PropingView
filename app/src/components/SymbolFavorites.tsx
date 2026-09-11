import { bridgeStorageKey, type BridgeProvider } from '@/lib/config';
import { filterSymbols } from '@/lib/symbolSearch';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, Star, X } from 'lucide-react';
import type { SymbolInfo } from '@/types/market';

/**
 * 合约搜索/收藏栏(替代 TV 内置搜索——免费图表库的搜索无收藏功能,已在
 * widget 里禁用 header_symbol_search / symbol_search_hot_key):
 * - 常驻搜索框:聚焦或输入即出结果,星标收藏的合约固定在结果最上方
 * - 收藏的合约以 chip 平铺在栏上,点击即切换;悬停出现 × 可移除
 * - 星标按钮收藏/取消当前合约;收藏列表持久化在 localStorage
 */

function loadFavs(storageKey: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

interface Props {
  provider?: BridgeProvider;
  dragHandle?: ReactNode;
  /** 拉取当前行情源的候选合约列表 */
  listSymbols: () => Promise<SymbolInfo[]>;
  /** 按完整名称查询未出现在候选列表中的合约 */
  resolveSymbol?: (symbol: string) => Promise<SymbolInfo | null>;
  /** 当前图表合约 */
  current: string;
  /** 选中合约时切换图表 */
  onSelect: (symbol: string) => void;
}

export default function SymbolFavorites({ listSymbols, resolveSymbol, current, onSelect, dragHandle, provider = 'nt8' }: Props) {
  const storageKey = bridgeStorageKey('nt8-terminal-fav-symbols', provider);
  const [favs, setFavs] = useState<string[]>(() => loadFavs(storageKey));
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<{ query: string; symbol: SymbolInfo | null } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // 点击外部收起下拉;图表在 iframe 里,点进 iframe 时外层 document 收不到
  // mousedown(事件被 iframe 吃掉),用 window blur 兜底(焦点进 iframe 会触发)
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onBlur = () => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]);

  // 每次打开更新目录，避免新增月份或重连后一直使用旧候选。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listSymbols()
      .then(next => { if (!cancelled) setSymbols(next); })
      .catch(error => {
        if (!cancelled) {
          setSymbols([]);
          setResolved(null);
          setLoadError(error instanceof Error ? error.message : '合约列表加载失败，请检查桥接连接后重新打开搜索。');
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, listSymbols]);

  const showResults = () => {
    if (!open) {
      setLoading(true);
      setLoadError(null);
      setResolved(null);
    }
    setOpen(true);
  };

  const q = query.trim();
  const filtered = useMemo(() => filterSymbols(symbols, q), [symbols, q]);
  const needsResolve = open && !!q && filtered.length === 0 && !loading && !loadError && !!resolveSymbol;
  useEffect(() => {
    if (!needsResolve || !resolveSymbol) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void resolveSymbol(q)
        .then(symbol => { if (!cancelled) setResolved({ query: q, symbol }); })
        .catch(() => { if (!cancelled) setResolved({ query: q, symbol: null }); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [needsResolve, q, resolveSymbol]);
  const resolving = needsResolve && resolved?.query !== q;
  const matches = filtered.length === 0 && resolved?.query === q && resolved.symbol
    ? [resolved.symbol] : filtered;

  const persist = (next: string[]) => {
    setFavs(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const toggleFav = (sym: string) =>
    persist(favs.includes(sym) ? favs.filter((s) => s !== sym) : [...favs, sym]);

  const pick = (sym: string) => {
    onSelect(sym);
    setQuery('');
    setOpen(false);
  };

  // 收藏的固定在结果最上方(组内同样已按匹配分级排序),其余按名称
  const rows = [
    ...matches.filter((s) => favs.includes(s.symbol)),
    ...matches.filter((s) => !favs.includes(s.symbol)),
  ].slice(0, 60);

  const isFavCurrent = !!current && favs.includes(current);

  return (
    <div
      ref={boxRef}
      className="relative flex max-w-full flex-nowrap items-center gap-1 rounded-md border border-[var(--tv-border)] bg-[var(--tv-panel)]/95 px-1 py-0.5 shadow-lg backdrop-blur lg:flex-wrap lg:px-1.5 lg:py-1"
    >
      {dragHandle}
      {/* 搜索框(聚焦/输入展开结果,收藏置顶) */}
      <div className="relative shrink-0">
        <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--tv-muted)]" />
        <input
          value={query}
          onFocus={showResults}
          onChange={(e) => {
            setQuery(e.target.value);
            showResults();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !loading && !loadError && rows.length > 0) pick(rows[0].symbol);
            if (e.key === 'Escape') setOpen(false);
          }}
          placeholder="搜索合约…"
          aria-label="搜索合约"
          className="h-7 w-32 rounded border border-[var(--tv-border)] bg-[var(--tv-bg)] pl-5 pr-1.5 font-mono text-sm text-[var(--tv-text)] outline-none focus:border-[#2962ff] focus:text-base lg:h-6 lg:w-36 lg:text-[11px] lg:focus:text-[11px]"
        />
      </div>

      {/* 当前合约收藏开关 */}
      <button
        onClick={() => current && toggleFav(current)}
        disabled={!current}
        className="shrink-0 rounded p-1 text-[var(--tv-muted)] transition-colors hover:text-[#f0b90b] disabled:opacity-40"
        title={isFavCurrent ? `取消收藏 ${current}` : `收藏当前合约 ${current}`}
      >
        <Star className={`h-3.5 w-3.5 ${isFavCurrent ? 'fill-[#f0b90b] text-[#f0b90b]' : ''}`} />
      </button>

      {/* 收藏 chip 列表 */}
      {favs.length > 0 && <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain lg:contents">
      {favs.map((s) => (
        <span
          key={s}
          className={`group flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
            s === current
              ? 'bg-[#2962ff] text-white'
              : 'cursor-pointer text-[var(--tv-text)] hover:bg-[#2962ff]/15'
          }`}
        >
          <button onClick={() => pick(s)} className="min-h-6 cursor-pointer lg:min-h-0">
            {s}
          </button>
          <button
            onClick={() => toggleFav(s)}
            className="rounded-sm p-1 opacity-70 hover:opacity-100 lg:hidden lg:p-px lg:group-hover:block"
            title={`取消收藏 ${s}`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}
      </div>}

      {/* 搜索结果下拉 */}
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 max-w-[calc(100vw-24px)] rounded-md border border-[var(--tv-border)] bg-[var(--tv-panel)] shadow-xl">
          <div className="max-h-[min(20rem,50dvh)] overflow-y-auto overscroll-contain py-1">
            {loading && (
              <div className="px-3 py-2 text-[11px] text-[var(--tv-muted)]">加载合约列表…</div>
            )}
            {!loading && loadError && (
              <div className="px-3 py-2 text-[11px] text-amber-500">{loadError}</div>
            )}
            {resolving && (
              <div className="px-3 py-2 text-[11px] text-[var(--tv-muted)]">正在查询合约…</div>
            )}
            {!loading && !resolving && !loadError && rows.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-[var(--tv-muted)]">无匹配合约</div>
            )}
            {!loading && !loadError &&
              rows.map((s, i) => {
                const fav = favs.includes(s.symbol);
                return (
                  <div
                    key={s.symbol}
                    data-symbol-result={s.symbol}
                    className={`flex min-h-8 cursor-pointer items-center gap-1.5 px-2 py-1 text-xs transition-colors hover:bg-[#2962ff]/10 lg:min-h-0 ${
                      s.symbol === current ? 'bg-[#2962ff]/10' : ''
                    }`}
                    onClick={() => pick(s.symbol)}
                  >
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFav(s.symbol);
                      }}
                      className="shrink-0 rounded p-0.5 text-[var(--tv-muted)] hover:text-[#f0b90b]"
                      title={fav ? '取消收藏' : '收藏'}
                    >
                      <Star className={`h-3 w-3 ${fav ? 'fill-[#f0b90b] text-[#f0b90b]' : ''}`} />
                    </button>
                    <span className="shrink-0 font-mono text-[var(--tv-text)]">{s.symbol}</span>
                    <span className="truncate text-[11px] text-[var(--tv-muted)]">{s.name}</span>
                    {i === 0 && (
                      <span className="ml-auto shrink-0 text-[10px] text-[var(--tv-muted)]">
                        ↵
                      </span>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
}
