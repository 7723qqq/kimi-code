@echo off
REM Kimi Code launcher.
REM Usage: double-click or run from cmd/powershell.

setlocal

REM Launch kimi-code CLI via Bun.
cd /d "%~dp0"
call bun run dev:cli %*

endlocal
