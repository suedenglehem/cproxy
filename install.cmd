@echo off
rem ============================================================
rem  cproxy installer (Windows)
rem
rem  What it does:
rem   1. Checks that Node.js is installed
rem   2. Installs Claude Code globally via npm
rem   3. Writes %USERPROFILE%\.claude\settings.json pointing at the proxy
rem      (existing file is backed up as settings.json.bak)
rem   4. Writes proxy.env next to this script (upstream config for the service)
rem   5. Installs node-windows into vendor\ so the service works offline
rem   6. Registers + starts cproxy as a real Windows SERVICE (auto-start at
rem      boot, survives logoff, auto-restarts on crash). Prompts UAC if you
rem      didn't run this from an elevated terminal.
rem   7. Removes any old Startup-folder autostart so it doesn't double-launch
rem
rem  Usage:  double-click, or run from a terminal in this folder:
rem          install.cmd [UPSTREAM_URL] [MODEL_NAME] [PORT]
rem    UPSTREAM_URL defaults to http://tr4:8080/v1
rem    MODEL_NAME   defaults to qwen3.8-27b
rem    PORT         defaults to 8787 (the port Claude Code is pointed at)
rem ============================================================
setlocal EnableExtensions

if "%~1"=="" ( set "UPSTREAM=http://tr4:8080/v1" ) else ( set "UPSTREAM=%~1" )
if "%~2"=="" ( set "MODEL=qwen3.8-27b" ) else ( set "MODEL=%~2" )
if "%~3"=="" ( set "PORT=8787" ) else ( set "PORT=%~3" )

echo.
echo === cproxy installer ===
echo   upstream : %UPSTREAM%
echo   model    : %MODEL%
echo   port     : %PORT%
echo.

rem ---------- 1. Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found on PATH.
  echo         Install it from https://nodejs.org and re-run this installer.
  pause & exit /b 1
)
for /f "delims=" %%v in ('node --version') do set NODEVER=%%v
echo [ok] Node.js %NODEVER%

rem ---------- 2. Claude Code ----------
where claude >nul 2>nul
if errorlevel 1 (
  echo [..] Installing Claude Code globally via npm ...
  call npm install -g @anthropic-ai/claude-code || (echo [ERROR] npm install failed & pause & exit /b 1)
) else (
  echo [ok] Claude Code already installed
)

rem ---------- 3. settings.json ----------
set "CLAUDE_DIR=%USERPROFILE%\.claude"
if not exist "%CLAUDE_DIR%" mkdir "%CLAUDE_DIR%"
if exist "%CLAUDE_DIR%\settings.json" (
  echo [..] Backing up existing settings.json -^> settings.json.bak
  copy /y "%CLAUDE_DIR%\settings.json" "%CLAUDE_DIR%\settings.json.bak" >nul
)

> "%CLAUDE_DIR%\settings.json" (
  echo {
  echo   "env": {
  echo     "ANTHROPIC_BASE_URL": "http://127.0.0.1:%PORT%",
  echo     "ANTHROPIC_API_KEY": "llama-proxy-local",
  echo     "ANTHROPIC_MODEL": "%MODEL%",
  echo     "MAX_THINKING_TOKENS": "0",
  echo     "DISABLE_PROMPT_CACHING": "1",
  echo     "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "4096",
  echo     "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "100000"
  echo   }
  echo }
)
echo [ok] Wrote %CLAUDE_DIR%\settings.json (pointing at port %PORT%)

rem ---------- 4. proxy.env (upstream config for the service) ----------
> "%~dp0proxy.env" (
  echo # cproxy configuration - edit to taste, then: node service.cjs restart
  echo UPSTREAM=%UPSTREAM%
)
echo [ok] Wrote %~dp0proxy.env

rem ---------- 5. node-windows (offline-capable service bridge) ----------
if not exist "%~dp0vendor\node_modules\node-windows" (
  echo [..] Installing node-windows into vendor\ ...
  call npm install --prefix "%~dp0vendor" node-windows || (echo [ERROR] node-windows install failed & pause & exit /b 1)
) else (
  echo [ok] node-windows already present in vendor\
)

rem ---------- 6. Register + start the Windows service ----------
echo [..] Registering cproxy as a Windows service on port %PORT% ...
net session >nul 2>nul
if errorlevel 1 (
  rem Not elevated - re-run just the install step under UAC.
  echo        ^(not running as admin - a UAC prompt will appear^)
  powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList 'service.cjs','install','%PORT%','127.0.0.1' -WorkingDirectory '%~dp0' -Verb RunAs -Wait"
) else (
  node "%~dp0service.cjs" install %PORT% 127.0.0.1
)

rem ---------- 7. Remove old Startup-folder autostart (avoid double-launch) ----------
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
for %%f in (cproxy.cmd ClaudeLlamaProxy.cmd start-proxy.cmd) do (
  if exist "%STARTUP%\%%f" (
    del "%STARTUP%\%%f" >nul 2>nul && echo [ok] Removed old Startup-folder autostart: %%f
  )
)

echo.
echo === Done! ===
echo   Service : cproxy.exe  ^(starts at boot, auto-restarts on crash^)
echo   Proxy   : http://127.0.0.1:%PORT%  -^> %UPSTREAM%
echo   Check   : node service.cjs status
echo   Run     : claude            (in any terminal)
echo   Test    : claude -p "Reply with exactly: OK"
echo.
pause
