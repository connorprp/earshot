# Earshot on your Mac — setup guide

Total time: ~10 minutes. Nothing to type in a terminal; every step is
double-click or a dialog box.

## 1. Install BlackHole (lets Earshot hear your calls)

**Earshot does this for you** — the app (and the script installer) downloads
the driver itself and opens Apple's installer; you click through it and enter
your Mac password once. Don't use existential.audio's download form; it wants
an email address or a Discord join, and the file is the same one.

Doing it by hand instead: `brew install blackhole-2ch`, or run
`python3 capture/mac_blackhole.py` from the capture folder.

Skipping this step is allowed — your microphone still records, you just won't
capture the other side of calls.

## 2. Route your sound through it (one-time)

Your Mac will play audio to BOTH your speakers/headphones and Earshot:

1. Open **Audio MIDI Setup** (press ⌘-Space, type "Audio MIDI", press Enter).
2. Click the **+** in the bottom-left corner → **Create Multi-Output Device**.
3. In the right panel, tick **two** boxes: your normal output (e.g. "MacBook
   Pro Speakers" or your headphones) **and** "BlackHole 2ch".
4. Right-click the new Multi-Output Device → **Use This Device For Sound
   Output**.

(Volume keys don't work while a Multi-Output Device is selected — set your
volume before, or switch output back when you're not using Earshot.)

## 3. Install Earshot

1. Open the dashboard in your browser, sign in with Google, click the gear (⚙),
   and download **your** Mac installer — it already knows your account.
2. Double-click the downloaded `Install Earshot.command`.
   - If macOS complains it is from an unidentified developer: right-click the
     file → **Open** → **Open**.
3. It installs everything with no questions (if the BlackHole step from part 1
   was skipped, it downloads that installer for you and asks you to re-run).

## 4. Use it

- Double-click **Earshot Capture** on your Desktop to start listening.
  The first time, macOS asks for **microphone access** — click Allow.
  Leave the little window open; closing it stops listening.
- Open the dashboard link in your browser and **sign in with Google**.
- Press **Record** when a conversation starts, **Stop** when it ends —
  you'll get live concept bubbles, action buttons, and a session report.

## Troubleshooting

- **Dashboard says "connecting…" forever** → the capture window isn't
  running, or the capture key is wrong (re-run the installer to re-enter it).
- **No "Them" lines while on a call** → your sound output isn't the
  Multi-Output Device (step 2.4), or the app (Zoom/Teams) has its own output
  device selected in its audio settings — set it to the Multi-Output Device.
- **Your own voice shows as garbled duplicates** → you're on open speakers;
  it should settle within the first minute (echo protection warms up), or
  wear headphones.
