@echo off
cd /d "%~dp0"
if not exist node_modules\hyperframes (
  call npm ci
  if errorlevel 1 exit /b 1
)
node server.mjs --open
pause
