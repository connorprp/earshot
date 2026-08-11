"""Earshot capture service.

Captures two audio streams — WASAPI loopback (what you hear: calls, videos)
and the default microphone (you) — segments speech on silence, transcribes
segments with faster-whisper on the GPU, and ships transcript events to the
Node hub over websocket:

    {"type": "transcript", "source": "me"|"them", "text": "...", "ts": 1723...,
     "speaker": "me"|"them-2"}   # voice identity via speakers.py; absent if unknown.
                                 # "source" is the CHANNEL (mic vs loopback) —
                                 # both echo layers key off it — while "speaker"
                                 # is WHO: the mic can carry other people too
                                 # (speakerphone, someone in the room).

plus periodic {"type": "speakers", "speakers": [{id, centroid, seconds}]}
snapshots so the hub can persist voice profiles per session.

Config via env:
    EARSHOT_MODEL   whisper model name        (default: large-v3-turbo)
    EARSHOT_DEVICE  cuda | cpu                (default: cuda)
    EARSHOT_WS      hub websocket url         (default: ws://127.0.0.1:7071/ingest)
    EARSHOT_ASR     local | groq              (default: local; the hub's
                    {"type":"config"} downlink overrides this live — in groq
                    mode segments ship as audio and the hub transcribes)
"""
from __future__ import annotations  # pyaudio exists only on Windows; keep its annotations lazy

import sys

import base64
import io
import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import wave
from pathlib import Path


def _load_env_file():
    """--env-file <path>: load KEY=VALUE lines (existing env wins). Lets one
    install target different hubs: `main.py --env-file cloud.env` points this
    capture agent at the hosted hub without touching the local-dev defaults."""
    if "--env-file" not in sys.argv:
        return
    path = sys.argv[sys.argv.index("--env-file") + 1]
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


_load_env_file()

import numpy as np
import soxr
from websockets.sync.client import connect

if sys.platform == "win32":
    import pyaudiowpatch as pyaudio  # WASAPI loopback (Windows only)

import echo_gate
from speakers import SpeakerLabeler

IS_MAC = sys.platform == "darwin"
MODEL_NAME = os.environ.get("EARSHOT_MODEL", "small.en" if IS_MAC else "large-v3-turbo")
DEVICE = os.environ.get("EARSHOT_DEVICE", "cpu" if IS_MAC else "cuda")
HUB_URL = os.environ.get("EARSHOT_WS", "ws://127.0.0.1:7071/ingest")
CAPTURE_KEY = os.environ.get("EARSHOT_KEY", "")  # required by a hosted hub
if CAPTURE_KEY:
    HUB_URL += ("&" if "?" in HUB_URL else "?") + "key=" + CAPTURE_KEY

TARGET_RATE = 16000
SPEECH_RMS = 0.010       # rms above this counts as speech (minimum threshold)
FLOOR_MARGIN = 2.5       # speech must also exceed the tracked noise floor by this
FLOOR_RISE = 0.05        # EMA rate for the floor creeping up (fast fall, slow rise)
SILENCE_END_S = 0.8      # this much trailing silence closes a segment
MIN_SPEECH_S = 0.35      # segments shorter than this are dropped
MAX_SEGMENT_S = 15.0     # force-flush long segments
PRE_ROLL_S = 0.4         # audio kept before speech onset

asr_queue: "queue.Queue[tuple[str, np.ndarray, float]]" = queue.Queue()
out_queue: "queue.Queue[dict]" = queue.Queue()
PAUSED = threading.Event()  # tray app toggles this; segments are dropped while set

# ASR mode, pushed by the hub over the ws ({"type":"config", ...}) and applied
# live. "local" = faster-whisper here (today's behavior); "groq" = ship the
# audio segment to the hub, which transcribes via Groq's API — thin agents
# never download a model or load CUDA. Env is only the pre-config fallback.
ASR_MODE = os.environ.get("EARSHOT_ASR", "local")
ASR_MODEL = MODEL_NAME
CONFIG_READY = threading.Event()  # set once the hub has told us the mode


def apply_config(msg: dict):
    global ASR_MODE, ASR_MODEL
    mode = msg.get("asrMode")
    if mode in ("local", "groq"):
        if mode != ASR_MODE:
            print(f"[asr] mode -> {mode}")
        ASR_MODE = mode
    if msg.get("asrModel"):  # null/absent = keep the platform/env default
        ASR_MODEL = msg["asrModel"]
    CONFIG_READY.set()
    # the hub tells every agent which code it is serving; a source install
    # (curl|bash) picks up a push on its own, so Connor's friends never
    # re-download anything — see updater.py
    if msg.get("captureVersion"):
        _maybe_update(msg["captureVersion"])


def _maybe_update(hub_version: str):
    """Called from the config downlink (and by the hub's explicit "update now").
    Runs on the ws thread, so keep the fast path to a string compare."""
    try:
        import updater
        if not updater.is_source_install() or hub_version == updater.current_version():
            return
        print(f"[update] hub is serving {hub_version[:12]}, we run {updater.current_version()[:12] or 'unknown'}")
        release = None
        if "tray" in sys.modules:  # the successor needs the single-instance lock
            release = getattr(sys.modules["tray"], "release_instance_lock", None)
        threading.Thread(
            target=updater.update_and_restart, args=(_hub_http_base(),), kwargs={"release_lock": release}, daemon=True
        ).start()
    except Exception as e:  # noqa: BLE001 — never let an update attempt kill capture
        print(f"[update] check failed: {e}")


class Segmenter:
    """Accumulates mono 16k float32 audio and emits speech segments."""

    def __init__(self, source: str):
        self.source = source
        self.buf = np.zeros(0, dtype=np.float32)
        self.pre = np.zeros(0, dtype=np.float32)
        self.speaking = False
        self.silence_run = 0.0
        self.start_ts = 0.0
        self.floor = 0.0  # tracked noise floor; audio interfaces can idle above SPEECH_RMS

    def feed(self, chunk: np.ndarray):
        dur = len(chunk) / TARGET_RATE
        rms = float(np.sqrt(np.mean(chunk**2))) if len(chunk) else 0.0

        # Speech must clear both the absolute minimum and the stream's own
        # noise floor (the Focusrite idles at ~0.0135 rms — above SPEECH_RMS —
        # which otherwise reads as speech that never ends). Floor falls
        # instantly, rises slowly, so voice can't drag it up.
        threshold = max(SPEECH_RMS, self.floor * FLOOR_MARGIN)
        if rms > 0.0 and (self.floor == 0.0 or rms < self.floor):
            self.floor = rms
        elif rms < threshold:
            self.floor += FLOOR_RISE * (rms - self.floor)

        if not self.speaking:
            if rms >= threshold:
                self.speaking = True
                self.silence_run = 0.0
                self.start_ts = time.time() - dur - len(self.pre) / TARGET_RATE
                self.buf = np.concatenate([self.pre, chunk])
                self.pre = np.zeros(0, dtype=np.float32)
                if self.source == "them":
                    echo_gate.note_speech_start(id(self), self.start_ts)
            else:
                keep = int(PRE_ROLL_S * TARGET_RATE)
                self.pre = np.concatenate([self.pre, chunk])[-keep:]
            return

        self.buf = np.concatenate([self.buf, chunk])
        self.silence_run = self.silence_run + dur if rms < threshold else 0.0

        if self.silence_run >= SILENCE_END_S or len(self.buf) / TARGET_RATE >= MAX_SEGMENT_S:
            self._flush()

    def _flush(self):
        audio, self.buf = self.buf, np.zeros(0, dtype=np.float32)
        self.speaking = False
        speech_s = len(audio) / TARGET_RATE - self.silence_run
        self.silence_run = 0.0
        if self.source == "them":
            # any loopback sound counts as a potential echo source, even segments
            # too short to transcribe
            echo_gate.note_speech_end(id(self), self.start_ts, self.start_ts + len(audio) / TARGET_RATE)
        if speech_s >= MIN_SPEECH_S:
            asr_queue.put((self.source, audio, self.start_ts))


def stream_worker(source: str, device_info: dict, p: pyaudio.PyAudio):
    """Opens one input stream and feeds its segmenter forever."""
    rate = int(device_info["defaultSampleRate"])
    channels = max(1, int(device_info["maxInputChannels"]))
    seg = Segmenter(source)
    raw_q: "queue.Queue[bytes]" = queue.Queue()

    def cb(in_data, frame_count, time_info, status):
        raw_q.put(in_data)
        return (None, pyaudio.paContinue)

    try:
        stream = p.open(
            format=pyaudio.paInt16,
            channels=channels,
            rate=rate,
            input=True,
            input_device_index=device_info["index"],
            frames_per_buffer=int(rate * 0.1),
            stream_callback=cb,
        )
        stream.start_stream()
    except Exception as e:
        print(f"[capture] SKIP '{device_info['name']}': {e}")
        return
    print(f"[capture] {source}: '{device_info['name']}' @ {rate}Hz x{channels}")

    while True:
        data = raw_q.get()
        pcm = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
        if channels > 1:
            pcm = pcm.reshape(-1, channels).mean(axis=1)
        if rate != TARGET_RATE:
            pcm = soxr.resample(pcm, rate, TARGET_RATE)
        seg.feed(pcm)


_model = None
_model_name = None


def _get_model(name: str):
    """Lazy on purpose: a groq-mode agent must never pull CUDA DLLs or
    trigger the first-run whisper download — that cost is the reason thin
    mode exists. Reloads if the hub pushes a different model name."""
    global _model, _model_name
    if _model is None or _model_name != name:
        if sys.platform == "win32":
            import cuda_paths  # noqa: F401  (must be imported before faster_whisper)
        from faster_whisper import WhisperModel

        print(f"[asr] loading {name} on {DEVICE} ...")
        compute = "float16" if DEVICE == "cuda" else "int8"
        _model = WhisperModel(name, device=DEVICE, compute_type=compute)
        _model_name = name
        print("[asr] model ready")
    return _model


def _wav_b64(audio: np.ndarray) -> str:
    """Mono float32 [-1,1] @16k -> base64 of a 16-bit PCM WAV."""
    pcm = (audio * 32767.0).clip(-32768, 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(TARGET_RATE)
        w.writeframes(pcm.tobytes())
    return base64.b64encode(buf.getvalue()).decode("ascii")


# groq mode: mic segments leave before transcription, but the echo gate's
# text-evidence check needs each segment's loopback overlap once the hub's
# transcript comes back down — remember it briefly, keyed by segment ts
_me_overlap: dict[float, float] = {}


def asr_worker():
    labeler = SpeakerLabeler()
    known_rev = 0
    last_snapshot = 0.0
    first = True
    while True:
        source, audio, start_ts = asr_queue.get()
        if first:
            # give the hub a moment to push the mode before the first segment
            # can trigger a whisper load/download the user never needed
            CONFIG_READY.wait(timeout=5)
            first = False
        if PAUSED.is_set():
            continue
        seg_end = start_ts + len(audio) / TARGET_RATE
        overlap = 0.0
        if source == "me":
            # timing gate: a mic segment buried in loopback speech is echo,
            # however badly it would transcribe — skip the GPU (and any
            # upload) entirely
            overlap = echo_gate.loopback_overlap(start_ts, seg_end)
            if overlap >= echo_gate.GATE_OVERLAP and echo_gate.gate_engaged():
                print(f"[echo] mic segment dropped ({overlap:.0%} inside loopback speech)")
                continue
        # Voice identity for BOTH channels: the mic is not one person (a
        # speakerphone call or a coworker at the desk lands there too), so who
        # spoke comes from the embedding, not from which stream it arrived on.
        speaker = labeler.label(audio, source)
        if source == "me" and speaker and speaker != "me" and overlap >= 0.3 and labeler.is_loopback_voice(speaker):
            # voice-level echo evidence: the mic just heard a voice we know
            # mostly from loopback, while loopback was playing. Evidence only —
            # layers 1 and 2 still decide what actually gets dropped.
            echo_gate.record_hit()
            print(f"[echo] mic segment carries loopback voice {speaker} (evidence)")
        if ASR_MODE == "groq":
            event = {
                "type": "audio",
                "source": source,
                "ts": start_ts,
                "rate": TARGET_RATE,
                "format": "wav",
                "data": _wav_b64(audio),
            }
            if speaker:
                event["speaker"] = speaker
            if source == "me":
                now = time.time()
                for k in [k for k in _me_overlap if now - k > 90]:
                    del _me_overlap[k]
                _me_overlap[start_ts] = overlap
            print(f"  [{event.get('speaker', source)}] {len(audio) / TARGET_RATE:.1f}s -> hub")
            out_queue.put(event)
        else:
            try:
                segments, _ = _get_model(ASR_MODEL).transcribe(
                    audio,
                    language="en",
                    beam_size=1,
                    vad_filter=True,
                    condition_on_previous_text=False,
                )
                text = " ".join(s.text.strip() for s in segments).strip()
            except Exception as e:
                print(f"[asr] error: {e}")
                continue
            if not text:
                continue
            if source == "me":
                # text evidence layer: a mic line that reads like a recent loopback
                # line is a confirmed echo — drop it and (in auto mode) arm the gate
                match = echo_gate.mic_text_match(start_ts, text)
                if match >= echo_gate.EVIDENCE_MATCH and overlap >= 0.3:
                    echo_gate.record_hit()
                    print(f"[echo] mic line dropped (reads like loopback, match {match:.2f})")
                    continue
            event = {"type": "transcript", "source": source, "text": text, "ts": start_ts}
            if speaker:
                event["speaker"] = speaker
            if source == "them":
                echo_gate.note_them_text(start_ts, text)
            print(f"  [{event.get('speaker', source)}] {text}")
            out_queue.put(event)
        # centroid snapshot: whenever the label set changed (new voice, or the
        # owner moved — which renames clusters without adding one), else 20s
        if labeler.clusters and (labeler.rev != known_rev or time.time() - last_snapshot > 20):
            known_rev = labeler.rev
            last_snapshot = time.time()
            out_queue.put({"type": "speakers", "speakers": labeler.snapshot()})


# ---- device-agent tasks ----
# The hub pushes {"type":"task", id, title, prompt} down this websocket when
# the user clicks an "agent" action. We spawn the user's OWN Claude Code
# (their login, their billing — the hub's shared key is never involved) in a
# per-task directory, stream progress back up as task_update events, and ship
# the outcome as task_done. Guardrails: no Bash, file writes accepted only in
# the task directory (acceptEdits), web + the Earshot MCP explicitly allowed.
# The mcp__<server> entries are the user's OWN claude.ai connectors (Gmail,
# Calendar, Drive, ...) — the point of running on their machine is that those
# connections already exist, so Earshot never asks them to connect anything.
# Server-level rules (mcp__claude_ai_Gmail) are required: wildcard tool
# patterns (mcp__claude_ai_*) silently DENY — verified live. ToolSearch must
# be allowed too: connector tools are deferred until searched for.
TASK_TIMEOUT_S = 14 * 60  # hub gives up at 15 min; die first so it hears from us
TASK_BASE_TOOLS = ["WebSearch", "WebFetch", "ToolSearch", "mcp__earshot"]
# pre-probe fallback: the most common connectors, allowed blind
TASK_DEFAULT_CONNECTORS = ["Gmail", "Google Calendar", "Google Drive", "Notion"]

# connected claude.ai connectors, probed once per process via `claude mcp list`
# (~8s) in a background thread; None until the probe lands. Display names
# ("Google Calendar") — slugified on use ("claude_ai_Google_Calendar"). Shipped
# up in caps so the hub can steer the distill toward actions that these apps
# make real, and used here to auto-allow exactly the user's connected servers.
_CONNECTORS: list[str] | None = None

# live task processes, so the dashboard's Stop can kill one mid-run; task ids
# the user stopped (so we report "stopped", not "crashed"); and the claude
# session id per task, which is what a follow-up turn resumes.
_RUNNING: dict[str, subprocess.Popen] = {}
_CANCELLED: set[str] = set()
_SESSIONS: dict[str, str] = {}


def _connector_slug(name: str) -> str:
    import re
    return "claude_ai_" + re.sub(r"[^A-Za-z0-9]+", "_", name).strip("_")


def _task_allowed_tools() -> str:
    names = _CONNECTORS if _CONNECTORS is not None else TASK_DEFAULT_CONNECTORS
    return ",".join(TASK_BASE_TOOLS + [f"mcp__{_connector_slug(n)}" for n in names])


def _probe_connectors():
    """`claude mcp list` prints one line per server, claude.ai connectors as
    'claude.ai <Name>: <url> - ✔ Connected' / '! Needs authentication'."""
    global _CONNECTORS
    claude = _find_claude()
    if not claude:
        return
    cmd = [claude, "mcp", "list"]
    if sys.platform == "win32" and claude.lower().endswith((".cmd", ".bat")):
        cmd = ["cmd", "/c"] + cmd
    try:
        out = subprocess.run(
            cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90,
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        ).stdout
    except Exception as e:
        print(f"[caps] connector probe failed: {e}")
        return
    found = []
    for line in out.splitlines():
        if line.startswith("claude.ai ") and "Connected" in line and ":" in line:
            found.append(line[len("claude.ai "):].split(":", 1)[0].strip())
    _CONNECTORS = found
    print(f"[caps] connected apps: {', '.join(found) or 'none'}")
    out_queue.put(_caps_msg())  # update the hub (first caps went out pre-probe)


def _caps_msg() -> dict:
    caps = {
        "type": "caps",
        "claude": _find_claude() is not None,
        "connectors": _CONNECTORS or [],
        "platform": "mac" if IS_MAC else ("windows" if sys.platform == "win32" else "linux"),
    }
    # WHICH computer this is: an account can have several, and work has to run on
    # the one the user is actually sitting at (see updater.device_id)
    try:
        import updater
        caps["deviceId"] = updater.device_id()
        caps["deviceName"] = updater.device_name()
        caps["version"] = updater.current_version()
        caps["selfUpdating"] = updater.is_source_install()
    except Exception:  # noqa: BLE001
        pass
    return caps


def _recheck_caps():
    """Re-probe what this machine can do and tell the hub.

    The onboarding flow leans on this: someone installs Claude Code *after* the
    agent is already running, and without a re-probe the dashboard would keep
    saying "no Claude on this computer" until they restarted it.
    """
    global _CONNECTORS
    found = _find_claude()
    print(f"[caps] recheck: claude {'available' if found else 'not found'}")
    out_queue.put(_caps_msg())
    if found and _CONNECTORS is None:
        threading.Thread(target=_probe_connectors, daemon=True).start()


def _watch_for_claude():
    """No Claude CLI at startup: look again every minute for half an hour, so an
    install during onboarding lights the dashboard up on its own."""
    for _ in range(30):
        time.sleep(60)
        if _find_claude():
            _recheck_caps()
            return


def _find_claude() -> str | None:
    """The packaged app is launched from Explorer/Finder, whose PATH often
    misses dev-tool locations — check the common install spots too."""
    hit = shutil.which("claude")
    if hit:
        return hit
    home = Path.home()
    candidates = [home / ".local" / "bin" / ("claude.exe" if sys.platform == "win32" else "claude")]
    if sys.platform == "win32" and os.environ.get("APPDATA"):
        candidates.append(Path(os.environ["APPDATA"]) / "npm" / "claude.cmd")
    elif IS_MAC:
        candidates += [Path("/opt/homebrew/bin/claude"), Path("/usr/local/bin/claude")]
    for c in candidates:
        if c.is_file():
            return str(c)
    return None


def _tasks_root() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", str(Path.home()))) / "Earshot" / "tasks"
    if IS_MAC:
        return Path.home() / "Library" / "Application Support" / "Earshot" / "tasks"
    return Path.home() / ".earshot" / "tasks"


def _hub_http_base() -> str:
    """ws(s)://host/ingest?... -> http(s)://host (for the MCP endpoint)."""
    url = HUB_URL.split("?")[0]
    url = url.replace("wss://", "https://").replace("ws://", "http://")
    return url[: -len("/ingest")] if url.endswith("/ingest") else url


def _task_note(msg: dict) -> str | None:
    """One short human line from a stream-json assistant event, for the
    dashboard's live 'your Claude is working' chip."""
    for block in msg.get("message", {}).get("content", []):
        if block.get("type") == "tool_use":
            name = block.get("name", "tool").replace("mcp__earshot__", "earshot: ")
            return f"using {name}"
        if block.get("type") == "text" and block.get("text", "").strip():
            return block["text"].strip()[:140]
    return None


def _tool_summary(block: dict) -> str:
    """The interesting argument of a tool call, for the dashboard's tool line
    (the full input is noise: file contents, whole email bodies)."""
    inp = block.get("input") or {}
    for key in ("query", "prompt", "url", "command", "file_path", "path", "subject", "title", "name"):
        v = inp.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()[:200]
    try:
        return json.dumps(inp)[:200]
    except Exception:
        return ""


def _stream_items(ev: dict) -> list[dict]:
    """A stream-json event -> compact display items, so the dashboard shows the
    session the way a terminal would (assistant text, tool calls, results)
    without shipping raw tool payloads over the wire."""
    items: list[dict] = []
    kind = ev.get("type")
    if kind == "assistant":
        for block in ev.get("message", {}).get("content", []):
            btype = block.get("type")
            if btype == "text" and block.get("text", "").strip():
                items.append({"kind": "text", "text": block["text"].strip()[:6000]})
            elif btype == "thinking" and block.get("thinking", "").strip():
                items.append({"kind": "thinking", "text": block["thinking"].strip()[:2000]})
            elif btype == "tool_use":
                items.append({
                    "kind": "tool",
                    "name": str(block.get("name") or "tool"),
                    "text": _tool_summary(block),
                })
    elif kind == "user":
        # tool results come back as a "user" event in stream-json
        content = ev.get("message", {}).get("content", [])
        for block in content if isinstance(content, list) else []:
            if block.get("type") != "tool_result":
                continue
            payload = block.get("content")
            if isinstance(payload, list):
                text = " ".join(str(c.get("text", "")) for c in payload if isinstance(c, dict))
            else:
                text = str(payload or "")
            text = text.strip()
            if text:
                items.append({
                    "kind": "tool_result",
                    "text": text[:800],
                    "ok": not block.get("is_error"),
                })
    return items


# Deliverables can't be opened from the dashboard: the browser may be on
# another machine, and file:// links are blocked from an https page. So the
# agent reports WHAT it produced, and opening it happens here, on the device
# that holds it. Executables are never opened by a click — a task's own agent
# writes into the task dir, and a prompt-injected one must not be able to hand
# the user a one-click .bat.
_NEVER_OPEN = {
    ".exe", ".bat", ".cmd", ".com", ".scr", ".msi", ".ps1", ".vbs", ".vbe",
    ".js", ".jse", ".wsf", ".wsh", ".hta", ".jar", ".reg", ".lnk", ".app", ".sh",
}
_LINK_BLOCK = re.compile(r"```earshot-links\s*(.+?)```", re.S)


def _parse_links(text: str, tdir: Path) -> tuple[str, list[dict]]:
    """Pull the agent's machine-readable result block out of its final summary:

        ```earshot-links
        [{"label": "Open the proposal", "file": "proposal.docx"},
         {"label": "Open the Gmail draft", "url": "https://mail.google.com/..."}]
        ```

    Returns (summary without the block, links). Anything malformed is ignored —
    the caller still falls back to the files that appeared in the task dir.
    """
    links: list[dict] = []
    m = _LINK_BLOCK.search(text)
    if m:
        text = (text[: m.start()] + text[m.end():]).strip()
        try:
            for it in json.loads(m.group(1).strip())[:12]:
                if not isinstance(it, dict):
                    continue
                label = str(it.get("label") or "").strip()[:80]
                url, name = str(it.get("url") or "").strip(), str(it.get("file") or "").strip()
                if url.startswith(("http://", "https://")):
                    links.append({"label": label or "Open", "url": url[:500]})
                elif name:
                    # only a real file, only inside this task's directory
                    p = (tdir / name).resolve()
                    if p.is_file() and p.parent == tdir.resolve():
                        links.append({"label": label or f"Open {p.name}", "file": p.name})
        except Exception as e:
            print(f"[task] links block ignored ({e})")
    return text, links


def _open_path(thread_id: str, name: str) -> None:
    """The dashboard asked to open a deliverable. It names a file inside a task
    directory — never a path, never anything runnable."""
    root = _tasks_root().resolve()
    tdir = (root / thread_id).resolve()
    target = tdir if not name else (tdir / name).resolve()
    if not (target == tdir or target.parent == tdir) or not str(target).startswith(str(root)):
        return print(f"[task] refused to open outside the task folder: {name}")
    if not target.exists():
        return print(f"[task] nothing to open at {target}")
    if target.is_file() and target.suffix.lower() in _NEVER_OPEN:
        print(f"[task] refusing to launch {target.name} — opening its folder instead")
        target = tdir
    try:
        if sys.platform == "win32":
            os.startfile(target)  # noqa: S606
        elif IS_MAC:
            subprocess.Popen(["open", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target)])
        print(f"[task] opened {target}")
    except Exception as e:
        print(f"[task] could not open {target}: {e}")


def _run_task(msg: dict):
    task_id, title, prompt = str(msg.get("id") or ""), str(msg.get("title") or "task"), str(msg.get("prompt") or "")
    thread_id = str(msg.get("threadId") or "")
    resume = str(msg.get("resume") or "")  # a claude session id: continue THAT conversation
    if not task_id or not prompt:
        return

    def done(ok: bool, summary: str, files: list[str] | None = None, links: list[dict] | None = None):
        out_queue.put({
            "type": "task_done", "id": task_id, "ok": ok, "summary": summary[:600],
            "files": files or [], "links": links or [],
            # the dashboard needs this to ask us to open one of those files
            "threadId": thread_id,
        })

    claude = _find_claude()
    if not claude:
        return done(False, "Claude Code isn't installed on this computer (or isn't on PATH).")
    # the thread owns the working directory, so every turn of a conversation
    # sees (and adds to) the same deliverables
    tdir = _tasks_root() / (thread_id or task_id)
    tdir.mkdir(parents=True, exist_ok=True)
    before = {p.name for p in tdir.iterdir() if p.is_file()}
    mcp = {"mcpServers": {"earshot": {"type": "http", "url": _hub_http_base() + "/mcp"}}}
    headers = {}
    if CAPTURE_KEY:
        headers["Authorization"] = "Bearer " + CAPTURE_KEY
    # which conversation is calling: the hub needs it to apply the earshot write
    # tools (edit_notes & co) to the right board and to show "✎ …" in this chat
    if thread_id:
        headers["X-Earshot-Thread"] = thread_id
    if headers:
        mcp["mcpServers"]["earshot"]["headers"] = headers
    (tdir / "mcp.json").write_text(json.dumps(mcp))
    # no --strict-mcp-config: the user's own MCP config (incl. claude.ai
    # connectors) loads alongside the earshot server from mcp.json; only the
    # allowlisted tools run without asking, everything else is auto-denied
    cmd = [
        claude, "-p", "--output-format", "stream-json", "--verbose",
        "--permission-mode", "acceptEdits",
        "--allowedTools", _task_allowed_tools(),
        "--mcp-config", "mcp.json",
        "--max-turns", "60",
    ]
    if resume:
        cmd += ["--resume", resume]
    if sys.platform == "win32" and claude.lower().endswith((".cmd", ".bat")):
        cmd = ["cmd", "/c"] + cmd  # CreateProcess won't exec batch scripts directly
    print(f"[task] {task_id} starting: {title}{' (resume)' if resume else ''}")
    out_queue.put({"type": "task_update", "id": task_id, "note": "agent starting on your device"})
    result_text, ok = "", False
    try:
        with open(tdir / "stderr.log", "ab") as errlog:
            proc = subprocess.Popen(
                cmd, cwd=str(tdir),
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errlog,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
            _RUNNING[task_id] = proc  # so a cancel from the hub can kill it
            watchdog = threading.Timer(TASK_TIMEOUT_S, proc.kill)
            watchdog.start()
            try:
                proc.stdin.write(prompt.encode("utf-8"))  # prompt via stdin: no argv length/quoting issues
                proc.stdin.close()
                for raw in proc.stdout:
                    try:
                        ev = json.loads(raw)
                    except Exception:
                        continue
                    # the session id lets the hub send follow-up turns that
                    # RESUME this conversation instead of starting fresh
                    if ev.get("session_id") and thread_id:
                        sid = str(ev["session_id"])
                        if sid != _SESSIONS.get(task_id):
                            _SESSIONS[task_id] = sid
                            out_queue.put({"type": "task_session", "id": task_id,
                                           "threadId": thread_id, "sessionId": sid})
                    items = _stream_items(ev)
                    if items and thread_id:
                        out_queue.put({"type": "task_stream", "id": task_id,
                                       "threadId": thread_id, "items": items})
                    if ev.get("type") == "assistant":
                        note = _task_note(ev)
                        if note:
                            out_queue.put({"type": "task_update", "id": task_id, "note": note})
                    elif ev.get("type") == "result":
                        result_text = str(ev.get("result") or "")
                        ok = ev.get("subtype") == "success" and not ev.get("is_error")
                proc.wait()
            finally:
                watchdog.cancel()
                _RUNNING.pop(task_id, None)
                _SESSIONS.pop(task_id, None)
    except Exception as e:
        return done(False, f"Couldn't run the local Claude agent: {e}")
    if task_id in _CANCELLED:
        _CANCELLED.discard(task_id)
        print(f"[task] {task_id} cancelled by the user")
        return done(False, "Stopped by you.")
    files = sorted(
        p.name for p in tdir.iterdir()
        if p.is_file() and p.name not in ("mcp.json", "stderr.log")
    )
    if not result_text:
        result_text = "The agent produced no result (timed out or crashed — see stderr.log in the task folder)."
    result_text, links = _parse_links(result_text, tdir)
    # whatever the agent forgot to list, the new files still get a button
    named = {l.get("file") for l in links}
    for name in sorted(set(files) - before):
        if name not in named:
            links.append({"label": f"Open {name}", "file": name})
    print(f"[task] {task_id} {'done' if ok else 'FAILED'}: {result_text[:120]}")
    done(ok, result_text, files, links)


def _cancel_task(task_id: str):
    """The user pressed stop in the dashboard. The hub has already given up on
    this task, so all we owe it is a dead process."""
    proc = _RUNNING.get(task_id)
    if not proc:
        return
    _CANCELLED.add(task_id)
    try:
        proc.kill()
    except Exception:
        pass


def _handle_downlink(msg: dict):
    if msg.get("type") == "config":
        apply_config(msg)
    elif msg.get("type") == "task":
        threading.Thread(target=_run_task, args=(msg,), daemon=True).start()
    elif msg.get("type") == "task_cancel":
        _cancel_task(str(msg.get("id") or ""))
    elif msg.get("type") == "recheck":
        # the dashboard's "I've installed it now, check again" button
        threading.Thread(target=_recheck_caps, daemon=True).start()
    elif msg.get("type") == "update":
        # "Update agents now" in Settings: same path as the version mismatch,
        # minus waiting for the next connect
        _maybe_update(str(msg.get("version") or "force"))
    elif msg.get("type") == "open":
        _open_path(str(msg.get("threadId") or ""), str(msg.get("file") or ""))
    elif msg.get("type") == "transcript" and msg.get("text"):
        # groq mode: the hub transcribed our audio — run the same echo-gate
        # text-evidence path the local branch of asr_worker runs
        ts, text = msg.get("ts", 0.0), msg["text"]
        if msg.get("source") == "them":
            echo_gate.note_them_text(ts, text)
        elif msg.get("source") == "me":
            overlap = _me_overlap.pop(ts, 0.0)
            match = echo_gate.mic_text_match(ts, text)
            if match >= echo_gate.EVIDENCE_MATCH and overlap >= 0.3:
                echo_gate.record_hit()
                print(f"[echo] mic line reads like loopback per hub (match {match:.2f})")


def _ws_reader(ws):
    """Consumes hub->capture messages (config, groq-mode transcripts). One
    sender + one reader thread on a sync connection is websockets' supported
    threading pattern. Dies with the connection; ws_sender spawns a fresh one."""
    try:
        while True:
            msg = json.loads(ws.recv())
            if isinstance(msg, dict):
                _handle_downlink(msg)
    except Exception:
        return


def ws_sender():
    """Ships events to the hub; reconnects forever, never drops the current event."""
    pending = None
    while True:
        try:
            with connect(HUB_URL) as ws:
                print(f"[ws] connected to {HUB_URL}")
                # capabilities first: the hub routes actions to this device
                # only if the user's own Claude Code is runnable here (a
                # second caps lands once the connector probe finishes)
                ws.send(json.dumps(_caps_msg()))
                threading.Thread(target=_ws_reader, args=(ws,), daemon=True).start()
                while True:
                    if pending is None:
                        pending = out_queue.get()
                    ws.send(json.dumps(pending))
                    pending = None
        except Exception as e:
            print(f"[ws] disconnected ({e}); retrying in 3s")
            time.sleep(3)


def find_devices(p: pyaudio.PyAudio):
    """Returns (mic, [all loopback devices]).

    We tap EVERY render device, not just the default output: apps pick their
    own output (Teams uses the 'communications' endpoint, e.g. a headset's
    Chat channel while the system default is its Game channel), so tapping
    only the default silently misses calls.
    """
    mic = p.get_default_input_device_info()
    loopbacks = list(p.get_loopback_device_info_generator())
    if not loopbacks:
        raise RuntimeError("No WASAPI loopback devices found")
    return mic, loopbacks


def main():
    threading.Thread(target=asr_worker, daemon=True).start()
    threading.Thread(target=ws_sender, daemon=True).start()
    threading.Thread(target=_probe_connectors, daemon=True).start()
    if not _find_claude():
        threading.Thread(target=_watch_for_claude, daemon=True).start()

    if IS_MAC:
        import mac_audio
        streams = mac_audio.start_streams(Segmenter)  # noqa: F841 (keep streams alive)
    else:
        p = pyaudio.PyAudio()
        mic, loopbacks = find_devices(p)
        threading.Thread(target=stream_worker, args=("me", mic, p), daemon=True).start()
        for lb in loopbacks:
            threading.Thread(target=stream_worker, args=("them", lb, p), daemon=True).start()

    print("[earshot] capturing. Ctrl+C to stop.")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[earshot] stopped")


if __name__ == "__main__":
    main()
