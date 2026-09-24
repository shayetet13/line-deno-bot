@echo off
setlocal

rem One-click release of the entire current project state to the default VPS
rem (172.237.2.229). Optional arguments are forwarded to deploy-all.ps1, for
rem example: deploy-all.bat -EnableMultiUser
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\deploy-all.ps1" %*
set "exit_code=%ERRORLEVEL%"

echo.
if not "%exit_code%"=="0" (
  echo Deploy failed with exit code %exit_code%.
) else (
  echo Deploy finished successfully.
)
pause

exit /b %exit_code%
