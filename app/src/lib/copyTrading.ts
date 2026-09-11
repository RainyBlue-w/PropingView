import type { BridgeProvider } from './config';

export interface CopyAccount { provider: BridgeProvider; name: string }
export interface CopyAccountInfo extends CopyAccount { displayName: string; group: string }
export interface CopyFollower {
  account: CopyAccount;
  multiplier: number;
  maxOrderQuantity: number;
  mappings: { sourceSymbol: string; targetSymbol: string }[];
}
export interface CopyRuleConfig { id: string; name: string; leader: CopyAccount; followers: CopyFollower[] }
export interface CopyRule {
  config: CopyRuleConfig;
  status: 'stopped' | 'running' | 'error';
  error?: string;
  startedAt?: number;
  lastPollAt?: number;
  copiedOrders: number;
}
export interface CopyLog {
  id: string;
  time: number;
  ruleId: string;
  level: 'info' | 'error';
  message: string;
  sourceExecutionId?: string;
  followerAccount?: string | CopyAccount;
  sourceSymbol?: string;
  targetSymbol?: string;
  quantity?: number;
  targetOrderId?: string;
}
export interface CopySnapshot { version: number; rules: CopyRule[]; logs: CopyLog[] }

export function copyAccountKey(account: CopyAccount): string { return JSON.stringify([account.provider, account.name]); }

export function validateCopyRule(config: CopyRuleConfig): string | null {
  if (!config.name.trim()) return '请填写规则名称。';
  if (!config.leader.name) return '请选择主账户。';
  if (!config.followers.length) return '请至少添加一个跟随账户。';
  const selected = new Set([copyAccountKey(config.leader)]);
  for (const [index, follower] of config.followers.entries()) {
    const label = `跟随账户 ${index + 1}`;
    if (!follower.account.name) return `${label}尚未选择。`;
    const key = copyAccountKey(follower.account);
    if (selected.has(key)) return `${label}与主账户或其他跟随账户重复。`;
    selected.add(key);
    if (!Number.isFinite(follower.multiplier) || follower.multiplier <= 0) return `${label}的倍率必须大于 0。`;
    if (!Number.isSafeInteger(follower.maxOrderQuantity) || follower.maxOrderQuantity <= 0) return `${label}的最大单笔手数必须是正整数。`;
    if (follower.account.provider !== config.leader.provider && !follower.mappings.length) return `${label}跨桥跟随，需要填写合约映射。`;
    const sources = new Set<string>();
    for (const mapping of follower.mappings) {
      if (!mapping.sourceSymbol.trim() || !mapping.targetSymbol.trim()) return `${label}的每条映射都需要填写主合约和跟随合约。`;
      if (sources.has(mapping.sourceSymbol.trim())) return `${label}的主合约映射重复。`;
      sources.add(mapping.sourceSymbol.trim());
    }
  }
  return null;
}

async function request<T>(path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    // This service owns the copier; never route these requests through replay or a selected chart account.
    const response = await fetch(`/copy/api${path}`, {
      method: body === undefined ? 'GET' : 'POST', signal: controller.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    let data: T & { error?: string };
    try { data = await response.json(); }
    catch { throw new Error(`复制服务返回无效响应（HTTP ${response.status}）。`); }
    if (!response.ok) throw new Error(data.error || `复制服务请求失败（HTTP ${response.status}）。`);
    return data;
  } finally { clearTimeout(timer); }
}

export const copyTrading = {
  getStatus: () => request<CopySnapshot>('/status'),
  getAccounts: () => request<{ accounts: CopyAccountInfo[] }>('/accounts'),
  saveRule: (config: CopyRuleConfig) => request<CopySnapshot>('/rules', config),
  startRule: (id: string) => request<CopySnapshot>(`/rules/${encodeURIComponent(id)}/start`, {}),
  stopRule: (id: string) => request<CopySnapshot>(`/rules/${encodeURIComponent(id)}/stop`, {}),
  deleteRule: (id: string) => request<CopySnapshot>(`/rules/${encodeURIComponent(id)}/delete`, {}),
  stopAll: () => request<CopySnapshot>('/stop-all', {}),
};
