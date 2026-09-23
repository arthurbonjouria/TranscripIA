@echo off
setlocal EnableExtensions
chcp 65001 >nul
title BONJOUR IA - Audio Intelligence Workspace
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1

set "PORT=8765"
if exist ".env" for /f "usebackq tokens=1,* delims==" %%A in (".env") do if /i "%%A"=="APP_PORT" set "PORT=%%B"
set "URL=http://127.0.0.1:%PORT%"

echo.
echo   BONJOUR IA - Audio Intelligence Workspace
echo   Traitement 100 %% local
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo   [ERREUR] Python est introuvable. Installez Python 3.11+ depuis https://www.python.org
  pause
  exit /b 1
)

rem --- Déjà lancé ?
curl.exe -s -o nul -m 2 "%URL%/api/ping" && (
  echo   L'application est déjà lancée : ouverture du navigateur.
  start "" "%URL%"
  exit /b 0
)

rem --- Dépendances Python
python -c "import fastapi, uvicorn, multipart, faster_whisper, docx, reportlab" >nul 2>nul
if errorlevel 1 (
  echo   Installation des dépendances Python...
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo   [ERREUR] L'installation des dépendances a échoué.
    pause
    exit /b 1
  )
)

rem --- Ollama (facultatif : sans lui, la transcription reste disponible)
curl.exe -s -o nul -m 2 "http://127.0.0.1:11434/api/version"
if errorlevel 1 (
  if exist "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe" (
    echo   Démarrage d'Ollama...
    start "" "%LOCALAPPDATA%\Programs\Ollama\ollama app.exe"
  ) else (
    echo   [INFO] Ollama n'est pas démarré : l'analyse IA sera indisponible, la transcription fonctionnera.
  )
)

echo   Démarrage du serveur local sur %URL% ...
start "BONJOUR IA - serveur" /min python -m backend.run

set /a TRIES=0
:wait
set /a TRIES+=1
ping -n 2 127.0.0.1 >nul
curl.exe -s -o nul -m 2 "%URL%/api/ping" && goto ready
if %TRIES% GEQ 60 (
  echo   [ERREUR] Le serveur ne répond pas. Consultez les journaux (dossier logs des données) ou lancez DIAGNOSTIC.bat.
  pause
  exit /b 1
)
goto wait

:ready
echo   Prêt. Ouverture de %URL%
start "" "%URL%"
echo.
echo   Pour arrêter l'application : STOP.bat
ping -n 4 127.0.0.1 >nul
exit /b 0
