# Earshot for Windows — one-line install, no SmartScreen prompt.
#
#   irm https://<hub>/install/windows | iex
#
# Why a pipe instead of the .exe download: a downloaded executable carries the
# Mark of the Web, so Explorer shows "Windows protected your PC" and a friend has
# to find "More info -> Run anyway". A script piped into iex is never a file, so
# nothing marks it and no dialog appears. Updates then cost nothing either — the
# agent pulls new code from the hub itself (see capture/updater.py).
#
# Generic on purpose: no capture key baked in. Identity comes from device
# pairing — the dashboard opens and you click "Allow this computer".
$ErrorActionPreference = 'Stop'

$Hub  = if ($env:EARSHOT_HUB) { $env:EARSHOT_HUB } else { '{{HTTP_URL}}' }
$Root = if ($env:EARSHOT_APPDIR) { $env:EARSHOT_APPDIR } else { Join-Path $env:LOCALAPPDATA 'Earshot' }
$Src  = Join-Path $Root 'src'
$Venv = Join-Path $Root 'venv'
$Dry  = [bool]$env:EARSHOT_INSTALL_DRY   # CI: install everything, start nothing

function Say($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Die($m) { Write-Host "`n!! $m" -ForegroundColor Red; exit 1 }

# Windows PowerShell 5.1 turns a native tool's stderr into ErrorRecords, which
# $ErrorActionPreference='Stop' then treats as fatal — so `uv venv` writing its
# normal progress to stderr would abort the install. Run native commands through
# this instead: stringify every line, judge success by the exit code only.
function Native {
  param([string]$Exe, [string[]]$Arguments, [string]$What, [switch]$Show)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe @Arguments 2>&1 | ForEach-Object {
      $line = $_.ToString()
      if ($Show) { Write-Host "    $line" }
    }
    if ($LASTEXITCODE -ne 0) { Die "$What failed (exit $LASTEXITCODE)" }
  } finally { $ErrorActionPreference = $prev }
}

Write-Host "`nEarshot - ambient conversation dashboard" -ForegroundColor White
Write-Host "Installing for $env:USERNAME from $Hub"
New-Item -ItemType Directory -Force -Path $Root, (Join-Path $Root 'models') | Out-Null

# ---- 1. Python. uv brings its own, so nothing else has to be installed ----
Say 'Setting up Python'
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv) {
  $local = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
  if (Test-Path $local) { $uv = $local }
}
if (-not $uv) {
  try {
    # astral's installer is the same pipe trick, so still no SmartScreen
    Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
    $local = Join-Path $env:USERPROFILE '.local\bin\uv.exe'
    if (Test-Path $local) { $uv = $local }
  } catch { }
}
if ($uv) {
  # --clear: a machine that ran the old packaged app already has a venv here, and
  # uv refuses to write into an existing one (exit 2). Reuse is not worth the
  # branch — the deps get reinstalled below either way.
  Native $uv @('venv', '--clear', '--python', '3.12', $Venv) 'Creating the Python environment'
  $py = Join-Path $Venv 'Scripts\python.exe'
  $pipExe = $uv
  $pipArgs = @('pip', 'install', '--python', $py, '--quiet')
} else {
  $sys = (Get-Command python -ErrorAction SilentlyContinue).Source
  if (-not $sys) { Die "Could not install Python. Install it from the Microsoft Store (search 'Python 3.12') and run this again." }
  Native $sys @('-m', 'venv', $Venv) 'Creating the Python environment'
  $py = Join-Path $Venv 'Scripts\python.exe'
  Native $py @('-m', 'pip', 'install', '--quiet', '--upgrade', 'pip') 'Updating pip'
  $pipExe = $py
  $pipArgs = @('-m', 'pip', 'install', '--quiet')
}

# ---- 2. The capture code (public tarball; also the update path) ----
Say 'Downloading Earshot'
$tgz = Join-Path $env:TEMP 'earshot-capture.tgz'
Invoke-WebRequest -UseBasicParsing "$Hub/installer/capture.tgz" -OutFile $tgz
Remove-Item -Recurse -Force "$Src.new" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path "$Src.new" | Out-Null
# tar ships with Windows 10+; -C keeps MSYS quirks out of it
Native 'tar' @('-xzf', $tgz, '-C', "$Src.new") 'Unpacking the download'
if (-not (Test-Path (Join-Path "$Src.new" 'main.py'))) { Die "The download looks wrong (no main.py). Is $Hub reachable?" }
Remove-Item -Recurse -Force "$Src.old" -ErrorAction SilentlyContinue
if (Test-Path $Src) { Move-Item $Src "$Src.old" }
Move-Item "$Src.new" $Src
Remove-Item $tgz -ErrorAction SilentlyContinue
# the version IS the tarball's hash — how the agent knows whether it's current
(Invoke-RestMethod "$Hub/installer/capture.json").version |
  Set-Content -NoNewline -Encoding ascii (Join-Path $Root 'version.txt')
Write-Host ("    version " + (Get-Content (Join-Path $Root 'version.txt')).Substring(0, 12))

Say 'Installing dependencies (a minute or two)'
Native $pipExe ($pipArgs + @('-r', (Join-Path $Src 'requirements-win-cpu.txt'))) 'Installing dependencies'
# the tray icon is optional: if it won't build, capture still runs headless
$prevEA = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
& $pipExe @pipArgs -r (Join-Path $Src 'requirements-agent.txt') 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host '    (no tray icon - running headless instead)' }
$ErrorActionPreference = $prevEA

# ---- 3. Pair, in the foreground while you're watching ----
if (-not $Dry) {
  Say 'Connecting this computer to your dashboard'
  Write-Host '    A browser tab will open - click "Allow this computer".'
  Push-Location $Src
  $env:EARSHOT_HUB = $Hub
  $env:EARSHOT_APPDIR = $Root
  Native $py @('tray.py', '--pair-only') 'Pairing' -Show
  Pop-Location
}

# ---- 4. Autostart: a hidden pythonw at logon (no console window) ----
Say 'Installing the background agent'
$pyw = Join-Path $Venv 'Scripts\pythonw.exe'
if (-not (Test-Path $pyw)) { $pyw = $py }
$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $Root 'start-agent.vbs'
@"
' Launches the Earshot agent with no console window (installed by Earshot).
Set sh = CreateObject("WScript.Shell")
sh.Environment("PROCESS").Item("EARSHOT_HUB") = "$Hub"
sh.Environment("PROCESS").Item("EARSHOT_APPDIR") = "$Root"
' the ROOT, never src: Windows can't rename a directory that is a running
' process's CWD, which is exactly what a self-update has to do
sh.CurrentDirectory = "$Root"
sh.Run """$pyw"" ""$Src\tray.py""", 0, False
"@ | Set-Content -Encoding ascii $vbs
$lnk = Join-Path $startup 'Earshot.lnk'
$wsh = New-Object -ComObject WScript.Shell
$sc = $wsh.CreateShortcut($lnk)
$sc.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$sc.Arguments = """$vbs"""
$sc.WorkingDirectory = $Root
$sc.Description = 'Earshot capture agent'
$sc.Save()

# ---- 5. An `earshot` command so "restart it" isn't a support call ----
$binDir = Join-Path $env:USERPROFILE '.local\bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null
@"
@echo off
rem Earshot agent control (installed by the Earshot installer)
set ROOT=$Root
if "%1"=="" goto status
if /i "%1"=="start" goto start
if /i "%1"=="stop" goto stop
if /i "%1"=="restart" goto restart
if /i "%1"=="log" goto log
if /i "%1"=="update" goto update
if /i "%1"=="version" goto version
if /i "%1"=="dash" goto dash
if /i "%1"=="status" goto status
echo usage: earshot {start^|stop^|restart^|status^|log^|update^|version^|dash}
goto :eof
:start
wscript "%ROOT%\start-agent.vbs" & echo Earshot started. & goto :eof
:stop
taskkill /f /im pythonw.exe >nul 2>&1 & echo Earshot stopped. & goto :eof
:restart
taskkill /f /im pythonw.exe >nul 2>&1 & timeout /t 1 >nul & wscript "%ROOT%\start-agent.vbs" & echo Earshot restarted. & goto :eof
:log
powershell -NoProfile -Command "Get-Content -Wait '%ROOT%\capture.log'" & goto :eof
:update
"$py" -c "import sys;sys.path.insert(0,r'%ROOT%\src');import updater;print(updater.apply(r'$Hub') or 'already current')" & goto restart
:version
powershell -NoProfile -Command "(Get-Content '%ROOT%\version.txt').Substring(0,12)" & goto :eof
:dash
start "" "$Hub" & goto :eof
:status
tasklist /fi "imagename eq pythonw.exe" | find /i "pythonw" >nul && echo running || echo not running
"@ | Set-Content -Encoding ascii (Join-Path $binDir 'earshot.cmd')

if (-not $Dry) { & wscript $vbs }

Write-Host "`n✓ Earshot is installed and listening." -ForegroundColor Green
Write-Host @"

  Dashboard   $Hub
  Control     earshot status | earshot log | earshot restart
  Updates     automatic - it picks up new versions from the hub by itself

"@
if ($env:PATH -notlike "*$binDir*") {
  Write-Host "  (the 'earshot' command lives in $binDir - add it to your PATH to use it)"
}
