@echo off
rem Dar POS - Owner Settings Tool (double-click launcher)
rem
rem Browsers refuse to open HTML pages that sit inside protected Windows
rem folders (AppData, Program Files, Windows...). If you keep this folder
rem inside such a place, this launcher copies the tool page to Documents
rem and opens it from there - which always works. The opened page still
rem reads and writes owner.json through the file picker, so nothing is
rem lost. Running it from a normal folder (Desktop, Documents...) works
rem exactly the same way.
cd /d "%~dp0"
if not exist "tool.html" (
  echo tool.html was not found next to this launcher.
  pause
  exit /b 1
)
set "SAFE=%USERPROFILE%\Documents\DarPOS-owner-tool.html"
copy /y "tool.html" "%SAFE%" >nul
if errorlevel 1 (
  echo Could not copy the tool to Documents. Open tool.html directly from
  echo a normal folder such as Desktop.
  pause
  exit /b 1
)
start "" "%SAFE%"
