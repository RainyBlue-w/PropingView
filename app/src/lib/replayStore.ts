import { isSimTradingState, type SimTradingState } from './simTrading';
import type { BridgeProvider } from './config';

export const REPLAY_SESSION_PREFIX = 'nt8-terminal-replay-session-v1:';

export interface NewReplaySessionInput {
  provider?: BridgeProvider;
  name: string;
  symbol: string;
  /** Unix seconds. */
  startTime: number;
  initialEquity: number;
}

export interface ReplaySession extends NewReplaySessionInput {
  provider: BridgeProvider;
  version: 1;
  id: string;
  /** Wall-clock milliseconds, distinct from the replay cursor. */
  createdAt: number;
  updatedAt: number;
  cursor: number;
  interval: string;
  speed: number;
  stepSec: number;
  state: SimTradingState;
  lastPrices: Record<string, number>;
  pointValues: Record<string, number>;
}

function finiteMap(value: unknown, positive: boolean): value is Record<string, number> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, n]) => key.length > 0 && typeof n === 'number'
      && Number.isFinite(n) && (!positive || n > 0));
}

export function isReplaySession(value: unknown): value is ReplaySession {
  if (!value || typeof value !== 'object') return false;
  const session = value as ReplaySession;
  return session.version === 1 && typeof session.id === 'string' && session.id.length > 0
    && (session.provider === 'nt8' || session.provider === 'atas')
    && typeof session.name === 'string' && session.name.trim().length > 0
    && typeof session.symbol === 'string' && session.symbol.trim().length > 0
    && Number.isFinite(session.createdAt) && Number.isFinite(session.updatedAt)
    && Number.isFinite(session.startTime) && session.startTime > 0
    && Number.isFinite(session.cursor) && session.cursor >= session.startTime
    && typeof session.interval === 'string' && session.interval.length > 0
    && Number.isFinite(session.speed) && session.speed > 0
    && Number.isSafeInteger(session.stepSec) && session.stepSec > 0
    && isSimTradingState(session.state) && session.initialEquity === session.state.initialEquity
    && finiteMap(session.lastPrices, false) && finiteMap(session.pointValues, true);
}

export function createReplaySession(input: NewReplaySessionInput): ReplaySession {
  const provider = input.provider ?? 'nt8';
  if (provider !== 'nt8' && provider !== 'atas') throw new Error('回放行情来源无效');
  const name = input.name.trim();
  const symbol = input.symbol.trim();
  if (!name || !symbol) throw new Error('请填写会话名称和完整合约名');
  if (!Number.isFinite(input.startTime) || input.startTime <= 0 || input.startTime >= Date.now() / 1000) {
    throw new Error('回放开始时间必须是过去的有效时间');
  }
  if (!Number.isFinite(input.initialEquity) || input.initialEquity <= 0) throw new Error('初始资金必须大于零');
  const now = Date.now();
  return {
    version: 1,
    provider,
    id: globalThis.crypto?.randomUUID?.() ?? `${now}-${Math.random().toString(36).slice(2)}`,
    name, symbol,
    startTime: input.startTime,
    initialEquity: input.initialEquity,
    createdAt: now, updatedAt: now,
    cursor: input.startTime,
    interval: '1', speed: 1, stepSec: 60,
    state: {
      version: 1, initialEquity: input.initialEquity,
      positions: [], orders: [], executions: [], realized: 0, orderSeq: 0, ocoSeq: 0,
    },
    lastPrices: {}, pointValues: {},
  };
}

/** Each session is one atomic localStorage write; a quota failure preserves its previous snapshot. */
export function saveReplaySession(session: ReplaySession): void {
  const normalized = { ...session, provider: session.provider ?? 'nt8' };
  if (!isReplaySession(normalized)) throw new Error('回放快照不完整,尚未保存');
  try {
    localStorage.setItem(`${REPLAY_SESSION_PREFIX}${session.id}`, JSON.stringify(normalized));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`回放会话保存失败：${reason}。当前会话仍保留在内存中，请勿刷新或关闭页面。`);
  }
}

/** Remove only this session's snapshot; other sessions and browser data are untouched. */
export function deleteReplaySession(id: string): void {
  if (typeof id !== 'string' || !id.trim()) throw new Error('回放会话 ID 不能为空');
  try {
    localStorage.removeItem(`${REPLAY_SESSION_PREFIX}${id}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`回放会话删除失败：${reason}。请重试。`);
  }
}

/** A damaged session never prevents other sessions from opening and is left untouched on disk. */
export function loadReplaySessions(): { sessions: ReplaySession[]; errors: string[] } {
  const sessions: ReplaySession[] = [];
  const errors: string[] = [];
  try {
    const keys: string[] = [];
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(REPLAY_SESSION_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      try {
        const raw = localStorage.getItem(key);
        if (raw === null) continue;
        const stored: unknown = JSON.parse(raw);
        const parsed = stored && typeof stored === 'object' && !Array.isArray(stored)
          ? { ...stored, provider: ('provider' in stored ? stored.provider : undefined) ?? 'nt8' }
          : stored;
        if (!isReplaySession(parsed) || key !== `${REPLAY_SESSION_PREFIX}${parsed.id}`) {
          throw new Error('快照内容或版本无效');
        }
        sessions.push(parsed);
      } catch (error) {
        errors.push(`无法读取回放会话 ${key.slice(REPLAY_SESSION_PREFIX.length)}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    errors.push(`无法访问回放会话储存：${error instanceof Error ? error.message : String(error)}`);
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  return { sessions, errors };
}
