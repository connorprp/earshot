# Earshot on your Mac — setup guide

Total time: ~10 minutes. Nothing to type in a terminal; every step is
double-click or a dialog box.

## 1. Install BlackHole (lets Earshot hear your calls)

1. Open <https://existential.audio/blackhole/> and get **BlackHole 2ch**
   (free — they email you the download link).
2. Double-click the downloaded `.pkg` and click through the installer
   (it will ask for your Mac password once).

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

1. In the folder Connor sent you, double-click **Install Earshot.command**.
   - If macOS complains it's from an unidentified developer: right-click the
     file → **Open** → **Open**.
2. Answer the dialogs (you'll paste in the dashboard address and capture key
   Connor gave you). The install downloads speech models — give it a few
   minutes.

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
