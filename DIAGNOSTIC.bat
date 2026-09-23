@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1
where python >nul 2>nul || (echo   [ERREUR] Python est introuvable. & pause & exit /b 1)
python -m backend.services.diagnostic_service %*
echo   Test approfondi (transcription + réponse de Qwen) : DIAGNOSTIC.bat --deep
echo.
pause
