#!/bin/bash
# Earshot for macOS — one-line install, no security dialogs.
#
#   curl -fsSL https://<hub>/install/mac | bash
#
# Why a pipe instead of the .app download: since macOS Tahoe, an unsigned app
# that arrived through a browser is QUARANTINED and blocked in every condition —
# Gatekeeper offers only "Move to Trash", and neither right-click-Open nor
# Privacy & Security rescues it. A script piped into bash is never quarantined,
# and neither is anything it fetches with curl, so this whole path never meets
# Gatekeeper. It also means updates are just a download (see capture/updater.py).
#
# This script is generic — no capture key baked in. Identity comes from device
# pairing: it opens the dashboard, you click "Allow this computer".
set -euo pipefail

HUB="${EARSHOT_HUB:-{{HTTP_URL}}}"
ROOT="${EARSHOT_APPDIR:-$HOME/Library/Application Support/Earshot}"
SRC="$ROOT/src"
VENV="$ROOT/venv"
PLIST="$HOME/Library/LaunchAgents/dev.earshot.capture.plist"
DRY="${EARSHOT_INSTALL_DRY:-}"   # CI: install everything, start nothing

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31m!! %s\033[0m\n' "$1" >&2; exit 1; }

printf '\n\033[1mEarshot\033[0m — ambient conversation dashboard\nInstalling for %s from %s\n' "$USER" "$HUB"
mkdir -p "$ROOT" "$ROOT/models" "$HOME/Library/LaunchAgents"

# ---- 1. Python. uv brings its own, so a clean Mac needs no Xcode tools ----
say "Setting up Python"
UV="$(command -v uv || true)"
if [ -z "$UV" ] && [ -x "$HOME/.local/bin/uv" ]; then UV="$HOME/.local/bin/uv"; fi
if [ -z "$UV" ]; then
  # astral's installer is the same curl|sh trick, so still no quarantine
  curl -fsSL https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || true
  [ -x "$HOME/.local/bin/uv" ] && UV="$HOME/.local/bin/uv"
fi
if [ -n "$UV" ]; then
  # --clear: uv exits 2 rather than reuse an existing venv (e.g. one left by the
  # old packaged app), which used to abort the whole install.
  "$UV" venv --clear --python 3.12 "$VENV" >/dev/null
  PY="$VENV/bin/python"
  PIP_INSTALL=("$UV" pip install --python "$PY" --quiet)
elif /usr/bin/python3 -c "import venv" >/dev/null 2>&1; then
  # fallback: the system python3 (present once Xcode command line tools are)
  [ -d "$VENV" ] || /usr/bin/python3 -m venv "$VENV"
  PY="$VENV/bin/python"
  PIP_INSTALL=("$PY" -m pip install --quiet)
  "$PY" -m pip install --quiet --upgrade pip >/dev/null
else
  die "Could not install Python. Run 'xcode-select --install', then run this again."
fi

# ---- 2. The capture code (public tarball; this is also the update path) ----
say "Downloading Earshot"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$HUB/installer/capture.tgz" -o "$TMP/capture.tgz"
rm -rf "$SRC.new" && mkdir -p "$SRC.new"
tar -xzf "$TMP/capture.tgz" -C "$SRC.new"
[ -f "$SRC.new/main.py" ] || die "The download looks wrong (no main.py). Is $HUB reachable?"
rm -rf "$SRC.old"
[ -d "$SRC" ] && mv "$SRC" "$SRC.old"
mv "$SRC.new" "$SRC"
# the version IS the tarball's hash — how the agent knows it's current
curl -fsSL "$HUB/installer/capture.json" | "$PY" -c \
  'import json,sys;sys.stdout.write(json.load(sys.stdin)["version"])' > "$ROOT/version.txt"
echo "    version $(cut -c1-12 < "$ROOT/version.txt")"

say "Installing dependencies (a minute or two)"
"${PIP_INSTALL[@]}" -r "$SRC/requirements-mac.txt"
# the menu-bar icon is optional: if these don't build, capture still runs
"${PIP_INSTALL[@]}" -r "$SRC/requirements-agent.txt" || echo "    (no menu-bar icon — running headless instead)"

# ---- 3. Pair + permissions, in the foreground while you're watching ----
if [ -z "$DRY" ]; then
  say "Connecting this computer to your dashboard"
  echo "    A browser tab will open — click \"Allow this computer\"."
  ( cd "$SRC" && EARSHOT_HUB="$HUB" EARSHOT_APPDIR="$ROOT" "$PY" tray.py --pair-only )
fi

# ---- 4. Autostart. KeepAlive/SuccessfulExit=false: restart on a crash or a
#         self-update (which exits nonzero), but NOT when you quit on purpose ----
say "Installing the background agent"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.earshot.capture</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string>
    <string>$SRC/tray.py</string>
  </array>
  <!-- the ROOT, never src/: a self-update renames src/, which fails on Windows
       (and is asking for trouble anywhere) if it is the process's CWD -->
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>EARSHOT_HUB</key><string>$HUB</string>
    <key>EARSHOT_APPDIR</key><string>$ROOT</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$ROOT/launchd.log</string>
  <key>StandardErrorPath</key><string>$ROOT/launchd.log</string>
</dict>
</plist>
PLIST

# ---- 5. An `earshot` command, so "restart it" isn't a support call ----
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/earshot" <<CMD
#!/bin/bash
# Earshot agent control (installed by the Earshot installer)
ROOT="$ROOT"
case "\${1:-status}" in
  start)   launchctl load -w "$PLIST" 2>/dev/null; echo "Earshot started." ;;
  stop)    launchctl unload -w "$PLIST" 2>/dev/null; echo "Earshot stopped." ;;
  restart) launchctl unload -w "$PLIST" 2>/dev/null; sleep 1; launchctl load -w "$PLIST"; echo "Earshot restarted." ;;
  log)     tail -f "\$ROOT/capture.log" ;;
  update)  cd "\$ROOT/src" && "$PY" -c 'import updater;print(updater.apply("$HUB") or "already current")' && launchctl kickstart -k gui/\$(id -u)/dev.earshot.capture ;;
  version) cut -c1-12 "\$ROOT/version.txt" 2>/dev/null || echo unknown ;;
  status)  launchctl list | grep -q dev.earshot.capture && echo "running (version \$(cut -c1-12 "\$ROOT/version.txt" 2>/dev/null))" || echo "not running" ;;
  dash)    open "$HUB" ;;
  *)       echo "usage: earshot {start|stop|restart|status|log|update|version|dash}" ;;
esac
CMD
chmod +x "$HOME/.local/bin/earshot"

if [ -z "$DRY" ]; then
  launchctl unload -w "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
fi

cat <<DONE

$(printf '\033[32m✓ Earshot is installed and listening.\033[0m')

  Dashboard   $HUB
  Control     earshot status | earshot log | earshot restart
  Updates     automatic — it picks up new versions from the hub by itself

$(if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
  echo "  (add ~/.local/bin to your PATH to use the 'earshot' command:"
  echo "   echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc)"
fi)
To hear the OTHER side of calls, Earshot needs the BlackHole audio driver — it
offered to install it above. Your microphone works either way.
DONE
