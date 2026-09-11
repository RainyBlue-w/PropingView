import type { BridgeProvider } from '@/lib/config';
import type { Nt8Status } from '@/lib/nt8Bridge';

export type BridgeStatuses = Partial<Record<BridgeProvider, Nt8Status | null>>;

export default function BridgeConnectionStatus({ statuses, compact = false }: { statuses: BridgeStatuses; compact?: boolean }) {
  return <div aria-label="数据桥连接状态" className={compact ? 'flex min-w-0 flex-col text-[9px] leading-3' : 'flex items-center gap-1.5 text-[10px]'}>
    {(['nt8', 'atas'] as const).map(provider => {
      const status = statuses[provider];
      const label = `${provider === 'nt8' ? 'NT8' : 'ATAS'} ${status?.connected ? '已连接' : status === undefined ? '连接中' : '未连接'}`;
      const protectionError = status?.tradingError || status?.syncError;
      const marketError = status?.marketError;
      const serviceError = status?.error;
      return <span key={provider} data-bridge-status={provider} role="status" aria-label={label}
        title={`${label}${status?.connectionName ? ` · ${status.connectionName}` : ''}${protectionError ? ` · 交易保护异常：${protectionError}` : ''}${marketError ? ` · 行情异常：${marketError}` : ''}${serviceError ? ` · ${serviceError}` : ''}`}
        className={`${compact ? 'truncate' : 'rounded border border-[var(--tv-border)] px-1.5 py-0.5'} ${protectionError || marketError || serviceError ? 'text-red-400' : status?.connected ? 'text-[#26a69a]' : 'text-amber-500'}`}>{label}{protectionError ? ' · 保护异常' : marketError ? ' · 行情异常' : serviceError ? ' · 服务异常' : ''}</span>;
    })}
  </div>;
}
