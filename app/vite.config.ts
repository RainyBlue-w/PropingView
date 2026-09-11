import path from "path"
import type { IncomingHttpHeaders } from 'node:http'
import react from "@vitejs/plugin-react"
import { defineConfig, type ProxyOptions } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

function allowsCopyRequest(headers: IncomingHttpHeaders): boolean {
  const site = headers['sec-fetch-site'];
  if (Array.isArray(site) || site?.toLowerCase() === 'cross-site') return false;
  if (!headers.origin) return true;
  if (!headers.host) return false;
  try {
    const origin = new URL(headers.origin);
    const destination = new URL(`${origin.protocol}//${headers.host}`);
    return ['http:', 'https:'].includes(origin.protocol)
      && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash
      && !destination.username && !destination.password && destination.pathname === '/' && !destination.search && !destination.hash
      && origin.host === destination.host;
  } catch { return false; }
}

const bridgeProxy: Record<string, ProxyOptions> = {
  '/copy/api': {
    target: 'http://127.0.0.1:8092',
    changeOrigin: true,
    rewrite: path => path.replace(/^\/copy(?=\/api(?:\/|\?|$))/, ''),
    bypass(request, response) {
      if (allowsCopyRequest(request.headers)) return;
      if (!response) return false;
      response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: '复制交易只接受同源页面请求。' }));
      // A string return with an ended response stops Vite before it opens an upstream request.
      return request.url ?? '/copy/api';
    },
    configure(proxy) {
      proxy.on('proxyReq', request => {
        // Validate against the public host first; the local service then receives a local request.
        request.removeHeader('Origin');
        request.removeHeader('Sec-Fetch-Site');
      });
      proxy.on('error', (_error, _request, response) => {
        if ('writeHead' in response && !response.headersSent) {
          response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: '复制交易服务未启动，请在主机运行 copy-trading/start.cmd。' }));
        }
      });
    },
  },
  '/atas/api': {
    target: 'http://127.0.0.1:8091',
    changeOrigin: true,
    rewrite: path => path.replace(/^\/atas(?=\/api(?:\/|\?|$))/, ''),
    configure(proxy) {
      proxy.on('error', (_error, _request, response) => {
        if ('writeHead' in response && !response.headersSent) {
          response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: '无法连接 ATAS X 数据桥，请确认主机上的 ATAS X 已加载桥接指标。' }));
        }
      });
    },
  },
  '/api/': {
    target: 'http://127.0.0.1:8090',
    changeOrigin: true,
    // SSE 长连接必须直接转发，不能缓冲到响应结束。
    configure(proxy) {
      proxy.on('error', (_error, _request, response) => {
        if ('writeHead' in response && !response.headersSent) {
          response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: '无法连接 NT8 数据桥，请确认主机上的 NinjaTrader 8 已启动。' }));
        }
      });
    },
  },
};

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
  base: './',
  cacheDir: command === 'build' ? 'node_modules/.vite-build' : 'node_modules/.vite',
  plugins: [inspectAttr(), react()],
  server: {
    port: 3000,
    proxy: bridgeProxy,
  },
  preview: { proxy: bridgeProxy },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
