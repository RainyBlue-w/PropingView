import { useSyncExternalStore } from 'react';
import { BRIDGE_PROVIDERS, bridgeTrading, namespaceExecution, type Nt8Execution } from './nt8Trading';
import { checkNt8Status } from './nt8Bridge';
import { compareExecutions, executionKey, normalizeCurrency } from './tradeAnalytics';
import { bridgeProviderName, type BridgeProvider } from './config';
import { migrateLegacyAccount } from './bridgeAccounts';

const DATABASE_NAME = 'nt8-terminal-trade-archive';

interface ArchiveState {
  rows: Nt8Execution[];
  loading: boolean;
  syncing: boolean;
  error: string | null;
  lastSynced: number | null;
  legacy: boolean;
  archiveError: string | null;
}

let snapshot: ArchiveState = { rows: [], loading: true, syncing: false, error: null, lastSynced: null, legacy: false, archiveError: null };
const listeners = new Set<() => void>();
const records = new Map<string, Nt8Execution>();
let database: Promise<IDBDatabase> | null = null;
let initialization: Promise<void> | null = null;
let pendingSync: Promise<void> | null = null;
let consumers = 0;
let interval: ReturnType<typeof setInterval> | undefined;
const lastFullSync: Record<BridgeProvider, number> = { nt8: 0, atas: 0 };
let providerSynced: Partial<Record<BridgeProvider, number>> = {};

function publish(patch: Partial<ArchiveState>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach(fn => fn());
}

function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('executions')) request.result.createObjectStore('executions', { keyPath: 'key' });
      if (!request.result.objectStoreNames.contains('meta')) request.result.createObjectStore('meta');
    };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = null; }; resolve(request.result); };
    request.onerror = () => reject(request.error || new Error('无法打开成交归档'));
    request.onblocked = () => reject(new Error('本地成交库正在升级，请关闭旧页面后重试'));
  }).catch(error => { database = null; throw error; });
  return database;
}

async function initialize() {
  if (!initialization) initialization = (async () => {
    try {
      const db = await openDatabase();
      const data = await new Promise<{ rows: { key: string; row: Nt8Execution }[]; lastSynced?: number; bridgeSync?: Partial<Record<BridgeProvider, number>> }>((resolve, reject) => {
        const tx = db.transaction(['executions', 'meta'], 'readonly');
        const rows = tx.objectStore('executions').getAll();
        const time = tx.objectStore('meta').get('lastSynced');
        const bridgeSync = tx.objectStore('meta').get('bridgeSync');
        tx.oncomplete = () => resolve({ rows: rows.result, lastSynced: time.result, bridgeSync: bridgeSync.result });
        tx.onerror = () => reject(tx.error);
      });
      data.rows.forEach(item => {
        const row = { ...item.row, account: migrateLegacyAccount(item.row.account || '未知账户') };
        records.set(executionKey(row), row);
      });
      providerSynced = data.bridgeSync || { nt8: data.lastSynced };
      publish({ rows: [...records.values()].sort((a, b) => compareExecutions(b, a)), lastSynced: data.lastSynced || null, loading: false });
    } catch (error) {
      initialization = null;
      publish({ loading: false, error: `本地归档读取失败：${error instanceof Error ? error.message : String(error)}` });
    }
  })();
  return initialization;
}

async function saveRows(rows: Nt8Execution[]) {
  const updates = rows.filter(row => Number.isFinite(row.time) && Number.isFinite(row.qty) && row.qty > 0 && Number.isFinite(row.price)).map(row => {
    const key = executionKey(row);
    const old = records.get(key);
    // A temporary omission from the bridge must not erase richer archived metadata.
    const merged = { ...old, ...Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined && value !== null)), currency: normalizeCurrency(row.currency || old?.currency) } as Nt8Execution;
    return { key, row: merged };
  }).filter(item => JSON.stringify(records.get(item.key)) !== JSON.stringify(item.row));
  if (!updates.length) return;
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('executions', 'readwrite');
    updates.forEach(item => tx.objectStore('executions').put(item));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('本地磁盘写入失败'));
    tx.onabort = () => reject(tx.error || new Error('本地成交归档写入中断'));
  });
  updates.forEach(item => records.set(item.key, item.row));
  publish({ rows: [...records.values()].sort((a, b) => compareExecutions(b, a)) });
}

async function synchronizeProvider(provider: BridgeProvider, forceFull: boolean) {
  const status = await checkNt8Status(provider);
  if (!status) return { available: false, legacy: false, warning: null };
  const api = bridgeTrading(provider);
  const archiveCapable = !!status.executionArchiveVersion;
  const accounts = await api.getAccounts().catch(error => { if (!archiveCapable) throw error; return { accounts: [] }; });
  const accountLabels = new Map(accounts.accounts.map(account => [account.name, account.displayName || account.name]));
  const end = Math.floor(Date.now() / 1000);
  const full = forceFull || Date.now() - lastFullSync[provider] > 10 * 60_000;
  const from = !archiveCapable || full || !providerSynced[provider] ? 0 : Math.max(0, providerSynced[provider]! - 2 * 86400);
  const accountNames = archiveCapable ? [''] : accounts.accounts.map(account => account.name);
  let archiveReady = true;
  let warning: string | null = null;
  for (const account of accountNames) {
    let offset = 0;
    for (;;) {
      const page = await api.getExecutionPage(account, '', from, end, offset, 500);
      if (page.archive) {
        if (page.archive.state !== 'ready') archiveReady = false;
        warning = page.archive.error || page.archive.warning || (page.archive.state === 'loading' ? '正在加载磁盘归档，下次同步将补齐记录。' : warning);
      }
      await saveRows(page.executions.map(row => namespaceExecution(provider,
        { ...row, accountDisplayName: row.accountDisplayName || accountLabels.get(row.account || account) }, account)));
      if (page.nextOffset == null) break;
      if (!Number.isFinite(page.nextOffset) || page.nextOffset <= offset) throw new Error('数据桥分页游标未推进，已保存成功读取的记录，将在下次同步重试。');
      offset = page.nextOffset;
    }
  }
  if (archiveReady) providerSynced[provider] = end;
  if (full && archiveReady) lastFullSync[provider] = Date.now();
  return { available: true, legacy: !archiveCapable, warning: warning ? `${bridgeProviderName(provider)}：${warning}` : null };
}

async function synchronize(forceFull: boolean) {
  await initialize();
  publish({ syncing: true, error: null });
  try {
    const results = await Promise.allSettled(BRIDGE_PROVIDERS.map(provider => synchronizeProvider(provider, forceFull)));
    const errors = results.flatMap((result, index) => result.status === 'rejected' ? [`${bridgeProviderName(BRIDGE_PROVIDERS[index])}：${String(result.reason)}`] : []);
    const completed = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    const db = await openDatabase();
    const lastSynced = Math.max(0, ...Object.values(providerSynced).filter((value): value is number => typeof value === 'number')) || null;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(providerSynced, 'bridgeSync');
      tx.objectStore('meta').put(lastSynced, 'lastSynced');
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    publish({ lastSynced, legacy: completed.some(result => result.legacy), archiveError: completed.map(result => result.warning).filter(Boolean).join('；') || null,
      error: errors.join('；') || (completed.some(result => result.available) ? null : '数据桥离线，当前显示已保存在本机的成交记录。') });
  } catch (error) {
    publish({ error: error instanceof Error ? error.message : '成交记录同步失败，已保存的数据仍可查看。' });
  } finally { publish({ syncing: false }); }
}

export function syncHistoryNow(forceFull = true): Promise<void> {
  if (!pendingSync) pendingSync = synchronize(forceFull).finally(() => { pendingSync = null; });
  return pendingSync;
}

/** Mount once at terminal level: archiving continues while any page or replay is open. */
export function startHistorySync(): () => void {
  consumers++;
  void syncHistoryNow(false);
  if (!interval) interval = setInterval(() => { void syncHistoryNow(false); }, 10_000);
  return () => { consumers--; if (consumers <= 0 && interval) { clearInterval(interval); interval = undefined; } };
}

export function getHistoryArchive() { return snapshot; }
export function subscribeHistory(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useHistoryArchive() { return useSyncExternalStore(subscribeHistory, getHistoryArchive, getHistoryArchive); }
