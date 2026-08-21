@echo off
rem ============================================================
rem Frontend production build (self-cleaning).
rem
rem Why the cleanup: on Windows, killing an interrupted vite build
rem only kills the parent shell; the orphaned vite/esbuild children
rem stay alive holding the node_modules/.vite cache, and every later
rem build then deadlocks at "transforming..." with 0% CPU.
rem So each build starts by clearing esbuild leftovers + the cache,
rem which keeps the build re-entrant.
rem
rem NOTE: keep this file pure ASCII. Chinese comments get mis-decoded
rem by cmd.exe (GBK codepage) and print bogus "not a command" errors.
rem ============================================================
cd /d %~dp0

taskkill /IM esbuild.exe /F 1>nul 2>nul
if exist node_modules\.vite rd /s /q node_modules\.vite

call npx tsc -b
if errorlevel 1 (echo [build] tsc FAILED & exit /b 1)
call npx vite build
if errorlevel 1 (echo [build] vite FAILED & exit /b 1)
echo [build] OK
