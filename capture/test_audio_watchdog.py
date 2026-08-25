"""Audio-stream supervisor: when does the agent decide its streams are dead?

Pure logic, no sound card, no hub:

    python capture/test_audio_watchdog.py

Why this exists (2026-08-25): the desktop agent slept overnight, Windows
killed every WASAPI stream without a word, and the process sat "connected"
for 12 hours transcribing nothing. `audio_trouble()` is the decision the
supervisor thread polls; every branch is pinned here so a retune can't quietly
turn it back into the old behavior (open once, never look again).
"""
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import main  # noqa: E402

fails = 0


def check(label, cond, got=""):
    global fails
    print(f"  {'PASS' if cond else 'FAIL'}  {label}")
    if not cond:
        fails += 1
        if got:
            print(f"        got: {got}")


class FakeStream:
    def __init__(self, active=True, raises=False):
        self._active, self._raises = active, raises

    def is_active(self):
        if self._raises:
            raise OSError("device invalidated")
        return self._active


class FakeThread:
    def __init__(self, alive=True):
        self._alive = alive

    def is_alive(self):
        return self._alive


def worker(source, name, opened=True, last=None, active=True, alive=True, raises=False, t0=1000.0):
    h = {"source": source, "name": name, "opened": opened, "last": t0 if last is None else last,
         "stream": FakeStream(active, raises) if opened else None}
    return (h, FakeThread(alive))


T0 = 1000.0
STALL = main.MIC_STALL_S

print("healthy set")
ws = [worker("me", "Mic"), worker("them", "Speakers [Loopback]"), worker("them", "Monitor [Loopback]")]
check("fresh streams: no trouble", main.audio_trouble(ws, T0 + 5, T0) is None)
check("mic delivering, loopback quiet for hours: still fine",
      main.audio_trouble([worker("me", "Mic", last=T0 + 7200), worker("them", "LB", last=T0)], T0 + 7200, T0) is None)

print("dead microphone (the overnight-sleep case)")
ws = [worker("me", "Mic", last=T0), worker("them", "LB", last=T0)]
check("mic just under the stall limit: wait", main.audio_trouble(ws, T0 + STALL - 1, T0) is None)
r = main.audio_trouble(ws, T0 + STALL + 1, T0)
check("mic silent past the limit: rebuild", r is not None and "microphone" in r and "Mic" in r, r)

print("stream reports itself stopped")
r = main.audio_trouble([worker("me", "Mic", last=T0 + 10), worker("them", "LB", active=False)], T0 + 10, T0)
check("inactive loopback stream: rebuild", r is not None and "stopped" in r and "LB" in r, r)
r = main.audio_trouble([worker("me", "Mic", last=T0 + 10, raises=True)], T0 + 10, T0)
check("is_active() raising (device gone): rebuild", r is not None and "stopped" in r, r)

print("worker thread died")
r = main.audio_trouble([worker("me", "Mic", last=T0 + 10, alive=False)], T0 + 10, T0)
check("exited stream thread: rebuild", r is not None and "exited" in r, r)

print("nothing could be opened")
ws = [worker("me", "Mic", opened=False), worker("them", "LB", opened=False)]
check("right after start: give the devices time", main.audio_trouble(ws, T0 + 5, T0) is None)
r = main.audio_trouble(ws, T0 + STALL + 1, T0)
check("still nothing after the stall window: retry", r is not None and "no audio stream" in r, r)
check("a SKIPped device is ignored while another one works",
      main.audio_trouble([worker("me", "Mic", last=T0 + 40), worker("them", "LB", opened=False, alive=False)], T0 + 40, T0) is None)

print("stream_worker contract")
check("accepts stop + health kwargs (supervisor API)",
      {"stop", "health"} <= set(main.stream_worker.__code__.co_varnames[: main.stream_worker.__code__.co_argcount]))
check("start_audio exists and is what main()/tray call", callable(getattr(main, "start_audio", None)))
check("supervisor constants sane", 0 < main.AUDIO_CHECK_S < main.MIC_STALL_S and main.CLOCK_JUMP_S > main.AUDIO_CHECK_S)
_ = threading  # imported for parity with the real worker tuple shape

print(f"\n{'OK' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
