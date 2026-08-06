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


def already_running():
    """Single-instance guard: a second copy would open the SAME microphone and
    send every utterance twice (the hub mutes duplicates now, but the machine
    still pays the CPU and the user still sees two tray icons).

    Two layers, because neither covers everything: a named mutex on Windows
    (immune to a lock file left behind by a hard kill) and an exclusive lock
    file everywhere — which is the only guard that works on macOS, where this
    used to return False and happily start a second capture pipeline.
    """
    global _INSTANCE_LOCK
    if sys.platform == "win32":
        # ctypes.windll does NOT preserve the Win32 last-error across the call;
        # use_last_error + get_last_error() is the documented way to read it
        import ctypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateMutexW(None, False, "EarshotCaptureSingleton")
        if ctypes.get_last_error() == 183:  # ERROR_ALREADY_EXISTS
            return True
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
        return True  # someone else holds it
    try:
        _INSTANCE_LOCK.write(f"\n{os.getpid()}")
        _INSTANCE_LOCK.flush()
    except OSError:
        pass
    return False


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
    """Device pairing: returns {wsUrl, captureKey} once the user approves."""
    code = "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(8))
    http_json(f"{DEFAULT_HUB}/pair/start", {"code": code, "host": socket.gethostname()})
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
    if sys.platform == "darwin":
        import mac_audio
        streams = mac_audio.start_streams(main.Segmenter)  # noqa: F841
    else:
        import pyaudiowpatch as pyaudio
        p = pyaudio.PyAudio()
        mic, loopbacks = main.find_devices(p)
        threading.Thread(target=main.stream_worker, args=("me", mic, p), daemon=True).start()
        for lb in loopbacks:
            threading.Thread(target=main.stream_worker, args=("them", lb, p), daemon=True).start()
    return main


def run_tray(main_mod, cfg):
    import pystray
    from PIL import Image, ImageDraw

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
    setup_logging()
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
        main_mod = start_pipeline(cfg)
    except Exception:
        import traceback
        traceback.print_exc()
        raise
    run_tray(main_mod, cfg)
