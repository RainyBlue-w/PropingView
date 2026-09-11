import { bridgeProviderName } from './config';
import { checkNt8Status, createNt8Adapter } from './nt8Bridge';
import type { ReplaySession } from './replayStore';

/** A saved session owns its feed. Opening it must never borrow another live account's chart feed. */
export async function loadReplayFeed(record: Pick<ReplaySession, 'provider' | 'symbol'>) {
  const provider = record.provider ?? 'nt8';
  const status = await checkNt8Status(provider);
  if (!status?.connected) throw new Error(`请连接此回放会话的 ${bridgeProviderName(provider)} 数据桥后重试。`);
  const adapter = createNt8Adapter(status, provider);
  const info = await adapter.resolve?.(record.symbol);
  if (!info) throw new Error(`未找到此会话的合约，请检查 ${bridgeProviderName(provider)} 合约与行情连接。`);
  return { adapter, info };
}
