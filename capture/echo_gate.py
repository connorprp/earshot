"""Mic echo gate for open-speaker use.

On open speakers the mic re-hears loopback audio, producing "me" transcript
lines that are garbled copies of "them" lines. Text matching alone can't catch
these (analysis of a real captured session: mic-path Whisper garbles echoes so
badly that only ~60% fuzzy-match their loopback twin) — but TIMING can: capture
knows exactly when loopback speech is playing, and a mic segment that lies
almost entirely inside active loopback speech is echo no matter how it
transcribed.

Because a headphones user's real interjections ALSO overlap loopback speech,
the timing gate only engages once there is text-level echo evidence (mic lines
that fuzzy-match recent loopback lines). Headphones -> no text echoes -> gate
stays off and interjections pass. Speakers -> evidence within the first
exchanges -> overlapping mic segments are dropped before they reach the GPU.

    EARSHOT_MIC_GATE = auto (default) | on (always gate) | off (never gate)
"""
import os
import re
import threading
import time

MODE = os.environ.get("EARSHOT_MIC_GATE", "auto").lower()
GATE_OVERLAP = 0.6       # mic segment covered this much by loopback speech = droppable
EVIDENCE_MATCH = 0.55    # fuzzy token overlap with a recent loopback line = echo evidence
EVIDENCE_MIN = 2         # hits within EVIDENCE_WINDOW_S to engage the timing gate
EVIDENCE_WINDOW_S = 120.0
TEXT_WINDOW_S = 25.0     # loopback lines this close in time are echo candidates
KEEP_S = 90.0

_lock = threading.Lock()
_speech = []       # closed loopback speech intervals [(start, end)]
_open = {}         # segmenter id -> start ts of loopback speech in progress
_them_texts = []   # (segment start ts, token list) of recent loopback transcripts
_hits = []         # wall-clock times of text-confirmed mic echoes


def note_speech_start(seg_id, ts):
    with _lock:
        _open[seg_id] = ts


def note_speech_end(seg_id, start, end):
    now = time.time()
    with _lock:
        _open.pop(seg_id, None)
        _speech.append((start, end))
        _speech[:] = [iv for iv in _speech if iv[1] > now - KEEP_S]


def note_them_text(ts, text):
    now = time.time()
    with _lock:
        _them_texts.append((ts, _tokens(text)))
        _them_texts[:] = [t for t in _them_texts if t[0] > now - KEEP_S]


def loopback_overlap(start, end):
    """Fraction of [start, end] covered by loopback speech (closed + in-progress)."""
    now = time.time()
    with _lock:
        ivs = [iv for iv in _speech if iv[1] > start] + [(s, now) for s in _open.values()]
    covered = sum(max(0.0, min(end, e) - max(start, s)) for s, e in ivs)
    return min(1.0, covered / max(0.001, end - start))


def gate_engaged():
    if MODE == "off":
        return False
    if MODE == "on":
        return True
    now = time.time()
    with _lock:
        _hits[:] = [t for t in _hits if now - t < EVIDENCE_WINDOW_S]
        return len(_hits) >= EVIDENCE_MIN


def mic_text_match(ts, text):
    """Best fuzzy overlap between a mic line and recent loopback lines."""
    mine = _tokens(text)
    if len(mine) < 2:
        return 0.0
    with _lock:
        candidates = [toks for (t0, toks) in _them_texts if abs(ts - t0) < TEXT_WINDOW_S]
    best = 0.0
    for theirs in candidates:
        hits = sum(1 for w in mine if _fuzzy_in(w, theirs))
        best = max(best, hits / len(mine))
    return best


def record_hit():
    with _lock:
        _hits.append(time.time())


def _tokens(text):
    return [w for w in re.sub(r"[^a-z0-9' ]+", " ", text.lower()).split() if w]


def _fuzzy_in(word, words):
    # exact, or shared 4-char prefix (Whisper garbles word tails most)
    if word in words:
        return True
    if len(word) >= 4:
        p = word[:4]
        return any(len(v) >= 4 and (v.startswith(p) or word.startswith(v[:4])) for v in words)
    return False
