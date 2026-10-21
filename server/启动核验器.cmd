@echo off
setlocal enableextensions
cd /d "%~dp0"

set "LOG=%TEMP%\litcheck-start.log"
echo [start] %date% %time% > "%LOG%"
echo dir=%CD% >> "%LOG%"

echo ==========================================
echo   AI Literature Checker - Local Server
echo ==========================================
echo.

if not exist "%~dp0verify_server.py" (
  echo [ERROR] verify_server.py not found.
  echo         You probably double-clicked inside the zip.
  echo         Extract the zip first, then run this file in the server folder.
  echo [ERROR] verify_server.py missing >> "%LOG%"
  echo.
  pause
  exit /b 1
)

set "PY="
where py >nul 2>nul && set "PY=py"
if not defined PY (
  where python >nul 2>nul && set "PY=python"
)
if not defined PY (
  echo [ERROR] Python not found.
  echo         Install Python 3.8+ with "Add Python to PATH",
  echo         or just open web\index.html in a browser.
  echo [ERROR] python missing >> "%LOG%"
  echo.
  pause
  exit /b 1
)

echo [1/2] Using %PY% , port 8799
echo       Close this window to stop the server.
echo.

rem Open the browser only after the port is really listening
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "$u='http://127.0.0.1:8799'; for($i=0;$i -lt 60;$i++){ try { $c=New-Object Net.Sockets.TcpClient('127.0.0.1',8799); $c.Close(); Start-Process $u; break } catch { Start-Sleep -Milliseconds 500 } }"

%PY% verify_server.py
set "RC=%errorlevel%"

echo.
echo [2/2] Server stopped (exit code %RC%).
echo       Details: %LOG%
echo exit %RC% >> "%LOG%"
pause
