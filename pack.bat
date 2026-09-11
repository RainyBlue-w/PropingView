@echo off
rem NT8 Terminal one-click pack: build frontend, compile exe, make zip
rem NOTE: keep this file pure ASCII with CRLF line endings.
setlocal
cd /d "%~dp0"

where npm >nul 2>&1
if errorlevel 1 (
    echo [X] npm not found. Install Node.js LTS first: https://nodejs.org/
    pause
    exit /b 1
)

echo [1/4] Building frontend...
cd app
call npm run build
if errorlevel 1 (
    echo [X] Frontend build failed
    pause
    exit /b 1
)
cd ..

set CSC=C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
    echo [X] csc.exe not found - .NET Framework compiler missing
    pause
    exit /b 1
)

echo [2/4] Compiling NT8Terminal.exe...
"%CSC%" /target:exe /platform:anycpu /out:"%~dp0NT8Terminal.exe" "%~dp0server\StaticServer.cs" >nul
if errorlevel 1 (
    echo [X] exe compile failed
    pause
    exit /b 1
)

echo [3/4] Building copy trading service...
call "%~dp0copy-trading\build.cmd"
if errorlevel 1 (
    echo [X] Copy trading build failed - .NET 10 SDK is required
    pause
    exit /b 1
)

echo [4/4] Creating zip...
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\package.ps1"
if errorlevel 1 (
    echo [X] Zip failed
    pause
    exit /b 1
)

echo.
echo [OK] Done: NT8Terminal-package.zip
pause
