#!/usr/bin/env bash
# NT8 行情终端 启动脚本(Git Bash / 终端用)
# 用法: ./start.sh        -> 开发模式(热更新)
#       ./start.sh prod   -> 生产模式(构建后预览)
set -e
cd "$(dirname "$0")/app"

# ---- 检查 NT8 数据桥 ----
if curl.exe -s -m 2 http://127.0.0.1:8090/api/status >/dev/null 2>&1; then
  echo "[√] NT8 数据桥已连接 (127.0.0.1:8090)"
else
  echo "[!] 未检测到 NT8 数据桥 (127.0.0.1:8090)"
  echo "    请启动 NinjaTrader 8 并确认 TvBridgeAddOn 已编译加载;"
  echo "    前端将以模拟数据模式运行,不可下单。"
fi

# ---- 首次运行装依赖 ----
if [ ! -d node_modules ]; then
  echo "首次运行,安装依赖…"
  npm install
fi

if [ "${1:-dev}" = "prod" ]; then
  echo "构建生产包…"
  npm run build
  echo "启动生产预览: http://127.0.0.1:7100/"
  exec npm run preview -- --host 127.0.0.1 --port 7100
else
  echo "启动开发服务器: http://127.0.0.1:7100/"
  exec npm run dev -- --host 127.0.0.1 --port 7100
fi
