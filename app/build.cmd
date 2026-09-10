@echo off
rem ============================================================
rem Frontend production build (safe alongside the running dev server).
rem
rem Run from native cmd/PowerShell to avoid MSYS child-process IPC hangs.
rem Do not kill global esbuild processes or delete node_modules/.vite:
rem a running Vite dev server still references its optimized dependencies.
rem Deleting them makes lazy-loaded screens fail with HTTP 504.
rem vite.config.ts gives production builds a separate cache directory.
rem
rem NOTE: keep this file pure ASCII. Chinese comments get mis-decoded
rem by cmd.exe (GBK codepage) and print bogus "not a command" errors.
rem ============================================================
cd /d %~dp0

call npx tsc -b
if errorlevel 1 (echo [build] tsc FAILED & exit /b 1)
call npx vite build
if errorlevel 1 (echo [build] vite FAILED & exit /b 1)
echo [build] OK
