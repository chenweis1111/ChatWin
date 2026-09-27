@echo off
rem 仅启动聊机 OCR 文字识别服务（7300 端口，自包含 Python，无需安装）
setlocal
set DIR=%~dp0
set PYTHONPATH=%DIR%pkgs
start "聊机-ocr:7300" /min cmd /c ""%DIR%python\python.exe" "%DIR%ocr_service.py" --port 7300 >> "%DIR%..\..\logs\ocr.log" 2>&1"
echo OCR 服务已启动（端口 7300）
endlocal
