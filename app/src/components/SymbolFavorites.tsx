import { useEffect, useRef, useState } from 'react';
import { Search, Star, X } from 'lucide-react';
import type { SymbolInfo } from '@/types/market';

/**
 * 合约搜索/收藏栏(替代 TV 内置搜索——免费图表库的搜索无收藏功能,已在
 * widget 里禁用 header_symbol_search / symbol_search_hot_key):
 * - 常驻搜索框:聚焦或输入即出结果,星标收藏的合约固定在结果最上方
 * - 收藏的合约以 chip 平铺在栏上,点击即切换;悬停出现 × 可移除
 * - 星标按钮收藏/取消当前合约;收藏列表持久化在 localStorage
 */

const FAV_KEY = 'nt8-terminal-fav-symbols';

function loadFavs(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

interface Props {
  /** 拉取候选合约列表(NT8 合约库) */
  listSymbols: () => Promise<SymbolInfo[]>;
  /** 当前图表合约 */
  current: string;
  /** 选中合约时切换图表 */
  onSelect: (symbol: string) => void;
}

export default function SymbolFavorites({ listSymbols, current, onSelect }: Props) {
  const [favs, setFavs] = useState<string[]>(loadFavs);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [symbols, setSymbols] = useState<SymbolInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // 点击外部收起下拉
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // 首次打开下拉时加载候选列表
  useEffect(() => {
    if (!open || symbols.length > 0) return;
    setLoading(true);
    void listSymbols()
      .then(setSymbols)
      .catch(() => setSymbols([]))
      .finally(() => setLoading(false));
  }, [open, symbols.length, listSymbols]);

  const persist = (next: string[]) => {
    setFavs(next);
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify(next));
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

  const q = query.trim().toLowerCase();
  const filtered = symbols.filter(
    (s) =>
      !q || s.symbol.toLowerCase().includes(q) || (s.name ?? '').toLowerCase().includes(q),
  );
  // 收藏的固定在结果最上方,其余按名称
  const rows = [
    ...filtered.filter((s) => favs.includes(s.symbol)),
    ...filtered.filter((s) => !favs.includes(s.symbol)),
  ].slice(0, 60);

  const isFavCurrent = !!current && favs.includes(current);

  return (
    <div
      ref={boxRef}
      className="relative flex max-w-[75vw] items-center gap-1 rounded-md border border-[var(--tv-border)] bg-[var(--tv-panel)]/95 px-1.5 py-1 shadow-lg backdrop-blur"
    >
      {/* 搜索框(聚焦/输入展开结果,收藏置顶) */}
      <div className="relative shrink-0">
        <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[var(--tv-muted)]" />
        <input
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && rows.length > 0) pick(rows[0].symbol);
            if (e.key === 'Escape') setOpen(false);
          }}
          placeholder="搜索合约…"
          className="h-6 w-36 rounded border border-[var(--tv-border)] bg-[var(--tv-bg)] pl-5 pr-1.5 font-mono text-[11px] text-[var(--tv-text)] outline-none focus:border-[#2962ff]"
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
      {favs.map((s) => (
        <span
          key={s}
          className={`group flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
            s === current
              ? 'bg-[#2962ff] text-white'
              : 'cursor-pointer text-[var(--tv-text)] hover:bg-[#2962ff]/15'
          }`}
        >
          <button onClick={() => pick(s)} className="cursor-pointer">
            {s}
          </button>
          <button
            onClick={() => toggleFav(s)}
            className="hidden rounded-sm p-px opacity-70 hover:opacity-100 group-hover:block"
            title={`取消收藏 ${s}`}
          >
            <X className="h-2.5 w-2.5" />
          </button>
        </span>
      ))}

      {/* 搜索结果下拉 */}
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-md border border-[var(--tv-border)] bg-[var(--tv-panel)] shadow-xl">
          <div className="max-h-80 overflow-y-auto py-1">
            {loading && (
              <div className="px-3 py-2 text-[11px] text-[var(--tv-muted)]">加载合约列表…</div>
            )}
            {!loading && rows.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-[var(--tv-muted)]">无匹配合约</div>
            )}
            {!loading &&
              rows.map((s, i) => {
                const fav = favs.includes(s.symbol);
                return (
                  <div
                    key={s.symbol}
                    className={`flex cursor-pointer items-center gap-1.5 px-2 py-1 text-xs transition-colors hover:bg-[#2962ff]/10 ${
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
                    <span className="shrink-0 font-mono">{s.symbol}</span>
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
