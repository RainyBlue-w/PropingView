const STORAGE_KEY = 'nt8-bridge-url';
const LOCAL_BRIDGE_URL = 'http://127.0.0.1:8090';

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

function defaultBridgeUrl(): string {
  if (typeof window === 'undefined') return LOCAL_BRIDGE_URL;
  // 远程设备的 127.0.0.1 不是 NT8 主机；HTTPS 页面也不能直连 HTTP 数据桥。
  // /api 由前端服务器转发，行情、账户和下单共用同一入口。
  return window.location.protocol === 'https:' || !isLoopback(window.location.hostname)
    ? window.location.origin
    : LOCAL_BRIDGE_URL;
}

/** NT8 数据桥地址；远程默认同源代理，本机 HTTP 保留直连，可手动覆盖。 */
export function getBridgeUrl(): string {
  const fallback = defaultBridgeUrl();
  try {
    const saved = localStorage.getItem(STORAGE_KEY)?.trim().replace(/\/+$/, '');
    if (!saved) return fallback;
    if (fallback !== LOCAL_BRIDGE_URL) {
      // 兼容旧版设置中已保存的默认回环地址，不让远程页面继续误连自身。
      try {
        const url = new URL(saved);
        if (url.protocol === 'http:' && isLoopback(url.hostname) && url.port === '8090' && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password) return fallback;
      } catch { /* 相对代理路径也允许作为手动设置。 */ }
    }
    return saved;
  } catch {
    return fallback;
  }
}

export function setBridgeUrl(url: string): void {
  try {
    const cleaned = url.trim().replace(/\/+$/, '');
    if (cleaned) localStorage.setItem(STORAGE_KEY, cleaned);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export const DEFAULT_BRIDGE_URL_DISPLAY = defaultBridgeUrl();
