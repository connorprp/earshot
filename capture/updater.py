"""Self-update for the SOURCE install (the `curl | bash` path).

The packaged .exe/.app can't sanely update itself — swapping a 107MB bundle in
place is a different problem, and since macOS Tahoe an unsigned bundle that
arrived through a browser can't be launched at all (Gatekeeper offers only
"Move to Trash"). The source install has neither problem: the hub already
serves the capture code as a public tarball (GET /installer/capture.tgz), so
"push an update to my friends" is a download, an atomic directory swap, and a
re-exec. `git push rusty main` reaches every agent on its next connect.

Layout under the app-data root (shared with tray.py's config + models):
    src/          the code that is running (an extracted tarball)
    src.new/      staging — only ever swapped in whole, never merged
    src.old/      the previous version, kept so a bad push is one mv away
    version.txt   sha256 of the tarball that produced src/

The version IS the tarball's sha256, which the hub reports at
/installer/capture.json. That makes "am I current?" a string compare with no
version numbers to bump, and it doubles as an integrity check on the download.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

# Mirrors tray.app_dir() / main._tasks_root(): the per-user app-data root.
# Duplicated deliberately — this module is imported by both main.py and
# tray.py, and importing either from here would be circular.
def app_root() -> Path:
    if os.environ.get("EARSHOT_APPDIR"):  # a second install on the same machine
        return Path(os.environ["EARSHOT_APPDIR"])
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "Earshot"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Earshot"
    return Path.home() / ".local" / "share" / "earshot"


def src_dir(root: Path | None = None) -> Path:
    return (root or app_root()) / "src"


# ---- device identity ----
# Lives here because both main.py and tray.py need it and neither can import the
# other. An account can have several machines (a desktop that is always on and a
# laptop you actually sit at); without an id the hub could only ever route work
# to "whichever agent connected first", which sent tasks to the wrong computer.
def device_name() -> str:
    import socket
    return (socket.gethostname() or "").split(".")[0] or "this computer"


def device_id(root: Path | None = None) -> str:
    """Stable per install: survives self-updates, re-pairing and restarts."""
    path = (root or app_root()) / "device.json"
    try:
        got = json.loads(path.read_text(encoding="utf-8")).get("deviceId")
        if got:
            return str(got)
    except (OSError, ValueError):
        pass
    import uuid
    made = uuid.uuid4().hex[:16]
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"deviceId": made, "name": device_name()}), encoding="utf-8")
    except OSError as e:
        print(f"[device] could not persist an id ({e}) — using a temporary one")
    return made


def is_source_install(root: Path | None = None) -> bool:
    """True when this process is running from a self-updatable source tree.
    A frozen bundle updates by being re-downloaded, so it must never try."""
    if getattr(sys, "frozen", False):
        return False
    try:
        return Path(sys.argv[0]).resolve().parent == src_dir(root).resolve()
    except OSError:
        return False


def version_path(root: Path | None = None) -> Path:
    return (root or app_root()) / "version.txt"


def current_version(root: Path | None = None) -> str:
    try:
        return version_path(root).read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _fetch(url: str, timeout: int = 60) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return r.read()


def remote_version(hub_http: str) -> str:
    """What the hub is serving right now (sha256 of its capture bundle)."""
    return str(json.loads(_fetch(f"{hub_http}/installer/capture.json", 20)).get("version") or "")


def _safe_extract(tar_bytes: bytes, dest: Path):
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(tar_bytes)) as tf:
        for m in tf.getmembers():
            # the hub writes a flat archive of known filenames; anything with a
            # path in it is not something we asked for
            if m.name != os.path.basename(m.name) or not m.isfile():
                raise ValueError(f"unexpected member in capture bundle: {m.name}")
        try:
            tf.extractall(dest, filter="data")  # py3.12+
        except TypeError:
            tf.extractall(dest)


def apply(hub_http: str, root: Path | None = None) -> str | None:
    """Download and swap in the hub's current code. Returns the new version, or
    None when already current. Raises on a failed download/extract, having
    changed nothing — src/ is only replaced once src.new/ is known good."""
    root = root or app_root()
    # Only ever REPLACE a source tree, never create one. The installer lays down
    # src/ itself; without this guard, running the updater against a directory
    # that belongs to the packaged app (or an older script install, which put its
    # code at the root) would grow a phantom src/ and a version.txt that then
    # makes a future real install look already-current. Found the hard way.
    if not (src_dir(root) / "main.py").is_file():
        raise FileNotFoundError(f"no source install at {src_dir(root)} — nothing to update")
    want = remote_version(hub_http)
    if not want or want == current_version(root):
        return None
    blob = _fetch(f"{hub_http}/installer/capture.tgz", 120)
    got = hashlib.sha256(blob).hexdigest()
    if got != want:
        raise ValueError(f"capture bundle sha mismatch (hub said {want[:12]}, got {got[:12]})")
    staging = root / "src.new"
    shutil.rmtree(staging, ignore_errors=True)
    _safe_extract(blob, staging)
    if not (staging / "main.py").is_file():
        raise ValueError("capture bundle has no main.py — refusing to swap it in")
    live, previous = src_dir(root), root / "src.old"
    shutil.rmtree(previous, ignore_errors=True)
    # Windows refuses to rename a directory that any process has as its CWD —
    # and the agent runs FROM src, so the swap failed with WinError 32 until
    # this step. Imported modules live in memory, so stepping out of the tree is
    # enough; sys.path still points at the script's own directory.
    try:
        os.chdir(root)
    except OSError:
        pass
    if live.exists():
        os.replace(live, previous)
    os.replace(staging, live)
    version_path(root).write_text(want, encoding="utf-8")
    print(f"[update] installed {want[:12]} (previous kept in {previous})")
    return want


def restart():
    """Re-exec this agent so the new code takes over.

    POSIX: execv keeps the pid, so launchd's KeepAlive doesn't even notice.
    Windows: os.execv is spawn-then-exit, which races the single-instance
    guard — EARSHOT_RESTART tells the new process to wait for the lock instead
    of exiting as a duplicate.
    """
    script = str(src_dir() / Path(sys.argv[0]).name)
    args = [sys.executable, script, *sys.argv[1:]]
    os.environ["EARSHOT_RESTART"] = "1"
    print(f"[update] restarting: {' '.join(args)}")
    sys.stdout.flush()
    if sys.platform == "win32":
        import subprocess
        # A detached child inherits no usable stdio, so point it at the log file
        # the troubleshooting advice tells people to read — otherwise everything
        # an agent says AFTER its first self-update disappears.
        log = open(app_root() / "capture.log", "a", buffering=1, encoding="utf-8", errors="replace")
        subprocess.Popen(
            args, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
            close_fds=True, creationflags=0x00000008,  # DETACHED_PROCESS
        )
        time.sleep(0.2)
        os._exit(0)
    os.execv(sys.executable, args)  # POSIX: same pid, keeps launchd's log paths


def check_at_startup(hub_http: str) -> str | None:
    """Update before the pipeline starts, where no restart is needed at all.
    Never fatal: an agent that can't reach the hub still has working code."""
    if not is_source_install():
        return None
    try:
        return apply(hub_http)
    except Exception as e:  # noqa: BLE001 — a failed update must not stop capture
        print(f"[update] skipped: {e}")
        return None


_LAST_UPDATE_AT = 0.0


def update_and_restart(hub_http: str, release_lock=None) -> bool:
    """The live path: the hub said there's new code while we're running.
    Cooldown-guarded so a version that keeps mismatching (a bad push, a stale
    cache) can't turn into a restart loop."""
    global _LAST_UPDATE_AT
    if not is_source_install() or time.time() - _LAST_UPDATE_AT < 120:
        return False
    _LAST_UPDATE_AT = time.time()
    try:
        if not apply(hub_http):
            return False
    except Exception as e:  # noqa: BLE001
        print(f"[update] failed, staying on {current_version()[:12] or 'unknown'}: {e}")
        return False
    if release_lock:
        release_lock()  # so the successor can take the single-instance lock
    restart()
    return True
