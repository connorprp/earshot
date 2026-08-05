"""Earshot capture service.

Captures two audio streams — WASAPI loopback (what you hear: calls, videos)
and the default microphone (you) — segments speech on silence, transcribes
segments with faster-whisper on the GPU, and ships transcript events to the
Node hub over websocket:

    {"type": "transcript", "source": "me"|"them", "text": "...", "ts": 1723...,
     "speaker": "them-2"}   # loopback voices only, via speakers.py; absent if unknown

plus periodic {"type": "speakers", "speakers": [{id, centroid, seconds}]}
snapshots so the hub can persist voice profiles per session.

Config via env:
    EARSHOT_MODEL   whisper model name        (default: large-v3-turbo)
    EARSHOT_DEVICE  cuda | cpu                (default: cuda)
    EARSHOT_WS      hub websocket url         (default: ws://127.0.0.1:7071/ingest)
"""
from __future__ import annotations  # pyaudio exists only on Windows; keep its annotations lazy

import sys

if sys.platform == "win32":
    import cuda_paths  # noqa: F401  (must be imported before faster_whisper)

import json
import os
import queue
import threading
import time


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
from faster_whisper import WhisperModel
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


def asr_worker():
    print(f"[asr] loading {MODEL_NAME} on {DEVICE} ...")
    compute = "float16" if DEVICE == "cuda" else "int8"
    model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=compute)
    print("[asr] model ready")
    labeler = SpeakerLabeler()
    known_speakers = 0
    last_snapshot = 0.0
    while True:
        source, audio, start_ts = asr_queue.get()
        if PAUSED.is_set():
            continue
        seg_end = start_ts + len(audio) / TARGET_RATE
        if source == "me":
            # timing gate: a mic segment buried in loopback speech is echo,
            # however badly it would transcribe — skip the GPU entirely
            overlap = echo_gate.loopback_overlap(start_ts, seg_end)
            if overlap >= echo_gate.GATE_OVERLAP and echo_gate.gate_engaged():
                print(f"[echo] mic segment dropped ({overlap:.0%} inside loopback speech)")
                continue
        try:
            segments, _ = model.transcribe(
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
        if source == "them":
            echo_gate.note_them_text(start_ts, text)
            speaker = labeler.label(audio)
            if speaker:
                event["speaker"] = speaker
        print(f"  [{event.get('speaker', source)}] {text}")
        out_queue.put(event)
        # centroid snapshot: on a new voice, else at most every 20s
        if labeler.clusters and (len(labeler.clusters) != known_speakers or time.time() - last_snapshot > 20):
            known_speakers = len(labeler.clusters)
            last_snapshot = time.time()
            out_queue.put({"type": "speakers", "speakers": labeler.snapshot()})


def ws_sender():
    """Ships events to the hub; reconnects forever, never drops the current event."""
    pending = None
    while True:
        try:
            with connect(HUB_URL) as ws:
                print(f"[ws] connected to {HUB_URL}")
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
