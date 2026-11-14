@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Dang cai dat thu vien lan dau...
  call npm install
  if errorlevel 1 exit /b 1
) else if not exist node_modules\lucide (
  echo Cap nhat thu vien bo sung...
  call npm install
  if errorlevel 1 exit /b 1
)
node server.mjs --open
pause
