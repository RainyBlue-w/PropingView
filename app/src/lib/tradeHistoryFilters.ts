import type { Nt8Account, Nt8Execution } from './nt8Trading';
import { compareExecutions, executionTime } from './tradeAnalytics';
import { bridgeProviderName } from './config';
import { migrateLegacyAccount, parseBridgeAccount } from './bridgeAccounts';

const ACCOUNT_GROUPS_KEY = 'nt8-terminal-history-account-groups-v1';
export const UNKNOWN_ACCOUNT_GROUP = '未分组';
export type TradeAccountGroups = ReadonlyMap<string, string>;

let accountGroups: TradeAccountGroups | undefined;
const listeners = new Set<() => void>();

/** Keep previously seen account connections available when NT8 is offline or removes an account. */
export function getTradeAccountGroups(): TradeAccountGroups {
  if (!accountGroups) {
    const saved = new Map<string, string>();
    try {
      const entries: unknown = JSON.parse(localStorage.getItem(ACCOUNT_GROUPS_KEY) || '[]');
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && entry[0] && typeof entry[1] === 'string' && entry[1]) saved.set(migrateLegacyAccount(entry[0]), /^bridge:/.test(entry[0]) ? entry[1] : `NT8 · ${entry[1]}`);
        }
      }
    } catch { /* Missing or unavailable metadata does not hide archived executions. */ }
    accountGroups = saved;
  }
  return accountGroups;
}

export function subscribeTradeAccountGroups(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function rememberTradeAccounts(accounts: Nt8Account[]): void {
  const current = getTradeAccountGroups();
  const next = new Map(current);
  let changed = false;
  for (const account of accounts) {
    if (!account.name) continue;
    const group = account.connection || '本地账户';
    if (next.get(account.name) !== group) { next.set(account.name, group); changed = true; }
  }
  if (!changed) return;
  accountGroups = next;
  try { localStorage.setItem(ACCOUNT_GROUPS_KEY, JSON.stringify([...next])); } catch { /* Filters still work in memory if storage is unavailable. */ }
  for (const listener of listeners) listener();
}

const accountName = (row: Nt8Execution) => row.account || '未知账户';
const symbolName = (row: Nt8Execution) => row.instrument || '未知合约';
const groupName = (account: string, groups: TradeAccountGroups) => groups.get(account) || (/^bridge:/.test(account) ? `${bridgeProviderName(parseBridgeAccount(account).provider)} · ${UNKNOWN_ACCOUNT_GROUP}` : UNKNOWN_ACCOUNT_GROUP);

export function tradeHistoryFilterOptions(rows: Nt8Execution[], groups: TradeAccountGroups, selectedGroup = '') {
  const allAccounts = [...new Set(rows.map(accountName))].sort((a, b) => a.localeCompare(b));
  return {
    groups: [...new Set(allAccounts.map(account => groupName(account, groups)))].sort((a, b) => a.localeCompare(b)),
    accounts: allAccounts.filter(account => !selectedGroup || groupName(account, groups) === selectedGroup),
    symbols: [...new Set(rows.map(symbolName))].sort((a, b) => a.localeCompare(b)),
  };
}

export interface TradeHistoryFilters { group: string; account: string; symbol: string; startDate: string; endDate: string }

function localDate(value: string): Date | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!parts) return null;
  const [year, month, day] = parts.slice(1).map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

/** Calendar boundaries use local time, including 23/25-hour daylight-saving days. */
export function tradeHistoryDateRange(startDate: string, endDate: string) {
  const start = startDate ? localDate(startDate) : null;
  const end = endDate ? localDate(endDate) : null;
  if ((startDate && !start) || (endDate && !end)) return { error: '请输入有效的开始日期和结束日期。' };
  if (start && end && start > end) return { error: '开始日期不能晚于结束日期。' };
  if (end) end.setDate(end.getDate() + 1);
  return { from: start?.getTime(), until: end?.getTime(), error: '' };
}

export function filterTradeHistory(rows: Nt8Execution[], filters: TradeHistoryFilters, groups: TradeAccountGroups) {
  const range = tradeHistoryDateRange(filters.startDate, filters.endDate);
  if (range.error) return { rows: [] as Nt8Execution[], dateError: range.error };
  const filtered = rows.filter(row => {
    const account = accountName(row);
    if (filters.group && groupName(account, groups) !== filters.group) return false;
    if (filters.account && account !== filters.account) return false;
    if (filters.symbol && symbolName(row) !== filters.symbol) return false;
    if (range.from != null || range.until != null) {
      const time = executionTime(row) * 1000;
      if (!Number.isFinite(time) || (range.from != null && time < range.from) || (range.until != null && time >= range.until)) return false;
    }
    return true;
  });
  return { rows: filtered.sort((a, b) => compareExecutions(b, a)), dateError: '' };
}
