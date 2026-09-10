import path from "path"
import react from "@vitejs/plugin-react"
import { defineConfig, type ProxyOptions } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'

const bridgeProxy: Record<string, ProxyOptions> = {
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
