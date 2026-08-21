@echo off
rem NT8 行情终端 启动脚本(GBK 编码,cmd 原生解析,勿转 UTF-8)
rem 用法: start.bat        开发模式(热更新)
rem       start.bat prod   生产模式(构建后预览)
setlocal

cd /d "%~dp0app"

rem ---- 检查 NT8 数据桥 ----
curl.exe -s -m 2 http://127.0.0.1:8090/api/status >nul 2>&1
if errorlevel 1 (
    echo [!] 未检测到 NT8 数据桥 ^(127.0.0.1:8090^)
    echo     请启动 NinjaTrader 8 并确认 TvBridgeAddOn 已编译加载
    echo     前端将以模拟数据模式运行,不可下单
) else (
    echo [OK] NT8 数据桥已连接 ^(127.0.0.1:8090^)
)

rem ---- 首次运行装依赖 ----
if not exist node_modules (
    echo 首次运行,安装依赖...
    call npm install
    if errorlevel 1 (
        echo 依赖安装失败
        pause
        exit /b 1
    )
)

if /i "%~1"=="prod" goto prod

echo 启动开发服务器: http://127.0.0.1:7100/
call npm run dev -- --host 127.0.0.1 --port 7100
goto end

:prod
echo 构建生产包...
call npm run build
if errorlevel 1 (
    echo 构建失败
    pause
    exit /b 1
)
echo 启动生产预览: http://127.0.0.1:7100/
call npm run preview -- --host 127.0.0.1 --port 7100

:end
endlocal
