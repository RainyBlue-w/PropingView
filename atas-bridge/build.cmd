@echo off
rem Process-local execution policy; does not change Windows policy settings.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" %*
exit /b %errorlevel%
