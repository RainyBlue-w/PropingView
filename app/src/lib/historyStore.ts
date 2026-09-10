import { useSyncExternalStore } from 'react';
import { nt8Trading, type Nt8Execution, type ExecutionPage } from './nt8Trading';
import { checkNt8Status } from './nt8Bridge';
import { compareExecutions, executionKey, normalizeCurrency } from './tradeAnalytics';

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
let lastFullSync = 0;

function publish(patch: Partial<ArchiveState>) {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach(fn => fn());
}

function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('nt8-terminal-trade-archive', 1);
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
      const data = await new Promise<{ rows: { key: string; row: Nt8Execution }[]; lastSynced?: number }>((resolve, reject) => {
        const tx = db.transaction(['executions', 'meta'], 'readonly');
        const rows = tx.objectStore('executions').getAll();
        const time = tx.objectStore('meta').get('lastSynced');
        tx.oncomplete = () => resolve({ rows: rows.result, lastSynced: time.result });
        tx.onerror = () => reject(tx.error);
      });
      data.rows.forEach(item => records.set(item.key, item.row));
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

function inspectArchive(page: ExecutionPage) {
  const archive = page.archive;
  if (archive) publish({ archiveError: archive.error || archive.warning || (archive.state === 'loading' ? 'NT8 正在加载磁盘归档，下次同步将补齐记录。' : null) });
}

async function synchronize(forceFull: boolean) {
  await initialize();
  publish({ syncing: true, error: null });
  try {
    const status = await checkNt8Status();
    if (!status) throw new Error('数据桥离线，当前显示已保存在本机的成交记录。');
    const archiveCapable = !!status.executionArchiveVersion;
    publish({ legacy: !archiveCapable });
    const end = Math.floor(Date.now() / 1000);
    // Full reconciliation also picks up imported old executions and late fee corrections.
    const full = forceFull || Date.now() - lastFullSync > 10 * 60_000;
    const from = !archiveCapable || full || !snapshot.lastSynced ? 0 : Math.max(0, snapshot.lastSynced - 2 * 86400);
    const accountNames = archiveCapable ? [''] : (await nt8Trading.getAccounts()).accounts.map(a => a.name);
    let archiveReady = true;
    for (const account of accountNames) {
      let offset = 0;
      for (;;) {
        const page = await nt8Trading.getExecutionPage(account, '', from, end, offset, 500);
        inspectArchive(page);
        if (page.archive && page.archive.state !== 'ready') archiveReady = false;
        await saveRows(page.executions.map(row => ({ ...row, account: row.account || account || '未知账户' })));
        if (page.nextOffset == null) break;
        if (!Number.isFinite(page.nextOffset) || page.nextOffset <= offset) throw new Error('数据桥分页游标未推进，已保存成功读取的记录，将在下次同步重试。');
        offset = page.nextOffset;
      }
    }
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(end, 'lastSynced');
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    // If NT8 was still loading its journal, retry the whole archive on the next poll.
    if (full && archiveReady) lastFullSync = Date.now();
    publish({ lastSynced: end });
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
