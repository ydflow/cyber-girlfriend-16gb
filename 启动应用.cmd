@echo off
setlocal
cd /d "%~dp0app"
where pnpm >nul 2>nul || (echo pnpm is required.& exit /b 1)
call pnpm start
