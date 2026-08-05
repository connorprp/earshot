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
    cfg = load_config()
    if not cfg or not cfg.get("captureKey"):
        print("[app] first run — pairing with the dashboard...")
        cfg = pair()
        save_config(cfg)
        print("[app] paired.")
    main_mod = start_pipeline(cfg)
    run_tray(main_mod, cfg)
