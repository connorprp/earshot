"""Owner election + voiceprint persistence in speakers.py.

Runs without the embedding model (or any audio hardware): _embed is replaced by
a deterministic fake, so the test exercises the CLUSTERING and OWNER logic —
who gets called "me" when two people share the microphone — not the ONNX model,
which ci_test_mac.py already covers against real synthesized voices.
"""
import json
import os
import sys
import tempfile

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from speakers import SAMPLE_RATE, SpeakerLabeler  # noqa: E402

DIM = 64  # comfortably over the 32-float sanity floor in _load_owner
ok_count = 0


def ok(msg):
    global ok_count
    ok_count += 1
    print(f"  PASS  {msg}")


class Fake(SpeakerLabeler):
    """Voices are orthogonal unit vectors picked by the segment's sample value:
    the same voice always matches itself, different voices never match."""

    def _embed(self, audio):
        return _vec(int(round(float(audio[0]) * 100)))


def _vec(k):
    v = np.zeros(DIM, dtype=np.float32)
    v[k] = 1.0
    return v


def seg(voice, seconds):
    return np.full(int(SAMPLE_RATE * seconds), voice / 100.0, dtype=np.float32)


def talk(lab, voice, source, seconds, times=1):
    out = None
    for _ in range(times):
        out = lab.label(seg(voice, seconds), source)
    return out


# ---- 1. solo mic user: unchanged from the old "mic = you" behavior ----
lab = Fake(store="")
assert talk(lab, 1, "me", 3.0) == "me"
assert talk(lab, 1, "me", 3.0, times=10) == "me"
assert lab.snapshot()[0]["id"] == "me"
ok("one voice on the mic is always 'me'")

# ---- 2. two people on the mic: the dominant voice is the owner ----
lab = Fake(store="")
talk(lab, 1, "me", 3.0, times=6)   # 18s of the owner
assert talk(lab, 2, "me", 3.0, times=2) == "them-1"
assert talk(lab, 1, "me", 3.0) == "me"
ok("a second voice on the mic gets its own them-N label")

# ---- 3. the election corrects a wrong provisional owner ----
lab = Fake(store="")
assert talk(lab, 2, "me", 3.0) == "me"          # spoke first: provisionally the owner
talk(lab, 1, "me", 3.0, times=6)                # the real owner out-talks them
assert talk(lab, 1, "me", 3.0) == "me", "owner should have moved to the dominant voice"
demoted = talk(lab, 2, "me", 3.0)
# the tag NUMBER is whatever was free (the new owner's old them-N is retired,
# so the numbering can have a gap) — what matters is that it is a participant
assert demoted.startswith("them-"), f"the demoted voice becomes a participant, got {demoted}"
assert lab.rev > 0, "a label-set change must be visible so a fresh snapshot ships"
ok("owner election corrects the first-voice guess")

# ---- 4. a loopback voice is never elected owner, mic bleed and all ----
lab = Fake(store="")
talk(lab, 5, "them", 3.0, times=10)             # 30s of call audio
remote = talk(lab, 5, "me", 3.0, times=2)       # 6s of it echoing into the mic
assert remote == "them-1", f"loopback voice should stay them-N, got {remote}"
assert lab.owner is None, "a loopback-dominant voice must not become 'me'"
assert lab.is_loopback_voice("them-1") is True
assert lab.is_loopback_voice("me") is False
assert lab.is_loopback_voice("them-9") is False  # unknown label
ok("loopback voices stay participants and read as echo evidence")

# ---- 5. the owner voiceprint survives a restart ----
with tempfile.TemporaryDirectory() as tmp:
    store = os.path.join(tmp, "sub", "voice-me.json")
    lab = Fake(store=store)
    talk(lab, 1, "me", 3.0, times=31)           # past OWNER_LOCK_S -> locked + saved
    assert lab.owner_locked is True
    assert os.path.exists(store), "a settled owner voice must be written to disk"
    saved = json.loads(open(store).read())
    assert len(saved["centroid"]) == DIM and saved["seconds"] >= 90

    # a session two people nearly split is NOT memorized: the label holds for
    # this process (no renumbering mid-conversation) but nothing is written, so
    # the next run elects again instead of inheriting a coin flip
    split_store = os.path.join(tmp, "split", "voice-me.json")
    split = Fake(store=split_store)
    for _ in range(31):
        split.label(seg(1, 3.0), "me")   # 93s
        split.label(seg(2, 2.0), "me")   # 62s — over the 1.5x bar, under 2x
    assert split.label(seg(1, 3.0), "me") == "me"
    assert split.label(seg(2, 2.0), "me").startswith("them-")
    assert not os.path.exists(split_store), "an ambiguous owner must not be written to disk"
    ok("an ambiguous session keeps a stable label but is never memorized")

    fresh = Fake(store=store)
    assert fresh.owner_locked is True
    assert talk(fresh, 1, "me", 3.0) == "me", "the remembered voice is 'me' from line one"
    assert talk(fresh, 3, "me", 3.0, times=6) == "them-1", "a new mic voice is someone else"
    assert talk(fresh, 1, "me", 3.0) == "me", "and cannot take the owner's label"
    ok("owner voiceprint persists, so 'me' is right from the first line")

    # a print from another embedding model is meaningless — ignore, don't crash
    with open(store, "w") as f:
        json.dump({"centroid": [0.0] * DIM, "seconds": 120, "model": "some-other-model.onnx"}, f)
    assert Fake(store=store).owner is None
    with open(store, "w") as f:
        f.write("{not json")
    assert Fake(store=store).owner is None
    ok("a stale or corrupt voiceprint file degrades to electing from scratch")

print(f"\n{ok_count} checks passed")
