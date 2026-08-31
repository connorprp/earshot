"""Echo layer 0 (signal): does raw-audio correlation tell an echo from real talk?

Pure numpy, no sound card, no model:

    python capture/test_echo_signal.py

The scenarios mirror the live failure this layer exists for (open speakers:
the mic re-hears the far end and it transcribes as "me"): a mic segment that
is a delayed, room-filtered, attenuated, noisy copy of the loopback must be
dropped; independent speech at the same moment must pass untouched; the user
talking OVER the speakers must never be dropped outright. Signals are
speech-like (syllabic bursts on a colored-noise carrier) rather than tones so
the envelope correlation is exercised the way real speech exercises it.
"""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import echo_signal as es  # noqa: E402

fails = 0


def check(label, cond, got=""):
    global fails
    print(f"  {'PASS' if cond else 'FAIL'}  {label}")
    if not cond:
        fails += 1
        if got != "":
            print(f"        got: {got}")


RATE = es.RATE
T0 = 1000.0


def speech_like(dur_s, rng):
    """Syllabic bursts modulating colored noise — what matters to the envelope
    correlator is the burst timing, which is what distinguishes two talkers."""
    n = int(dur_s * RATE)
    carrier = np.convolve(rng.standard_normal(n + 128), np.hanning(48), "same")[:n]
    env = np.zeros(n)
    pos = 0
    while pos < n:
        burst = int(rng.uniform(0.12, 0.4) * RATE)
        env[pos:pos + burst] = rng.uniform(0.4, 1.0)
        pos += burst + int(rng.uniform(0.06, 0.3) * RATE)
    env = np.convolve(env, np.hanning(400) / 200.0, "same")
    x = carrier * env
    return (x / (np.abs(x).max() + 1e-9)).astype(np.float32)


def through_room(x, rng, gain=0.35, noise=0.004):
    """Speaker -> room -> mic: a few reflection taps, attenuation, mic noise."""
    ir = np.zeros(int(0.03 * RATE), dtype=np.float32)
    ir[0] = 1.0
    for tap, g in ((80, 0.5), (200, 0.3), (400, 0.15)):
        ir[tap] = g
    y = np.convolve(x, ir)[: len(x)] * gain
    return (y + noise * rng.standard_normal(len(y))).astype(np.float32)


def feed_ref(signal, start=T0, chunk_s=0.1, stream_id=1):
    """Feed a loopback signal in callback-sized chunks with real-ish stamps."""
    step = int(chunk_s * RATE)
    for i in range(0, len(signal), step):
        chunk = signal[i:i + step]
        es.feed(stream_id, chunk, now=start + (i + len(chunk)) / RATE)


def reset():
    with es._lock:
        es._streams.clear()


rng = np.random.default_rng(7)

print("ring assembly (_slice)")
reset()
marked = np.arange(1, RATE + 1, dtype=np.float32) / RATE  # recognizable samples
feed_ref(marked, start=T0)
with es._lock:
    runs = [(r[0], list(r[1]), r[2]) for r in es._streams[1]]
got = es._slice(runs, T0 + 0.25, T0 + 0.5)
want = marked[int(0.25 * RATE): int(0.5 * RATE)]
check("mid-run slice is sample-exact", np.allclose(got, want), float(np.abs(got - want).max()))
got = es._slice(runs, T0 - 0.5, T0 + 0.5)
check("slice before the run start is zero-filled",
      np.allclose(got[: int(0.5 * RATE)], 0.0) and np.allclose(got[int(0.5 * RATE):], marked[: int(0.5 * RATE)]))
reset()
feed_ref(marked[: RATE // 2], start=T0)                      # run 1: [T0, T0+0.5]
feed_ref(marked[: RATE // 2], start=T0 + 2.0)                # gap >> GAP_S: run 2
with es._lock:
    check("a gap starts a second run", len(es._streams[1]) == 2, len(es._streams[1]))
    runs = [(r[0], list(r[1]), r[2]) for r in es._streams[1]]
got = es._slice(runs, T0, T0 + 2.5)
check("the gap between runs reads as silence",
      np.allclose(got[int(0.6 * RATE): int(1.9 * RATE)], 0.0) and not np.allclose(got[: int(0.4 * RATE)], 0.0))

print("pruning")
reset()
feed_ref(speech_like(2.0, rng), start=T0, stream_id=1)
feed_ref(speech_like(2.0, rng), start=T0 + 3 * es.KEEP_S, stream_id=2)
with es._lock:
    check("a stream silent for 2x KEEP_S is forgotten", 1 not in es._streams and 2 in es._streams,
          sorted(es._streams))
reset()
feed_ref(speech_like(2 * es.KEEP_S + 10, rng), start=T0, stream_id=1)
with es._lock:
    total = sum(r[2] for r in es._streams[1])
check("a continuous run is trimmed to KEEP_S-ish", total <= (es.KEEP_S + 1) * RATE, total / RATE)

print("echo is dropped (the open-speakers failure)")
for delay in (0.04, 0.2, 0.5):
    reset()
    far = speech_like(6.0, rng)
    feed_ref(far, start=T0)
    mic = through_room(far, rng)
    verdict, corr = es.judge(mic, T0 + delay, T0 + delay + len(mic) / RATE)
    check(f"room-filtered copy at +{delay}s offset -> drop", verdict == "drop", f"{verdict} corr={corr:.2f}")
reset()
far = speech_like(6.0, rng)
feed_ref(far, start=T0)
mic = through_room(far, rng)
verdict, corr = es.judge(mic, T0 - 0.3, T0 - 0.3 + len(mic) / RATE)
check("mic stamped EARLIER than loopback (buffer skew) -> still drop",
      verdict == "drop", f"{verdict} corr={corr:.2f}")

print("real speech passes")
reset()
far = speech_like(6.0, rng)
feed_ref(far, start=T0)
own = speech_like(6.0, rng)  # independent talker, same moment
verdict, corr = es.judge(own, T0, T0 + len(own) / RATE)
check("independent speech while speakers play -> untouched", verdict == "", f"{verdict} corr={corr:.2f}")
check("...and its corr is well under the evidence bar", corr < es.EVIDENCE_CORR - 0.1, f"{corr:.2f}")

print("double-talk is never dropped outright")
reset()
far = speech_like(6.0, rng)
feed_ref(far, start=T0)
mixed = (0.8 * speech_like(6.0, rng) + through_room(far, rng)).astype(np.float32)
verdict, corr = es.judge(mixed, T0, T0 + len(mixed) / RATE)
check("user talking over the speakers -> not a drop", verdict != "drop", f"{verdict} corr={corr:.2f}")

print("hands off when there's nothing to judge")
reset()
verdict, corr = es.judge(speech_like(4.0, rng), T0, T0 + 4.0)
check("no loopback audio at all -> ('', 0)", verdict == "" and corr == 0.0, (verdict, corr))
reset()
feed_ref((1e-5 * rng.standard_normal(6 * RATE)).astype(np.float32), start=T0)
verdict, corr = es.judge(speech_like(4.0, rng), T0, T0 + 4.0)
check("near-silent loopback -> ('', 0)", verdict == "" and corr == 0.0, (verdict, corr))
reset()
far = speech_like(6.0, rng)
feed_ref(far, start=T0)
verdict, _ = es.judge(through_room(far, rng)[: int(0.3 * RATE)], T0, T0 + 0.3)
check("segment too short to judge -> hands off (timing gate's job)", verdict == "", verdict)

print("kill switch")
reset()
far = speech_like(6.0, rng)
feed_ref(far, start=T0)
saved, es.MODE = es.MODE, "off"
try:
    verdict, corr = es.judge(through_room(far, rng), T0, T0 + 6.0)
    check("EARSHOT_MIC_GATE=off disables layer 0 too", verdict == "" and corr == 0.0, (verdict, corr))
finally:
    es.MODE = saved

print("constants sane")
check("evidence bar below drop bar", 0 < es.EVIDENCE_CORR < es.DROP_CORR < 1)
check("history covers a max segment + lag search", es.KEEP_S > 15.0 + 2 * es.MAX_LAG_S)

print(f"\n{'OK' if not fails else f'{fails} FAILED'}")
sys.exit(1 if fails else 0)
