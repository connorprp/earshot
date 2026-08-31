"""Echo suppression, layer 0 (signal): is this mic segment a copy of what the
speakers were playing?

The loopback stream IS the reference signal — capture already holds the exact
audio the speakers rendered. Layers 1-3 only ever compared metadata (speech
timing, transcript text, voice identity); this layer compares the audio itself.
A short rolling buffer of raw loopback samples is kept per render stream, and
each mic segment is scored against the loopback audio from the same wall-clock
window: a mic segment that is a delayed, room-filtered, ASR-garbling copy of
the loopback still moves with the loopback's spectral envelope, so banded
log-energy correlation (searched over ±MAX_LAG_S of clock/buffer offset)
identifies an echo BEFORE any ASR — no text-evidence warm-up, from the first
sentence of a session, and in groq mode before the audio is ever uploaded.

Headphone users are safe by construction: their mic never hears the loopback,
nothing correlates, nothing is dropped — this layer needs no auto-engagement
heuristic the way the timing gate (layer 1) does. Double-talk is protected by
an excess-energy check: a mic segment with speech energy where the aligned
loopback is quiet (the user talking over the far end) is never dropped
outright, only reported as evidence.

    judge(mic, start, end) -> ("drop", corr)      clear echo: drop pre-ASR
                              ("evidence", corr)  correlated: arm the timing gate
                              ("", corr)          unrelated / can't tell

EARSHOT_MIC_GATE=off disables this layer too (one kill switch for all capture
echo handling); EARSHOT_ECHO_CORR overrides the drop threshold for live
retuning — the caller prints every verdict, so a bad fit shows in capture.log.
"""
import os
import threading
import time

import numpy as np

MODE = os.environ.get("EARSHOT_MIC_GATE", "auto").lower()

RATE = 16000
WIN = 512            # 32 ms analysis window
HOP = 256            # 16 ms hop
BANDS = 8            # log-spaced envelope bands across 150-6500 Hz (speech)
MAX_LAG_S = 0.75     # clock/buffer offset searched between mic and loopback
KEEP_S = 30.0        # loopback history: MAX_SEGMENT_S + lag margin + ASR backlog
GAP_S = 0.35         # loopback callbacks further apart than this start a new run
                     # (WASAPI loopback delivers NOTHING while nothing renders)
MIN_FRAMES = 30      # mic segments shorter than ~0.5 s can't be judged here
                     # (the timing gate still covers them once armed)
DROP_CORR = float(os.environ.get("EARSHOT_ECHO_CORR", "0.72"))
EVIDENCE_CORR = 0.55
EXCESS_KEEP = 0.35   # this much mic speech where loopback is quiet = real talk
REF_SILENT_RMS = 3e-4

_lock = threading.Lock()
# stream id -> runs of contiguous audio, newest last: [end_ts, [chunks], n_samples].
# A run shares ONE wall-clock anchor (its latest callback), so per-callback
# timestamp jitter can't smear the assembled signal mid-run.
_streams: dict[int, list] = {}
_window = np.hanning(WIN).astype(np.float32)
_band_slices: list[tuple[int, int]] | None = None


def feed(stream_id: int, chunk: np.ndarray, now: float | None = None):
    """Raw loopback tap (mono float32 @16k), called for every callback chunk."""
    now = time.time() if now is None else now
    with _lock:
        runs = _streams.setdefault(stream_id, [])
        if runs and now - runs[-1][0] <= GAP_S:
            run = runs[-1]
            run[0] = now
            run[1].append(chunk)
            run[2] += len(chunk)
        else:
            runs.append([now, [chunk], len(chunk)])
        # bound memory: drop runs that ended too long ago, trim a continuous
        # run from the FRONT (its anchor is the end, so the front is oldest)
        while len(runs) > 1 and runs[0][0] < now - KEEP_S:
            runs.pop(0)
        max_n = int(KEEP_S * RATE)
        while runs[0][2] > max_n and len(runs[0][1]) > 1:
            runs[0][2] -= len(runs[0][1].pop(0))
        for sid in [s for s, rs in _streams.items() if s != stream_id and (not rs or rs[-1][0] < now - 2 * KEEP_S)]:
            del _streams[sid]


def judge(mic: np.ndarray, start_ts: float, end_ts: float) -> tuple[str, float]:
    """Score a mic segment against every loopback stream's recent raw audio."""
    if MODE == "off":
        return "", 0.0
    with _lock:
        snapshots = [[(r[0], list(r[1]), r[2]) for r in runs] for runs in _streams.values() if runs]
    if not snapshots:
        return "", 0.0
    env = _envelope(mic)
    if env is None or env[0].shape[0] < MIN_FRAMES:
        return "", 0.0
    best, best_excess = 0.0, 1.0
    for runs in snapshots:
        ref = _slice(runs, start_ts - MAX_LAG_S, end_ts + MAX_LAG_S)
        if float(np.sqrt(np.mean(ref**2))) < REF_SILENT_RMS:
            continue  # this device wasn't playing anything — no echo possible
        renv = _envelope(ref)
        if renv is None:
            continue
        corr, excess = _score(env, renv)
        if corr > best:
            best, best_excess = corr, excess
    if best >= DROP_CORR and best_excess < EXCESS_KEEP:
        return "drop", best
    if best >= EVIDENCE_CORR:
        return "evidence", best
    return "", best


def _slice(runs: list, start: float, end: float) -> np.ndarray:
    """Loopback samples covering wall-clock [start, end], zero-filled where the
    device delivered nothing (loopback legitimately idles between renders)."""
    out = np.zeros(int(round((end - start) * RATE)), dtype=np.float32)
    for end_ts, chunks, n in runs:
        run_start = end_ts - n / RATE
        if end_ts <= start or run_start >= end:
            continue
        audio = np.concatenate(chunks)
        o0 = max(0, int(round((run_start - start) * RATE)))
        r0 = max(0, int(round((start - run_start) * RATE)))
        ln = min(len(out) - o0, n - r0)
        if ln > 0:
            out[o0:o0 + ln] = audio[r0:r0 + ln]
    return out


def _bands() -> list[tuple[int, int]]:
    global _band_slices
    if _band_slices is None:
        edges = np.geomspace(150.0, 6500.0, BANDS + 1)
        bins = np.fft.rfftfreq(WIN, 1.0 / RATE)
        _band_slices = []
        for lo, hi in zip(edges[:-1], edges[1:]):
            a = int(np.searchsorted(bins, lo))
            _band_slices.append((a, max(a + 1, int(np.searchsorted(bins, hi)))))
    return _band_slices


def _envelope(x: np.ndarray) -> tuple[np.ndarray, np.ndarray] | None:
    """(band log-energies [frames, BANDS], full-band log-energy [frames])."""
    if len(x) < WIN:
        return None
    frames = np.lib.stride_tricks.sliding_window_view(x, WIN)[::HOP] * _window
    mag2 = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    bands = np.log1p(np.stack([mag2[:, a:b].sum(axis=1) for a, b in _bands()], axis=1) * 1e4)
    return bands, np.log1p(mag2.sum(axis=1) * 1e4)


def _score(mic_env, ref_env) -> tuple[float, float]:
    """Best-lag banded envelope correlation, plus the excess fraction there
    (mic frames with speech energy while the aligned loopback frame is quiet —
    that's the user actually talking, not the speakers)."""
    m_bands, m_full = mic_env
    r_bands, r_full = ref_env
    T = m_bands.shape[0]
    n_lags = r_bands.shape[0] - T + 1
    if n_lags < 1:
        return 0.0, 1.0
    mstd = m_bands.std(axis=0)
    w = mstd / (mstd.sum() + 1e-9)  # bands where the mic has action decide
    mz = (m_bands - m_bands.mean(axis=0)) / (mstd + 1e-6)
    best, best_lag = 0.0, 0
    for lag in range(n_lags):
        r = r_bands[lag:lag + T]
        c = (mz * (r - r.mean(axis=0))).sum(axis=0) / (T * (r.std(axis=0) + 1e-6))
        s = float((c * w).sum())
        if s > best:
            best, best_lag = s, lag
    def active(e):
        lo, hi = float(e.min()), float(e.max())
        return e > lo + 0.25 * (hi - lo)
    mic_on = active(m_full)
    ref_on = active(r_full[best_lag:best_lag + T])
    excess = float((mic_on & ~ref_on).sum()) / max(1, int(mic_on.sum()))
    return best, excess
