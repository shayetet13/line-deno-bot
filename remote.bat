@echo off
rem ASCII ONLY. Do not put non-ASCII text in this file.
rem cmd.exe parses a .bat by byte offset, so multi-byte UTF-8 (e.g. Thai)
rem desynchronises the parser and it executes fragments of lines. The menu
rem lives in start.ps1, which PowerShell reads as UTF-8 correctly.
rem
rem This is the remote-server menu (SSH tunnel, logs, dry-run/live switch,
rem bench) that start.bat used to launch. start.bat now runs the worker on
rem THIS machine directly; use remote.bat for the Tokyo/production server.

setlocal
cd /d "%~dp0"

rem Prefer PowerShell 7 when present; fall back to Windows PowerShell 5.1.
where pwsh >nul 2>&1
if errorlevel 1 goto winps
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
goto done

:winps
where powershell >nul 2>&1
if errorlevel 1 goto nops
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
goto done

:nops
echo [x] No PowerShell found on PATH.
echo     Run start.ps1 directly, or repair your PATH.
pause
exit /b 1

:done
endlocal
