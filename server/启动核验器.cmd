@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8799"
where py >nul 2>nul
if %errorlevel%==0 (
  py verify_server.py
) else (
  python verify_server.py
)
pause
