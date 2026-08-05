#!/bin/bash
# Personalized Earshot installer — served by the hub with this user's server
# address and capture key already substituted in. Double-click (first time:
# right-click → Open) and everything happens.
set -e
APP_DIR="${EARSHOT_APPDIR:-$HOME/Library/Application Support/Earshot}"

note() { echo; echo "==> $1"; }

echo "=== Earshot setup ==="

# 1. BlackHole (lets Earshot hear your calls) — auto-download, Apple's
#    installer GUI opens; user clicks through it once, then re-runs this file.
if ! ls /Library/Audio/Plug-Ins/HAL/ 2>/dev/null | grep -qi blackhole; then
  note "One-time step: installing the BlackHole audio driver."
  PKG_URL=$(curl -s https://api.github.com/repos/ExistentialAudio/BlackHole/releases/latest \
    | grep -o 'https://[^"]*BlackHole2ch[^"]*\.pkg' | head -1)
  curl -sL -o /tmp/BlackHole2ch.pkg "$PKG_URL"
  open /tmp/BlackHole2ch.pkg
  osascript -e 'display dialog "Click through the BlackHole installer that just opened (it asks for your Mac password once).\n\nWhen it finishes, double-click the Earshot installer again to continue." buttons {"OK"} default button "OK" with title "Earshot Setup"' >/dev/null || true
  exit 0
fi

# 2. Python (macOS offers a GUI install of its developer tools if missing)
if ! /usr/bin/python3 -c "import venv" >/dev/null 2>&1; then
  note "macOS needs its developer tools (one-time Apple download)."
  osascript -e 'display dialog "Click Install in the Apple dialog that appears, then double-click the Earshot installer again." buttons {"OK"} default button "OK" with title "Earshot Setup"' >/dev/null || true
  /usr/bin/python3 --version >/dev/null 2>&1 || true
  exit 0
fi

note "Downloading Earshot capture agent..."
mkdir -p "$APP_DIR/models"
cd "$APP_DIR"
curl -sL -o capture.tgz "{{HTTP_URL}}/installer/capture.tgz"
tar -xzf capture.tgz && rm capture.tgz

note "Setting up the speech engine (a few minutes)..."
[ -d venv ] || /usr/bin/python3 -m venv venv
./venv/bin/python -m pip install --quiet --upgrade pip
./venv/bin/python -m pip install --quiet -r requirements-mac.txt

if [ ! -f models/nemo_en_titanet_small.onnx ]; then
  note "Downloading voice model..."
  curl -sL -o models/nemo_en_titanet_small.onnx \
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx"
fi

cat > cloud.env <<EOF
EARSHOT_WS={{WS_URL}}
EARSHOT_KEY={{CAPTURE_KEY}}
EARSHOT_MODEL=small.en
EARSHOT_DEVICE=cpu
EOF

LAUNCHER="$HOME/Desktop/Earshot Capture.command"
cat > "$LAUNCHER" <<EOF
#!/bin/bash
cd "$APP_DIR"
echo "Earshot is listening — close this window to stop."
exec ./venv/bin/python main.py --env-file cloud.env
EOF
chmod +x "$LAUNCHER"

# 3. Route sound through BlackHole: open the right tool + short instructions
open -a "Audio MIDI Setup" || true
osascript -e 'display dialog "Done! One last one-time step in the window that just opened (Audio MIDI Setup):\n\n1. Click + (bottom-left) → Create Multi-Output Device\n2. Tick your speakers AND BlackHole 2ch\n3. Right-click it → Use This Device For Sound Output\n\nThen double-click \"Earshot Capture\" on your Desktop and allow microphone access." buttons {"OK"} default button "OK" with title "Earshot Setup"' >/dev/null || true

note "Starting Earshot..."
open "$LAUNCHER"
