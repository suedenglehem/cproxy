@echo off
rem ============================================================
rem  cproxy launcher - starts the translation proxy if not
rem  already running. Safe to call multiple times (port guard).
rem  Config: proxy.env next to this file (KEY=VALUE lines, # comments)
rem  Log   : proxy.log next to this file
rem ============================================================
setlocal EnableExtensions
cd /d "%~dp0"

rem Load optional configuration from proxy.env
if exist "proxy.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in ("proxy.env") do set "%%a=%%b"
)
if not defined PORT set PORT=8787

rem Already running?
netstat -ano | findstr "LISTENING" | findstr /c:":%PORT% " >nul && (
  echo [cproxy] already listening on port %PORT%
  exit /b 0
)

echo [cproxy] starting proxy on port %PORT% ...
start "" /B node proxy.mjs >> "proxy.log" 2>&1
exit /b 0
