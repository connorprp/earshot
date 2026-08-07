"""BlackHole (macOS system-audio driver) without the donation wall.

existential.audio only hands out the installer behind an email/donate form,
and the GitHub repo ships SOURCE ONLY — there has never been a .pkg asset on
a release (checked every release back to v0.4.0), which is why the old
installer's "grab the latest release asset" grep silently produced an empty
URL and killed the install at step 1.

The pkg itself is public at a direct URL — the same one Homebrew's
blackhole-2ch cask downloads — so we fetch that and verify it against the
hash Homebrew pins. Pinned, not "latest": an unpinned download we hand to
Apple's Installer is a supply-chain hole, and a version bump here is a
one-line change with a hash to match.

    python capture/mac_blackhole.py          # install it if missing
    python capture/mac_blackhole.py --check  # exit 0 if present

This is a stopgap. The real fix is CoreAudio process taps (macOS 14.4+),
which need no driver at all — see SETUP-MAC.md.
"""
import hashlib
import os
import subprocess
import sys
import tempfile
import urllib.request

HAL_DIR = "/Library/Audio/Plug-Ins/HAL"
PKG_URL = "https://existential.audio/downloads/BlackHole2ch-0.7.1.pkg"
PKG_SHA256 = "57b540f27a3e29c37e310e01bee0fdfab76733087e47f997ef9dccf851400dcf"
SITE_URL = "https://existential.audio/blackhole/"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Earshot"


def installed():
    """True if the 2ch driver is present (any BlackHole variant counts —
    mac_audio.py matches on the device name the same loose way)."""
    try:
        return any("blackhole" in n.lower() for n in os.listdir(HAL_DIR))
    except OSError:
        return False


def fetch(dest=None):
    """Download the pkg and verify it. Returns the path; raises on mismatch."""
    dest = dest or os.path.join(tempfile.mkdtemp(prefix="earshot-bh-"), "BlackHole2ch.pkg")
    # their host 406s urllib's default User-Agent — send a browser-ish one
    req = urllib.request.Request(PKG_URL, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        while chunk := r.read(64 * 1024):
            f.write(chunk)
    got = hashlib.sha256(open(dest, "rb").read()).hexdigest()
    if got != PKG_SHA256:
        os.unlink(dest)
        raise ValueError(f"BlackHole pkg hash mismatch: {got} != {PKG_SHA256}")
    return dest


def dialog(text, title="Earshot Setup"):
    """Best-effort GUI message — a --windowed app has no terminal to print to."""
    try:
        subprocess.run(
            ["osascript", "-e", f'display dialog "{text}" buttons {{"OK"}} '
             f'default button "OK" with title "{title}"'],
            capture_output=True, timeout=600,
        )
    except Exception as e:  # noqa: BLE001 — a missing dialog must never block capture
        print(f"[blackhole] dialog failed: {e}")


def offer_install():
    """If BlackHole is missing, download + verify it and open Apple's installer
    (which asks for the user's password — nothing is installed behind their
    back). Returns True if the driver is already there, False if we just
    handed the user an installer to click through."""
    if installed():
        return True
    print("[blackhole] not installed — fetching the driver")
    try:
        pkg = fetch()
    except Exception as e:  # noqa: BLE001 — mic-only capture still works
        print(f"[blackhole] download failed: {e}")
        dialog("Earshot could not download the audio driver it needs to hear "
               "the other side of your calls.\n\nYour microphone still works. "
               f"To fix it later, install BlackHole 2ch from {SITE_URL}")
        return False
    subprocess.run(["open", pkg], capture_output=True)
    dialog("Earshot needs one small audio driver to hear the OTHER side of "
           "your calls (your microphone already works without it).\n\n"
           "Click through the BlackHole installer that just opened — it asks "
           "for your Mac password once — then start Earshot again.")
    return False


if __name__ == "__main__":
    if sys.platform != "darwin":
        print("macOS only")
        sys.exit(0)
    if "--check" in sys.argv:
        print("installed" if installed() else "missing")
        sys.exit(0 if installed() else 1)
    sys.exit(0 if offer_install() else 1)
