# Earshot on your Mac — setup guide

Total time: ~5 minutes. One line to paste, then two dialogs to click.

## 1. Paste one line into Terminal

Open **Terminal** (⌘-Space, type "terminal") and paste:

```bash
curl -fsSL https://earshot.rustycloud.dev/install/mac | bash
```

That's the install. It sets up a private Python environment, downloads the
capture agent, and starts it in the background — including on every login from
then on.

> **Why a terminal instead of an app to double-click?** macOS blocks apps that
> aren't signed by a paid Apple developer account, and since macOS Tahoe there's
> no way around it: a downloaded unsigned app gets a dialog whose only option is
> "Move to Trash". A script piped into `bash` is never quarantined, so this path
> has no security prompts at all. (A signed, double-clickable app is a $99/year
> purchase away, if it ever matters enough.)

## 2. Click "Allow this computer"

A browser tab opens on the dashboard. Sign in with your Google account if it
asks, then click **Allow this computer**. That's how the agent learns which
account it belongs to — no keys to copy.

## 3. Allow the microphone

macOS asks once. Say yes. (If you miss it: **System Settings → Privacy &
Security → Microphone**, then run `earshot restart`.)

## 4. Optional: hear the other side of calls

To capture what the *other* people on a call say, macOS needs a virtual audio
driver called **BlackHole**. The installer offers to install it for you — click
through Apple's installer and enter your Mac password once.

Then route your sound through it, one time:

1. Open **Audio MIDI Setup** (the installer opens it for you)
2. Click **+** (bottom-left) → **Create Multi-Output Device**
3. Tick **both** your speakers/headphones **and BlackHole 2ch**
4. Right-click the new device → **Use This Device For Sound Output**

Skipping this is fine — your microphone still records, you just won't capture
the far end of calls.

## Using it

Open **https://earshot.rustycloud.dev**, press **Record**, and talk. Concepts
appear as cards within ~20 seconds, each with buttons and a `✦ Ask Claude`
button you can tell anything ("them-2 is Dave", "split this card", "draft the
follow-up email").

## The `earshot` command

```
earshot status     is it running, and what version
earshot log        watch what it's doing (Ctrl-C to stop watching)
earshot restart    after changing audio devices or permissions
earshot stop       stop listening entirely
earshot update     pull the latest version right now
earshot dash       open the dashboard
```

If your shell says `command not found`, add it to your PATH once:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
```

## Updates

Automatic. The agent checks with the server whenever it connects, and updates
itself if there's new code — no re-downloading, no reinstalling. `earshot
version` tells you what you're on.

## Uninstalling

```bash
launchctl unload -w ~/Library/LaunchAgents/dev.earshot.capture.plist
rm ~/Library/LaunchAgents/dev.earshot.capture.plist
rm -rf ~/Library/Application\ Support/Earshot ~/.local/bin/earshot
```

BlackHole, if you installed it, is separate: `brew uninstall blackhole-2ch`, or
delete `/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver` and reboot.

## If something's wrong

- **Nothing appears on the dashboard.** `earshot status` — if it's not running,
  `earshot start`. If it is, `earshot log` and look for `[ws] connected`.
- **It hears you but not the call.** BlackHole isn't installed or isn't in your
  output device — redo step 4.
- **"no capture agent" in the dashboard topbar.** The agent isn't connected;
  `earshot restart`, then reload the page.
- **Anything else:** send Connor the last 30 lines of
  `~/Library/Application Support/Earshot/capture.log`.

---

### Other ways to install (kept, but not recommended)

The **packaged app** (`Earshot for Mac` in Settings ⚙ → other ways to install)
is double-clickable but unsigned, so macOS Tahoe refuses to open it after a
browser download. It only works if you already have it installed from an earlier
version, or if you clear the quarantine flag yourself:

```bash
xattr -dr com.apple.quarantine "/Applications/Earshot Capture.app"
```

The **personalized script installer** (same menu) is the older path: download
`Install Earshot.command`, then — because a *downloaded* script is quarantined
too — run it through bash rather than double-clicking:

```bash
bash ~/Downloads/"Install Earshot.command"
```

It bakes your capture key in instead of pairing, and it installs a Desktop
launcher rather than a background agent that updates itself.
