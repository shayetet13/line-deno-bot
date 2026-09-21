@echo off
rem ASCII ONLY. Do not put non-ASCII text in this file.
rem cmd.exe parses a .bat by byte offset, so multi-byte UTF-8 (e.g. Thai)
rem desynchronises the parser and it executes fragments of lines.
rem
rem Runs the worker on THIS machine (local bot config + local .sessions),
rem then opens the login page. For the Tokyo/production server menu
rem (SSH tunnel, logs, dry-run/live switch, bench), use remote.bat instead.

setlocal
cd /d "%~dp0"

set CONFIG=config\bots\bot-1.json
set SESSIONS_DIR=.sessions
set USERS_FILE=.control\bot-users\bot-1.json
set PORT=8791

where deno >nul 2>&1
if errorlevel 1 (
    echo [x] deno not found on PATH.
    echo     Install: irm https://deno.land/install.ps1 ^| iex
    pause
    exit /b 1
)

if not exist "%CONFIG%" (
    echo [x] %CONFIG% not found.
    echo     Copy config\bots\bot-1.example.json to %CONFIG% and edit it first.
    pause
    exit /b 1
)

echo Starting local worker: %CONFIG%  (sessions: %SESSIONS_DIR%, port: %PORT%)
echo Opening http://localhost:%PORT%/account/login
echo Press Ctrl+C to stop for real.
echo.

start "" "http://localhost:%PORT%/account/login"

rem The worker intentionally exits itself after certain actions (logging
rem in/out, an admin-only "restart" click, a room-selection change that
rem flips the talk/square surface) and relies on systemd's Restart=always
rem to bring it back in production. There is no such supervisor when
rem running locally, so without this loop each of those looked like the
rem server randomly dying instead of restarting.
:run
deno task serve --config "%CONFIG%" --sessions-dir "%SESSIONS_DIR%" --users-file "%USERS_FILE%" --port %PORT% %*
echo.
echo [i] worker stopped -- restarting in 3s (Ctrl+C, then Y, to quit for real)
timeout /t 3 /nobreak >nul
goto run

endlocal
