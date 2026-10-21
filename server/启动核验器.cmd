@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   AI 文献核验器 - 本地服务
echo ============================================
echo.

if not exist "%~dp0verify_server.py" (
  echo [错误] 没找到 verify_server.py
  echo        你可能是在压缩包里直接双击的。请先把 zip 完整解压，
  echo        再到解压出来的 server 文件夹里运行本文件。
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
  echo [错误] 找不到 Python。
  echo        装一个 Python 3.8+（勾选 Add Python to PATH），
  echo        或者直接双击 web\index.html（不用服务也能用主体功能）。
  echo.
  pause
  exit /b 1
)

echo [1/2] 启动服务（端口 8799）…关掉这个窗口就停止。
echo.

rem 端口一就绪就自动开浏览器（最多等 20 秒）
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "$u='http://127.0.0.1:8799'; for($i=0;$i -lt 40;$i++){ try { $c=New-Object Net.Sockets.TcpClient('127.0.0.1',8799); $c.Close(); Start-Process $u; break } catch { Start-Sleep -Milliseconds 500 } }"

%PY% verify_server.py

echo.
echo 服务已退出。如果上面有报错，把报错内容发给维护者。
pause
