#!/bin/bash
# Earshot capture installer for macOS — double-click to run. (UNTESTED on real
# hardware yet — Connor: verify once on a Mac before handing out.)
# Every question is a GUI dialog; the Terminal window just shows progress.
set -e
cd "$(dirname "$0")"

APP_DIR="$HOME/Library/Application Support/Earshot"
MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx"

say_dialog() { # $1 text, $2 buttons-csv, $3 default button
  osascript -e "display dialog \"$1\" buttons {$2} default button \"$3\" with title \"Earshot Setup\"" 2>/dev/null | sed 's/.*button returned://'
}
ask_text() { # $1 prompt, $2 default
  osascript -e "text returned of (display dialog \"$1\" default answer \"$2\" with title \"Earshot Setup\")"
}

btn=$(say_dialog "Welcome to Earshot!\n\nThis sets up the audio capture agent on this Mac. It takes about five minutes and downloads ~1 GB (speech models).\n\nYou'll need:\n  • the dashboard address (from Connor)\n  • the capture key (from Connor)" '"Cancel","Install"' "Install")
[ "$btn" = "Install" ] || exit 0

# 1. BlackHole (system-audio driver) — GUI .pkg install, we just check for it
if ! ls /Library/Audio/Plug-Ins/HAL/ 2>/dev/null | grep -qi blackhole; then
  btn=$(say_dialog "One thing to install first: BlackHole (free, lets Earshot hear your calls).\n\nClick 'Open Download Page', run the BlackHole 2ch installer, then double-click this installer again." '"Cancel","Open Download Page"' "Open Download Page")
  [ "$btn" = "Open Download Page" ] && open "https://existential.audio/blackhole/"
  exit 0
fi

# 2. Python (macOS ships a stub that offers a GUI install of the real thing)
if ! /usr/bin/python3 -c "import venv" >/dev/null 2>&1; then
  say_dialog "macOS needs to install its developer tools (a one-time Apple download). Click Install in the Apple dialog that appears, then run this installer again." '"OK"' "OK" || true
  /usr/bin/python3 --version >/dev/null 2>&1 || true
  exit 0
fi

echo "==> Copying Earshot into $APP_DIR"
mkdir -p "$APP_DIR"
cp -R ../capture/*.py ../capture/requirements-mac.txt "$APP_DIR/"
mkdir -p "$APP_DIR/models"

echo "==> Creating Python environment (this can take a few minutes)..."
/usr/bin/python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/python" -m pip install --quiet --upgrade pip
"$APP_DIR/venv/bin/python" -m pip install --quiet -r "$APP_DIR/requirements-mac.txt"

if [ ! -f "$APP_DIR/models/nemo_en_titanet_small.onnx" ]; then
  echo "==> Downloading speaker model..."
  curl -sL -o "$APP_DIR/models/nemo_en_titanet_small.onnx" "$MODEL_URL"
fi

# 3. Connection details -> config file
HUB=$(ask_text "Dashboard address (from Connor), e.g. earshot.example.com" "")
KEY=$(ask_text "Capture key (from Connor)" "")
SCHEME="wss"; case "$HUB" in *localhost*|*127.0.0.1*) SCHEME="ws";; esac
cat > "$APP_DIR/config.env" <<EOF
export EARSHOT_WS="$SCHEME://$HUB/ingest"
export EARSHOT_KEY="$KEY"
export EARSHOT_MODEL="small.en"
export EARSHOT_DEVICE="cpu"
EOF

# 4. Desktop launcher (double-click to start capturing)
LAUNCHER="$HOME/Desktop/Earshot Capture.command"
cat > "$LAUNCHER" <<EOF
#!/bin/bash
source "$APP_DIR/config.env"
cd "$APP_DIR"
echo "Earshot capture running — close this window to stop."
exec ./venv/bin/python main.py
EOF
chmod +x "$LAUNCHER"

say_dialog "Done!\n\n1. Double-click 'Earshot Capture' on your Desktop to start listening (allow microphone access when asked).\n\n2. Open your dashboard in the browser and sign in with Google.\n\nOne more one-time step: in Audio MIDI Setup, create a Multi-Output Device (your speakers + BlackHole 2ch) and select it as your sound output — SETUP-MAC.md has pictures-level steps." '"Finish"' "Finish" || true
echo "Install complete."
