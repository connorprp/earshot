#!/bin/bash
# Optional, for later: mints a Claude Code token from THIS Mac's Claude
# subscription so Connor can point your Earshot at your own account.
# Double-click; a browser window opens to approve; the token prints here —
# send it to Connor (it's like a password: send it privately).
set -e
osascript -e 'display dialog "This connects your Claude subscription to Earshot.\n\nA browser window will open — sign in to Claude and approve. Then copy the token from this window and send it to Connor privately." buttons {"Cancel","Continue"} default button "Continue" with title "Connect Claude"' >/dev/null

if ! command -v npx >/dev/null 2>&1; then
  osascript -e 'display dialog "This one needs Node.js first — click OK to open the installer page, run the .pkg, then double-click this again." buttons {"OK"} default button "OK" with title "Connect Claude"' >/dev/null
  open "https://nodejs.org/en/download"
  exit 0
fi

echo "Opening Claude authorization..."
npx -y @anthropic-ai/claude-code setup-token
echo
echo "Copy the token above (starts with sk-ant-oat) and send it to Connor privately."
read -r -p "Press Enter to close."
