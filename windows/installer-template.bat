@echo off
setlocal EnableExtensions
title Earshot Setup
:: Personalized Earshot installer — served by the hub with this user's server
:: address and capture key already substituted in. Double-click and everything
:: happens: Python if needed, capture agent, config, autostart.
set "APPDIR=%LOCALAPPDATA%\Earshot"
if not "%EARSHOT_APPDIR%"=="" set "APPDIR=%EARSHOT_APPDIR%"

echo.
echo  === Earshot setup ===
echo  Installing to: %APPDIR%
echo.

where python >nul 2>nul
if not errorlevel 1 goto :havepython
echo ==^> Python not found - installing it automatically (1-2 minutes)...
winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo Could not install Python automatically.
  echo Opening python.org - install Python 3.12 and TICK "Add python.exe to PATH",
  echo then double-click this file again.
  start "" "https://www.python.org/downloads/windows/"
  goto :fail
)
set "PATH=%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%PATH%"
:havepython

if not exist "%APPDIR%" mkdir "%APPDIR%"
cd /d "%APPDIR%" || goto :fail

echo ==^> Downloading Earshot capture agent...
curl -sL -o capture.tgz "{{HTTP_URL}}/installer/capture.tgz" || goto :fail
tar -xzf capture.tgz || goto :fail
del capture.tgz

if not exist venv (
  echo ==^> Setting up the speech engine - this takes a few minutes...
  python -m venv venv || goto :fail
)
venv\Scripts\python.exe -m pip install --quiet --upgrade pip
venv\Scripts\python.exe -m pip install --quiet -r requirements-win-cpu.txt || goto :fail

if not exist models mkdir models
if not exist models\nemo_en_titanet_small.onnx (
  echo ==^> Downloading voice model...
  curl -sL -o models\nemo_en_titanet_small.onnx "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx" || goto :fail
)

(
  echo EARSHOT_WS={{WS_URL}}
  echo EARSHOT_KEY={{CAPTURE_KEY}}
  echo EARSHOT_MODEL=small.en
  echo EARSHOT_DEVICE=cpu
) > cloud.env

(
  echo @echo off
  echo title Earshot Capture
  echo cd /d "%APPDIR%"
  echo echo Earshot is listening - close this window to stop.
  echo venv\Scripts\python.exe main.py --env-file cloud.env
  echo pause
) > "%USERPROFILE%\Desktop\Earshot Capture.bat"

echo.
echo  === Done! ===
echo  Starting Earshot now (allow microphone access if Windows asks).
echo  Next time, double-click "Earshot Capture" on your Desktop.
echo.
start "" "%USERPROFILE%\Desktop\Earshot Capture.bat"
pause
exit /b 0

:fail
echo.
echo  Something went wrong - screenshot this window and send it to Connor.
pause
exit /b 1
