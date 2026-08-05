# Earshot capture installer for Windows — right-click > "Run with PowerShell".
# GUI prompts for everything; no commands to type.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.VisualBasic

function Say($text, $title = "Earshot Setup") {
  [System.Windows.Forms.MessageBox]::Show($text, $title, "OK", "Information") | Out-Null
}
function Ask($prompt, $default = "") {
  [Microsoft.VisualBasic.Interaction]::InputBox($prompt, "Earshot Setup", $default)
}

$AppDir = Join-Path $env:LOCALAPPDATA "Earshot"
$ModelUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

$go = [System.Windows.Forms.MessageBox]::Show(
  "Welcome to Earshot!`n`nThis sets up the audio capture agent (about five minutes, ~1 GB of speech models).`n`nYou'll need the dashboard address and your capture key (both shown in the dashboard's Settings panel).",
  "Earshot Setup", "OKCancel", "Information")
if ($go -ne "OK") { exit }

# Python 3.10+ (real install, not the Store stub)
$py = Get-Command python -ErrorAction SilentlyContinue
$pyOk = $false
if ($py) { try { $v = & python -c "import sys;print(sys.version_info>=(3,10))" 2>$null; $pyOk = ($v -eq "True") } catch {} }
if (-not $pyOk) {
  Say "Python needs to be installed first.`n`nClicking OK opens python.org — download Python 3.12, run the installer, and IMPORTANT: tick 'Add python.exe to PATH'. Then run this installer again."
  Start-Process "https://www.python.org/downloads/windows/"
  exit
}

Write-Host "==> Copying Earshot to $AppDir"
New-Item -ItemType Directory -Force $AppDir | Out-Null
New-Item -ItemType Directory -Force (Join-Path $AppDir "models") | Out-Null
Copy-Item (Join-Path $Here "..\capture\*.py") $AppDir -Force
Copy-Item (Join-Path $Here "..\capture\requirements-win-cpu.txt") $AppDir -Force

Write-Host "==> Creating Python environment (a few minutes)..."
& python -m venv (Join-Path $AppDir "venv")
$venvPy = Join-Path $AppDir "venv\Scripts\python.exe"
& $venvPy -m pip install --quiet --upgrade pip
& $venvPy -m pip install --quiet -r (Join-Path $AppDir "requirements-win-cpu.txt")

$model = Join-Path $AppDir "models\nemo_en_titanet_small.onnx"
if (-not (Test-Path $model)) {
  Write-Host "==> Downloading speaker model..."
  Invoke-WebRequest -Uri $ModelUrl -OutFile $model
}

$hub = Ask "Dashboard address (from Settings in the dashboard), e.g. earshot.example.com"
$key = Ask "Your capture key (copy it from Settings in the dashboard)"
$scheme = "wss"; if ($hub -match "localhost|127\.0\.0\.1") { $scheme = "ws" }
@"
EARSHOT_WS=${scheme}://$hub/ingest
EARSHOT_KEY=$key
EARSHOT_MODEL=small.en
EARSHOT_DEVICE=cpu
"@ | Out-File -Encoding ascii (Join-Path $AppDir "cloud.env")

$desktop = [Environment]::GetFolderPath("Desktop")
@"
@echo off
cd /d "$AppDir"
echo Earshot capture running - close this window to stop.
"$venvPy" main.py --env-file cloud.env
pause
"@ | Out-File -Encoding ascii (Join-Path $desktop "Earshot Capture.bat")

Say "Done!`n`n1. Double-click 'Earshot Capture' on your Desktop to start listening (allow microphone access if Windows asks).`n`n2. Open the dashboard in your browser, sign in with Google, and press Record when a conversation starts."
