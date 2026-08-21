const STORAGE_KEY = 'nt8-bridge-url';
const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8090';

/** NT8 数据桥地址,可在界面设置中修改(存 localStorage) */
export function getBridgeUrl(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_BRIDGE_URL;
  } catch {
    return DEFAULT_BRIDGE_URL;
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

export const DEFAULT_BRIDGE_URL_DISPLAY = DEFAULT_BRIDGE_URL;
