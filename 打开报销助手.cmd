@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node.exe >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22.13 or later, then reopen this file.
  pause
  exit /b 1
)
node scripts\start.mjs %*
if errorlevel 1 (
  pause
  exit /b 1
)
