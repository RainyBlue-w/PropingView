import type { BridgeProvider } from './config';

export function bridgeAccountId(provider: BridgeProvider, name: string): string {
  return `bridge:${provider}:${encodeURIComponent(name)}`;
}

/** Legacy account identifiers belong to NT8; simulation remains outside bridge routing. */
export function parseBridgeAccount(id: string): { provider: BridgeProvider; name: string } {
  const match = /^bridge:(nt8|atas):(.*)$/.exec(id);
  if (!match) return { provider: 'nt8', name: id };
  return { provider: match[1] as BridgeProvider, name: decodeURIComponent(match[2]) };
}

export function displayBridgeAccount(id?: string): string {
  return id ? parseBridgeAccount(id).name : '未知账户';
}

export function migrateLegacyAccount(id: string): string {
  return !id || id === 'SIM-REPLAY' || /^bridge:(nt8|atas):/.test(id) ? id : bridgeAccountId('nt8', id);
}
