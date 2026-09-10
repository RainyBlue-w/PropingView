import type { ChartData, IExternalSaveLoadAdapter } from '../../public/charting_library/charting_library';

const LEGACY_KEY = 'nt8-terminal-tv-layout';
const LAYOUTS_KEY = 'nt8-terminal-tv-layouts-v2';

export interface LayoutRecord extends ChartData {
  id: string;
}

interface LayoutStore {
  version: 2;
  charts: LayoutRecord[];
  /** 打开时间与修改时间分开记录，加载旧布局不会改写其修改日期。 */
  lastOpenedId: string | null;
}

interface LayoutAdapterOptions {
  /** 额外图表拥有独立布局库；省略时保留主图的存储与旧版迁移。 */
  scope?: string;
  /** 内容已读取；宿主等 chart_loaded 后再调用 rememberLayout。 */
  onChartLoadRequested?: (id: string) => void;
}

function lsTrace(method: string, detail?: unknown): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { __layoutLog?: { m: string; t: string; d: unknown }[] };
  w.__layoutLog ??= [];
  w.__layoutLog.push({ m: method, t: new Date().toISOString(), d: detail ?? null });
  if (w.__layoutLog.length > 200) w.__layoutLog.shift();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseObject(content: string): Record<string, unknown> {
  const value: unknown = JSON.parse(content);
  if (!isObject(value)) throw new Error('图表布局内容无效');
  return value;
}

/** adapter 收到的是外层保存记录；低层 saved_data 使用其中的内部图表状态。 */
function parseContent(content: string) {
  const outer = parseObject(content);
  const state = typeof outer.content === 'string' ? parseObject(outer.content) : outer;
  if (!(Array.isArray(state.charts) && state.charts.length > 0)
    && !(Array.isArray(state.panes) && state.panes.length > 0)) {
    throw new Error('图表布局缺少图表状态');
  }
  return { outer, state };
}

function validRecord(value: unknown): value is LayoutRecord {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id.length
    || typeof value.name !== 'string' || !value.name.trim()
    || typeof value.symbol !== 'string' || typeof value.resolution !== 'string' || !value.resolution
    || typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp) || value.timestamp < 0
    || typeof value.content !== 'string') return false;
  parseContent(value.content);
  return true;
}

/** 单次原子写入；浏览器配额或权限错误直接上抛，原布局保持完整。 */
function storageKey(scope?: string): string {
  return scope === undefined ? LAYOUTS_KEY : `${LAYOUTS_KEY}:pane:${encodeURIComponent(scope)}`;
}

function writeStore(store: LayoutStore, scope?: string): void {
  localStorage.setItem(storageKey(scope), JSON.stringify(store));
}

function legacyRecord(content: string): LayoutRecord {
  const { outer, state } = parseContent(content);
  const firstChart: unknown = Array.isArray(state.charts) ? state.charts[0] : state;
  const panes = isObject(firstChart) && Array.isArray(firstChart.panes) ? firstChart.panes : [];
  const sources: unknown[] = panes.flatMap((pane: unknown) => isObject(pane) && Array.isArray(pane.sources) ? pane.sources : []);
  const series = sources.find((source) => isObject(source) && source.type === 'MainSeries');
  const seriesState = isObject(series) && isObject(series.state) ? series.state : {};
  const stringOr = (...values: unknown[]) => values.find((value) => typeof value === 'string' && value.length) as string | undefined;
  const id = (typeof outer.id === 'string' && outer.id.length)
    || (typeof outer.id === 'number' && Number.isFinite(outer.id)) ? String(outer.id) : 'default';
  const name = stringOr(outer.name, state.name)?.trim() || '默认布局';
  const symbol = stringOr(outer.symbol, outer.short_name, seriesState.symbol) ?? '';
  const resolution = (stringOr(outer.resolution, seriesState.interval) ?? '1') as ChartData['resolution'];
  return {
    id, name, symbol, resolution,
    // 旧实现没有保存修改时间，未知时保留 0，不冒充迁移时刻。
    timestamp: typeof outer.timestamp === 'number' && Number.isFinite(outer.timestamp) && outer.timestamp >= 0 ? outer.timestamp : 0,
    content: typeof outer.content === 'string' ? content : JSON.stringify({ name, symbol, resolution, content }),
  };
}

function readStore(scope?: string): LayoutStore {
  const raw = localStorage.getItem(storageKey(scope));
  if (raw !== null) {
    const value: unknown = JSON.parse(raw);
    if (!isObject(value) || value.version !== 2 || !Array.isArray(value.charts)
      || !value.charts.every(validRecord)
      || new Set(value.charts.map((chart) => chart.id)).size !== value.charts.length
      || !(value.lastOpenedId === null || (typeof value.lastOpenedId === 'string'
        && value.charts.some((chart) => chart.id === value.lastOpenedId)))) {
      throw new Error('本地图表布局库损坏，原数据已保留');
    }
    return value as unknown as LayoutStore;
  }

  // 新增的图表不能复制主图或迁移其旧布局，否则启动时会恢复成同一个标的。
  if (scope !== undefined) return { version: 2, charts: [], lastOpenedId: null };
  const legacy = localStorage.getItem(LEGACY_KEY);
  if (legacy === null) return { version: 2, charts: [], lastOpenedId: null };
  const chart = legacyRecord(legacy);
  if (!validRecord(chart)) throw new Error('旧图表布局数据不完整，原数据已保留');
  const store: LayoutStore = { version: 2, charts: [chart], lastOpenedId: chart.id };
  writeStore(store);
  // 旧 key 永久保留为迁移备份；空的新版库也优先于它，避免删除后复活。
  lsTrace('migrate', { id: chart.id });
  return store;
}

function findChart(store: LayoutStore, id: string | number): LayoutRecord {
  const chart = store.charts.find((entry) => entry.id === String(id));
  if (!chart) throw new Error(`图表布局不存在：${id}`);
  return chart;
}

function latestChart(store: LayoutStore): LayoutRecord | null {
  return [...store.charts].sort((a, b) => b.timestamp - a.timestamp)[0] ?? null;
}

export function hasSavedLayout(scope?: string): boolean {
  return readStore(scope).charts.length > 0;
}

export function getLastSavedLayout(scope?: string): LayoutRecord | null {
  const store = readStore(scope);
  return store.lastOpenedId === null ? latestChart(store) : findChart(store, store.lastOpenedId);
}

export function rememberLayout(id: string | number, scope?: string): void {
  const store = readStore(scope);
  const chart = findChart(store, id);
  if (store.lastOpenedId === chart.id) return;
  writeStore({ ...store, lastOpenedId: chart.id }, scope);
}

/** 与本地库 load_last_chart 的处理一致，恢复内容同时恢复布局身份与名称。 */
export function getLayoutSavedData(chart: LayoutRecord): object {
  const { outer, state } = parseContent(chart.content);
  return {
    ...state,
    extendedData: { ...outer, id: chart.id, uid: chart.id, name: chart.name },
  };
}

export function createLayoutAdapter(options: LayoutAdapterOptions = {}): IExternalSaveLoadAdapter {
  const { scope } = options;
  return {
    getAllCharts: async () => {
      const charts = readStore(scope).charts.map(({ id, name, symbol, resolution, timestamp }) => ({ id, name, symbol, resolution, timestamp }));
      lsTrace('getAllCharts', { count: charts.length, scope });
      return charts;
    },
    saveChart: async (chartData) => {
      const store = readStore(scope);
      let id: string;
      if (chartData.id !== undefined && chartData.id !== null) {
        id = findChart(store, chartData.id).id;
      } else {
        do {
          id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        } while (store.charts.some((chart) => chart.id === id));
      }
      const chart: LayoutRecord = { ...chartData, id };
      if (!validRecord(chart)) throw new Error('图表布局数据不完整，尚未保存');
      writeStore({ ...store, charts: [...store.charts.filter((entry) => entry.id !== id), chart], lastOpenedId: id }, scope);
      lsTrace('saveChart', { id, name: chart.name, len: chart.content.length, scope });
      return id;
    },
    removeChart: async (id) => {
      const store = readStore(scope);
      const chart = findChart(store, id);
      const next = { ...store, charts: store.charts.filter((entry) => entry.id !== chart.id) };
      if (next.lastOpenedId === chart.id) next.lastOpenedId = latestChart(next)?.id ?? null;
      writeStore(next, scope);
      lsTrace('removeChart', { id: chart.id, scope });
    },
    getChartContent: async (id) => {
      const chart = findChart(readStore(scope), id);
      options.onChartLoadRequested?.(chart.id);
      lsTrace('getChartContent', { id: chart.id, scope });
      return chart.content;
    },
    // 模板与独立绘图存储功能未启用；布局本身包含指标和用户绘图。
    getAllStudyTemplates: () => Promise.resolve([]),
    removeStudyTemplate: () => Promise.resolve(),
    saveStudyTemplate: () => Promise.resolve(),
    getStudyTemplateContent: () => Promise.resolve(''),
    getDrawingTemplates: () => Promise.resolve([]),
    loadDrawingTemplate: () => Promise.resolve(''),
    removeDrawingTemplate: () => Promise.resolve(),
    saveDrawingTemplate: () => Promise.resolve(),
    getChartTemplateContent: () => Promise.reject(new Error('no chart templates')),
    getAllChartTemplates: () => Promise.resolve([]),
    saveChartTemplate: () => Promise.resolve(),
    removeChartTemplate: () => Promise.resolve(),
    saveLineToolsAndGroups: () => Promise.resolve(),
    loadLineToolsAndGroups: () => Promise.resolve(null),
  };
}
