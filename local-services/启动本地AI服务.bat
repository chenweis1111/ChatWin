@echo off
rem ============================================================
rem  聊机 仅启动本地 AI 服务（local-server:7200 + analysis:7100）
rem  不启动应用本体；日志写到 logs\，停止请运行「一键停止.bat」
rem ============================================================
setlocal
set APPDIR=%~dp0..
if not exist "%APPDIR%\logs" mkdir "%APPDIR%\logs"
start "聊机-local-server:7200" /min cmd /c "set ELECTRON_RUN_AS_NODE=1&& "%APPDIR%\聊机.exe" "%~dp0local-server\server.js" --port 7200 >> "%APPDIR%\logs\local-server.log" 2>&1"
start "聊机-analysis:7100" /min cmd /c "set ELECTRON_RUN_AS_NODE=1&& "%APPDIR%\聊机.exe" "%~dp0analysis\server.js" --port 7100 >> "%APPDIR%\logs\analysis.log" 2>&1"
echo 本地服务已启动（7200/7100）。
timeout /t 3 >nul
endlocal
