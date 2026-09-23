@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

set "PORT=8765"
set "DATA=C:\TranscripIA-data"
if exist ".env" for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
  if /i "%%A"=="APP_PORT" set "PORT=%%B"
  if /i "%%A"=="DATA_DIR" set "DATA=%%B"
)

echo.
echo   Arrêt de BONJOUR IA - Audio Intelligence Workspace...

set "STOPPED="
if exist "%DATA%\server.pid" (
  set /p PID=<"%DATA%\server.pid"
  taskkill /PID !PID! /T /F >nul 2>nul && set "STOPPED=1"
  del "%DATA%\server.pid" >nul 2>nul
)

rem --- Filet de sécurité : processus qui écoute encore sur le port
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /r /c:"127.0.0.1:%PORT% .*LISTENING"') do (
  taskkill /PID %%P /T /F >nul 2>nul && set "STOPPED=1"
)

if defined STOPPED (
  echo   Application arrêtée. Les traitements en cours reprendront au prochain démarrage.
) else (
  echo   L'application n'était pas lancée.
)
echo   (Ollama n'est pas arrêté : il peut servir à d'autres applications.)
ping -n 3 127.0.0.1 >nul
