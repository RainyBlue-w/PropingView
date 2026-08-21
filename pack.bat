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

echo [1/3] Building frontend...
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

echo [2/3] Compiling NT8Terminal.exe...
"%CSC%" /target:exe /platform:anycpu /out:"%~dp0NT8Terminal.exe" "%~dp0server\StaticServer.cs" >nul
if errorlevel 1 (
    echo [X] exe compile failed
    pause
    exit /b 1
)

echo [3/3] Creating zip...
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "Compress-Archive -Path 'NT8Terminal.exe','nt8-bridge\TvBridgeAddOn.cs','app\dist','README.txt' -DestinationPath 'NT8Terminal-package.zip' -Force -CompressionLevel Optimal"
if errorlevel 1 (
    echo [X] Zip failed
    pause
    exit /b 1
)

echo.
echo [OK] Done: NT8Terminal-package.zip
pause
