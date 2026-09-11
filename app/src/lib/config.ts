export type BridgeProvider = 'nt8' | 'atas';
const PROVIDER_KEY = 'terminal-bridge-provider';

export function getProvider(): BridgeProvider {
  try { return localStorage.getItem(PROVIDER_KEY) === 'atas' ? 'atas' : 'nt8'; } catch { return 'nt8'; }
}

/** Preferred chart feed only; live trades always route by the selected account's own provider. */
export function setProvider(provider: BridgeProvider): void {
  localStorage.setItem(PROVIDER_KEY, provider);
}

export function bridgeProviderName(provider: BridgeProvider = getProvider()): string {
  return provider === 'atas' ? 'ATAS X' : 'NT8';
}

/** Chart preferences are separate; the combined account and execution archives keep their original keys. */
export function bridgeStorageKey(legacyKey: string, provider: BridgeProvider = getProvider()): string {
  return provider === 'nt8' ? legacyKey : `atas:${legacyKey}`;
}

const localBridgeUrl = (provider: BridgeProvider) => `http://127.0.0.1:${provider === 'atas' ? '8091' : '8090'}`;

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

export function defaultBridgeUrl(provider: BridgeProvider = getProvider()): string {
  if (typeof window === 'undefined' || !window.location) return localBridgeUrl(provider);
  // 远程设备的 127.0.0.1 不是 NT8 主机；HTTPS 页面也不能直连 HTTP 数据桥。
  // /api 由前端服务器转发，行情、账户和下单共用同一入口。
  return window.location.protocol === 'https:' || !isLoopback(window.location.hostname)
    ? `${window.location.origin}${provider === 'atas' ? '/atas' : ''}`
    : localBridgeUrl(provider);
}

/** NT8 数据桥地址；远程默认同源代理，本机 HTTP 保留直连，可手动覆盖。 */
export function getBridgeUrl(provider: BridgeProvider = getProvider()): string {
  const fallback = defaultBridgeUrl(provider);
  try {
    const saved = localStorage.getItem(bridgeStorageKey('nt8-bridge-url', provider))?.trim().replace(/\/+$/, '');
    if (!saved) return fallback;
    if (fallback !== localBridgeUrl(provider)) {
      // 兼容旧版设置中已保存的默认回环地址，不让远程页面继续误连自身。
      try {
        const url = new URL(saved);
        if (url.protocol === 'http:' && isLoopback(url.hostname) && url.port === (provider === 'atas' ? '8091' : '8090') && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password) return fallback;
      } catch { /* 相对代理路径也允许作为手动设置。 */ }
    }
    return saved;
  } catch {
    return fallback;
  }
}

export function setBridgeUrl(url: string, provider: BridgeProvider = getProvider()): void {
  const cleaned = url.trim().replace(/\/+$/, '');
  if (cleaned) localStorage.setItem(bridgeStorageKey('nt8-bridge-url', provider), cleaned);
  else localStorage.removeItem(bridgeStorageKey('nt8-bridge-url', provider));
}

export const DEFAULT_BRIDGE_URL_DISPLAY = defaultBridgeUrl();
