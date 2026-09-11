@echo off
rem ============================================================
rem  cproxy installer (Windows, no admin required)
rem
rem  What it does:
rem   1. Checks that Node.js is installed
rem   2. Installs Claude Code globally via npm
rem   3. Writes %USERPROFILE%\.claude\settings.json pointing at the proxy
rem      (existing file is backed up as settings.json.bak)
rem   4. Adds start-proxy.cmd to your Startup folder so the proxy
rem      auto-starts at logon
rem
rem  Usage:  double-click, or run from a terminal in this folder:
rem          install.cmd [UPSTREAM_URL] [MODEL_NAME]
rem    UPSTREAM_URL defaults to http://localhost:8080/v1
rem    MODEL_NAME   defaults to qwen3.8-27b
rem ============================================================
setlocal EnableExtensions

if "%~1"=="" ( set "UPSTREAM=http://localhost:8080/v1" ) else ( set "UPSTREAM=%~1" )
if "%~2"=="" ( set "MODEL=qwen3.8-27b" ) else ( set "MODEL=%~2" )

echo.
echo === cproxy installer ===
echo   upstream : %UPSTREAM%
echo   model    : %MODEL%
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
  echo [..] Backing up existing settings.json -> settings.json.bak
  copy /y "%CLAUDE_DIR%\settings.json" "%CLAUDE_DIR%\settings.json.bak" >nul
)

> "%CLAUDE_DIR%\settings.json" (
  echo {
  echo   "env": {
  echo     "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
  echo     "ANTHROPIC_API_KEY": "llama-proxy-local",
  echo     "ANTHROPIC_MODEL": "%MODEL%",
  echo     "MAX_THINKING_TOKENS": "0",
  echo     "DISABLE_PROMPT_CACHING": "1",
  echo     "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "4096",
  echo     "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "100000"
  echo   }
  echo }
)
echo [ok] Wrote %CLAUDE_DIR%\settings.json

rem ---------- 4. proxy.env (upstream config for the launcher) ----------
> "%~dp0proxy.env" (
  echo # cproxy configuration - edit to taste, then re-run start-proxy.cmd
  echo UPSTREAM=%UPSTREAM%
  rem echo PORT=8787
)
echo [ok] Wrote %~dp0proxy.env

rem ---------- 5. Startup auto-start ----------
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
copy /y "%~dp0start-proxy.cmd" "%STARTUP%\cproxy.cmd" >nul
if errorlevel 1 (
  echo [warn] Could not copy to Startup folder - start the proxy manually with start-proxy.cmd
) else (
  echo [ok] Proxy will auto-start at logon: %STARTUP%\cproxy.cmd
)

echo.
echo === Done! ===
echo   1. Start the proxy:  start-proxy.cmd   (or just log in again)
echo   2. Run Claude Code:  claude            (in any terminal, e.g. VS Code)
echo   Test it:             claude -p "Reply with exactly: OK"
echo.
pause
