"""Earshot Capture — the packaged desktop app entry point.

What a non-technical user experiences: install the app, open it, the browser
opens with one "Allow this computer" button, done. A tray / menu-bar icon
shows it's listening (green) or paused (grey). No terminal, no keys, no config.

Under the hood, first run does device pairing against the hub:
  1. generate a code, POST {hub}/pair/start
  2. open {hub}/?pair=CODE in the browser (user is signed in via Google there)
  3. poll GET {hub}/pair/claim?code= until approved -> receive capture key +
     ws url, saved to the platform app-data dir
then the speaker model is downloaded (once) and the normal capture pipeline
from main.py runs in background threads.

Env overrides: EARSHOT_HUB (hub base url), EARSHOT_SMOKE=1 (CI: init + exit).
"""
import json
import os
import secrets
import socket
import string
import sys
import threading
import time
import urllib.request
import webbrowser

DEFAULT_HUB = os.environ.get("EARSHOT_HUB", "https://earshot.rustycloud.dev")
SPEAKER_MODEL_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-recongition-models/nemo_en_titanet_small.onnx"
)


def app_dir():
    # EARSHOT_APPDIR lets one machine hold more than one install (a test agent
    # against a local hub next to the real one) — each keeps its own config,
    # models, source tree and single-instance lock
    if os.environ.get("EARSHOT_APPDIR"):
        return os.environ["EARSHOT_APPDIR"]
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA", os.path.expanduser("~"))
        return os.path.join(base, "Earshot")
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/Earshot")
    return os.path.expanduser("~/.local/share/earshot")


CONFIG_PATH = os.path.join(app_dir(), "config.json")
LOG_PATH = os.path.join(app_dir(), "capture.log")


def setup_logging():
    """A --windowed PyInstaller app has sys.stdout/stderr = None: every print
    vanishes and libraries that write to stderr (tqdm progress bars during
    model downloads) crash their thread. Route both to a log file instead."""
    if not (getattr(sys, "frozen", False) or sys.stdout is None):
        return  # dev run in a terminal — leave prints alone
    os.makedirs(app_dir(), exist_ok=True)
    try:
        if os.path.getsize(LOG_PATH) > 512 * 1024:
            os.replace(LOG_PATH, LOG_PATH + ".1")
    except OSError:
        pass
    log = open(LOG_PATH, "a", buffering=1, encoding="utf-8", errors="replace")
    sys.stdout = sys.stderr = log
    print(f"[app] --- started {time.strftime('%Y-%m-%d %H:%M:%S')} pid={os.getpid()} frozen={getattr(sys, 'frozen', False)} ---")


def load_config():
    try:
        with open(CONFIG_PATH) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def save_config(cfg):
    os.makedirs(app_dir(), exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=1)


def http_json(url, payload=None):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={"content-type": "application/json"} if payload is not None else {},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


_INSTANCE_LOCK = None  # kept alive for the process lifetime; the OS frees it on exit
_INSTANCE_MUTEX = None  # Windows named mutex handle, released before a self-update restart


def release_instance_lock():
    """Hand the single-instance lock to our successor. Only used when this
    process is about to re-exec itself after a self-update — on Windows that is
    spawn-then-exit, so without this the new copy would see the old one's lock
    and exit as a duplicate."""
    global _INSTANCE_LOCK, _INSTANCE_MUTEX
    try:
        if _INSTANCE_LOCK:
            _INSTANCE_LOCK.close()
    except OSError:
        pass
    _INSTANCE_LOCK = None
    if _INSTANCE_MUTEX and sys.platform == "win32":
        import ctypes
        ctypes.WinDLL("kernel32").CloseHandle(_INSTANCE_MUTEX)
    _INSTANCE_MUTEX = None


def already_running():
    """Single-instance guard: a second copy would open the SAME microphone and
    send every utterance twice (the hub mutes duplicates now, but the machine
    still pays the CPU and the user still sees two tray icons).

    Two layers, because neither covers everything: a named mutex on Windows
    (immune to a lock file left behind by a hard kill) and an exclusive lock
    file everywhere — which is the only guard that works on macOS, where this
    used to return False and happily start a second capture pipeline.
    """
    # A self-update restart briefly overlaps the process it replaces (on
    # Windows os.execv is spawn-then-exit), so the successor waits for the lock
    # instead of reporting itself a duplicate and dying.
    tries, wait = (12, 0.5) if os.environ.get("EARSHOT_RESTART") == "1" else (1, 0)
    for attempt in range(tries):
        if _take_lock():
            return False  # we own it: nothing else is running
        if attempt + 1 < tries:
            print("[app] waiting for the previous version to exit...")
            time.sleep(wait)
    return True


def _take_lock():
    """True when this process now owns the lock, False when someone else does."""
    global _INSTANCE_LOCK, _INSTANCE_MUTEX
    if sys.platform == "win32":
        # ctypes.windll does NOT preserve the Win32 last-error across the call;
        # use_last_error + get_last_error() is the documented way to read it
        import ctypes
        import hashlib
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # scoped to this install's directory, so a test agent in its own
        # EARSHOT_APPDIR doesn't read as a duplicate of the real one
        tag = hashlib.sha256(app_dir().encode()).hexdigest()[:8]
        handle = k32.CreateMutexW(None, False, f"EarshotCaptureSingleton-{tag}")
        if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
            if handle:
                k32.CloseHandle(handle)
            return False  # another instance holds the mutex
        _INSTANCE_MUTEX = handle
    try:
        os.makedirs(app_dir(), exist_ok=True)
        _INSTANCE_LOCK = open(os.path.join(app_dir(), "instance.lock"), "a+")
        _INSTANCE_LOCK.seek(0)
        if sys.platform == "win32":
            import msvcrt
            msvcrt.locking(_INSTANCE_LOCK.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(_INSTANCE_LOCK, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return False  # someone else holds the lock file
    try:
        _INSTANCE_LOCK.write(f"\n{os.getpid()}")
        _INSTANCE_LOCK.flush()
    except OSError:
        pass
    return True


def register_protocol():
    """Register earshot:// (HKCU, no admin) pointing at this binary so the
    dashboard's "Start the Earshot app" button can launch it from the browser."""
    if sys.platform != "win32" or not getattr(sys, "frozen", False):
        return
    try:
        import winreg
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r"Software\Classes\earshot") as k:
            winreg.SetValueEx(k, None, 0, winreg.REG_SZ, "URL:Earshot Capture")
            winreg.SetValueEx(k, "URL Protocol", 0, winreg.REG_SZ, "")
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, r"Software\Classes\earshot\shell\open\command") as k:
            winreg.SetValueEx(k, None, 0, winreg.REG_SZ, f'"{sys.executable}" "%1"')
    except OSError as e:
        print(f"[app] earshot:// registration failed: {e}")


def pair():
    """Device pairing: returns {wsUrl, captureKey} once the user approves.

    The deviceId rides along because the browser that approves this is, by
    construction, running ON this machine — so the dashboard can remember which
    computer it belongs to and route work here instead of to whichever agent
    happened to connect first.
    """
    import updater
    code = "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(8))
    http_json(
        f"{DEFAULT_HUB}/pair/start",
        {
            "code": code,
            "host": updater.device_name(),
            "deviceId": updater.device_id(),
            "platform": "mac" if sys.platform == "darwin" else ("windows" if sys.platform == "win32" else "linux"),
        },
    )
    webbrowser.open(f"{DEFAULT_HUB}/?pair={code}")
    deadline = time.time() + 10 * 60
    while time.time() < deadline:
        time.sleep(2)
        try:
            r = http_json(f"{DEFAULT_HUB}/pair/claim?code={code}")
        except OSError:
            continue
        if r.get("status") == "approved":
            return {"wsUrl": r["wsUrl"], "captureKey": r["captureKey"], "hub": DEFAULT_HUB}
    raise TimeoutError("pairing was not approved within 10 minutes")


def ensure_speaker_model():
    path = os.path.join(app_dir(), "models", "nemo_en_titanet_small.onnx")
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        print("[app] downloading voice model...")
        urllib.request.urlretrieve(SPEAKER_MODEL_URL, path)
    os.environ["EARSHOT_SPEAKER_MODEL"] = path
    return path


def start_pipeline(cfg):
    """Configure env, then import main (it reads env at import) and start its threads."""
    os.environ["EARSHOT_WS"] = cfg["wsUrl"]
    os.environ["EARSHOT_KEY"] = cfg["captureKey"]
    os.environ.setdefault("EARSHOT_MODEL", "small.en")
    os.environ.setdefault("EARSHOT_DEVICE", "cpu")
    ensure_speaker_model()

    import main  # noqa: PLC0415 — must come after env is set

    threading.Thread(target=main.asr_worker, daemon=True).start()
    threading.Thread(target=main.ws_sender, daemon=True).start()
    # main.main() starts these; this path builds its threads by hand and used to
    # skip them, so the packaged app reported NO connected apps (which steers
    # both the distill's action buttons and each task's tool allowlist) and never
    # noticed a Claude CLI installed after launch
    threading.Thread(target=main._probe_connectors, daemon=True).start()
    if not main._find_claude():
        threading.Thread(target=main._watch_for_claude, daemon=True).start()
    if sys.platform == "darwin":
        import mac_audio
        streams = mac_audio.start_streams(main.Segmenter)  # noqa: F841
    else:
        main.start_audio()  # supervised: dead streams (sleep, device change) get reopened
    return main


def pair_only():
    """`tray.py --pair-only`: everything interactive, then exit.

    The piped installer (mac/install.sh, windows/install.ps1) runs this in the
    FOREGROUND while the user is still looking at their terminal, so pairing,
    the BlackHole offer, the voice-model download and — the reason this exists —
    the microphone permission prompt all happen where they can see and answer
    them. The background agent it installs afterwards then starts silently.
    """
    cfg = load_config()
    if not cfg or not cfg.get("captureKey"):
        print("[setup] opening your browser to pair this computer...")
        cfg = pair()
        save_config(cfg)
        print("[setup] paired.")
    else:
        print("[setup] this computer is already paired.")
    if sys.platform == "darwin" and not cfg.get("blackholePrompted"):
        try:
            import mac_blackhole
            if not mac_blackhole.offer_install():
                cfg["blackholePrompted"] = True
                save_config(cfg)
        except Exception as e:  # noqa: BLE001
            print(f"[setup] blackhole step skipped: {e}")
    ensure_speaker_model()
    _prompt_for_microphone()
    print("[setup] done.")


def _prompt_for_microphone():
    """Open the mic for a moment so the OS permission dialog appears NOW.

    Otherwise the first prompt arrives from a background LaunchAgent, where a
    user who misses it (or never sees it) gets an agent that looks connected and
    captures silence.
    """
    if sys.platform != "darwin":
        return  # Windows has no per-app prompt; its mic switch is a global setting
    try:
        import sounddevice as sd
        with sd.InputStream(channels=1, samplerate=16000):
            time.sleep(1.5)
        print("[setup] microphone access confirmed.")
    except Exception as e:  # noqa: BLE001 — a refusal here is still a working install
        print(f"[setup] microphone not available yet ({e}).")
        print("[setup] allow it under System Settings > Privacy & Security > Microphone, then run: earshot restart")


def run_tray(main_mod, cfg):
    # A source install (curl|bash) may not have pystray/Pillow — the menu bar
    # icon is a nicety, capturing is the job. Block forever instead.
    try:
        import pystray  # noqa: PLC0415
        from PIL import Image, ImageDraw  # noqa: PLC0415
    except ImportError as e:
        print(f"[app] no tray icon ({e}) — running headless")
        threading.Event().wait()
        return

    def dot(color):
        img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.ellipse([12, 12, 52, 52], fill=color)
        return img

    listening_icon = dot((63, 185, 80, 255))
    paused_icon = dot((139, 152, 169, 255))

    def toggle_pause(icon, item):
        if main_mod.PAUSED.is_set():
            main_mod.PAUSED.clear()
        else:
            main_mod.PAUSED.set()
        icon.icon = paused_icon if main_mod.PAUSED.is_set() else listening_icon
        icon.update_menu()

    def open_dashboard(icon, item):
        webbrowser.open(cfg.get("hub", DEFAULT_HUB))

    def quit_app(icon, item):
        icon.stop()
        os._exit(0)

    icon = pystray.Icon(
        "earshot",
        listening_icon,
        "Earshot Capture",
        menu=pystray.Menu(
            pystray.MenuItem(lambda item: "Paused" if main_mod.PAUSED.is_set() else "Listening", None, enabled=False),
            pystray.MenuItem(lambda item: "Resume" if main_mod.PAUSED.is_set() else "Pause", toggle_pause),
            pystray.MenuItem("Open dashboard", open_dashboard),
            pystray.MenuItem("Quit", quit_app),
        ),
    )
    icon.run()  # blocks; owns the main thread (required on macOS)


def smoke():
    """CI smoke test: prove the frozen bundle has everything, then exit."""
    import numpy  # noqa: F401
    import sherpa_onnx  # noqa: F401
    from faster_whisper import WhisperModel  # noqa: F401
    import faster_whisper.assets
    vad = os.path.join(os.path.dirname(faster_whisper.assets.__file__), "silero_vad_v6.onnx")
    assert os.path.exists(vad), f"VAD model missing from bundle: {vad}"
    if sys.platform == "darwin":
        import sounddevice  # noqa: F401
        import mac_audio  # noqa: F401
        import mac_blackhole  # noqa: F401
    elif sys.platform == "win32":
        import pyaudiowpatch  # noqa: F401
    import echo_gate  # noqa: F401
    import speakers  # noqa: F401
    print("config dir:", app_dir())
    print("SMOKE-OK")


if __name__ == "__main__":
    if os.environ.get("EARSHOT_SMOKE") == "1":
        smoke()
        sys.exit(0)
    if "--pair-only" in sys.argv:
        pair_only()
        sys.exit(0)
    setup_logging()
    # A source install checks for new code before anything starts, where taking
    # it costs nothing: no pipeline to restart, no websocket to drop.
    try:
        import updater
        if updater.check_at_startup(os.environ.get("EARSHOT_HUB", DEFAULT_HUB)):
            # this process is the OLD tray.py; hand off to the code we just
            # installed (nothing is running yet, so this is free)
            updater.restart()
    except Exception as e:  # noqa: BLE001
        print(f"[app] update check skipped: {e}")
    if already_running():
        # opening the dashboard makes the click DO something — a silent exit is
        # why a user clicks again (and again): four agents on one account, every
        # line captured four times, is exactly how this bug got reported
        print("[app] already running — exiting second instance")
        try:
            webbrowser.open((load_config() or {}).get("hub", DEFAULT_HUB))
        except Exception as e:  # noqa: BLE001 — never let this block the exit
            print(f"[app] could not open the dashboard: {e}")
        sys.exit(0)
    register_protocol()
    try:
        cfg = load_config()
        if not cfg or not cfg.get("captureKey"):
            print("[app] first run — pairing with the dashboard...")
            cfg = pair()
            save_config(cfg)
            print("[app] paired.")
        # macOS hears the other side of a call through a virtual audio driver.
        # Offer it once — nagging every launch is worse than mic-only capture,
        # and the user can re-run the app after installing it.
        if sys.platform == "darwin" and not cfg.get("blackholePrompted"):
            try:
                import mac_blackhole
                if not mac_blackhole.offer_install():
                    cfg["blackholePrompted"] = True
                    save_config(cfg)
            except Exception as e:  # noqa: BLE001 — never block capture on this
                print(f"[app] blackhole check failed: {e}")
        main_mod = start_pipeline(cfg)
    except Exception:
        import traceback
        traceback.print_exc()
        raise
    run_tray(main_mod, cfg)
