# Earshot on Windows — setup guide

Total time: ~5 minutes. One line to paste, then one button to click.

## 1. Paste one line into PowerShell

Press **Win**, type "powershell", open it, and paste:

```powershell
irm https://earshot.rustycloud.dev/install/windows | iex
```

That's the install. It sets up a private Python environment, downloads the
capture agent, and starts it — including on every login from then on.

> **Why a terminal instead of the .exe?** A downloaded executable is marked by
> Windows as coming from the internet, so unsigned ones get "Windows protected
> your PC" and you have to dig for **More info → Run anyway**. A script piped
> into `iex` is never a file, so nothing marks it and no dialog appears. (Proper
> code signing is ~$10/month, if it ever matters enough.)

## 2. Click "Allow this computer"

A browser tab opens on the dashboard. Sign in with your Google account if it
asks, then click **Allow this computer**. That's how the agent learns which
account it belongs to — no keys to copy.

## 3. That's it

Windows doesn't prompt for microphone access per-app, but if Earshot hears
nothing, check **Settings → Privacy & security → Microphone** and make sure
"Let desktop apps access your microphone" is on.

Windows captures the other side of calls with no extra driver — Earshot taps
every playback device directly (which is why it hears Teams even when Teams uses
a different headset than your system default).

## Using it

Open **https://earshot.rustycloud.dev**, press **Record**, and talk. Concepts
appear as cards within ~20 seconds, each with buttons and a `✦ Ask Claude`
button you can tell anything ("them-2 is Dave", "split this card", "draft the
follow-up email").

## The `earshot` command

```
earshot status     is it running
earshot log        watch what it's doing (Ctrl-C to stop watching)
earshot restart    after changing audio devices
earshot stop       stop listening entirely
earshot update     pull the latest version right now
earshot dash       open the dashboard
```

It lives in `%USERPROFILE%\.local\bin`; add that folder to your PATH once if
Windows says the command isn't recognized.

## Updates

Automatic. The agent checks with the server whenever it connects and updates
itself if there's new code — no re-downloading, no reinstalling.

## Uninstalling

```powershell
taskkill /f /im pythonw.exe
Remove-Item "$([Environment]::GetFolderPath('Startup'))\Earshot.lnk"
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Earshot"
Remove-Item "$env:USERPROFILE\.local\bin\earshot.cmd"
```

## If something's wrong

- **Nothing appears on the dashboard.** `earshot status`; if it's not running,
  `earshot start`. If it is, `earshot log` and look for `[ws] connected`.
- **"no capture agent" in the topbar.** `earshot restart`, then reload the page.
- **Anything else:** send Connor the last 30 lines of
  `%LOCALAPPDATA%\Earshot\capture.log`.

---

### Other ways to install (kept, but not recommended)

The **packaged app** (`app (Windows)` in Settings ⚙ → other ways to install) is
double-clickable but unsigned: expect one SmartScreen "More info → Run anyway".
The **personalized script installer** (`Install Earshot.bat`) is the older path —
it bakes your capture key in instead of pairing, installs Python via winget, and
creates a Desktop launcher rather than a self-updating background agent.
