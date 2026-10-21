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
  echo        请安装 Python 3.8 及以上（安装时勾选 Add Python to PATH），
  echo        或者直接用浏览器打开 web\index.html（功能会少一些，插件连不上）。
  echo.
  pause
  exit /b 1
)

echo [1/2] 使用 %PY% 启动服务，端口 8799
echo       启动后浏览器会自动打开；关掉这个窗口就停止服务。
echo.
start "" cmd /c "timeout /t 4 >nul & start http://127.0.0.1:8799"

%PY% verify_server.py

echo.
echo 服务已退出。如果上一行有报错，把报错内容发给维护者。
pause
