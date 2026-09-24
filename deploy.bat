@echo off
setlocal

rem Deploy the default VPS (172.237.2.229).  Optional arguments are forwarded
rem to deploy.ps1, for example: deploy.bat -Action Status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\deploy.ps1" %*
set "exit_code=%ERRORLEVEL%"

if not "%exit_code%"=="0" (
  echo.
  echo Deploy failed with exit code %exit_code%.
  pause
)

exit /b %exit_code%
