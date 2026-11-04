@echo off
rem Dar POS - Owner Settings Tool (double-click launcher)
rem
rem Opens the tool page through a tiny local web server (http://localhost)
rem so the browser's "system folder" block can never apply - this works
rem even if the whole folder sits inside %APPDATA% or Program Files.
rem A small black window stays open while you use the tool; close it when
rem you are done. If the local server cannot start for any reason, the
rem launcher falls back to opening a copy of the page from Documents.
cd /d "%~dp0"
if not exist "tool.html" (
  echo tool.html was not found next to this launcher.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$h=[IO.File]::ReadAllText((Join-Path (Get-Location) 'tool.html')); $l=New-Object Net.HttpListener; $l.Prefixes.Add('http://localhost:8791/'); $ok=$true; try { $l.Start() } catch { $ok=$false }; if ($ok) { Start-Process 'http://localhost:8791/'; Write-Host 'Owner tool: http://localhost:8791/'; Write-Host 'Keep this window open while using the tool. Close it when done.'; while ($l.IsListening) { $c=$l.GetContext(); $b=[Text.Encoding]::UTF8.GetBytes($h); $c.Response.ContentType='text/html; charset=utf-8'; $c.Response.ContentLength64=$b.Length; $c.Response.OutputStream.Write($b,0,$b.Length); $c.Response.Close() } } else { $done=$false; $f=''; try { $p=Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'DarPOS-owner-tool.html'; [IO.File]::WriteAllText($p,$h); $f=$p; $done=$true } catch {}; if (-not $done) { try { $p=Join-Path $env:PUBLIC 'DarPOS-owner-tool.html'; [IO.File]::WriteAllText($p,$h); $f=$p; $done=$true } catch {} }; if ($done) { Start-Process $f } else { Write-Host 'Could not open the tool automatically.'; Write-Host 'Copy tool.html to Desktop and double-click it there.'; pause } }"
