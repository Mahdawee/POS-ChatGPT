@echo off
rem Dar POS - License Manager Panel (double-click launcher)
rem Requires Node.js on PATH. The panel opens in your browser automatically.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
node panel.js
pause
