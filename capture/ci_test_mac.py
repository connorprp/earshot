"""Capture-pipeline tests for macOS CI (GitHub Actions runners = real Apple
hardware, no audio devices). Verifies everything except live device streams:
imports/wheels, echo gate, speaker clustering, segmenter mechanics, and real
Whisper ASR using speech synthesized with the built-in `say` command.
"""
import os
import subprocess
import sys
import time
import wave

import numpy as np

os.environ.setdefault("EARSHOT_DEVICE", "cpu")
os.environ.setdefault("EARSHOT_MODEL", "tiny.en")

PASS = 0

def ok(label):
    global PASS
    PASS += 1
    print(f"  PASS  {label}")


# ---- 1. imports / wheel availability on macOS ----
import sounddevice as sd  # noqa: E402

print("devices visible to runner:", len(sd.query_devices()))
import mac_audio  # noqa: E402, F401
import echo_gate as eg  # noqa: E402
from speakers import SpeakerLabeler  # noqa: E402
from main import Segmenter, asr_queue  # noqa: E402

ok("all capture modules import on macOS")

# ---- 2. echo gate ----
now = time.time()
eg.note_speech_start("lb", now - 10)
eg.note_speech_end("lb", now - 10, now - 0.5)
eg.note_them_text(now - 8, "No Zoe Balamesi cannot make it shes struggling with some personal issues")
assert eg.loopback_overlap(now - 6, now - 3) > 0.95
assert not eg.gate_engaged(), "gate must stay off before evidence (headphones safety)"
m = eg.mic_text_match(now - 7.5, "Anyone else? No, Joey Ballamweasy cant make it, shes struggling with some personal issue")
assert m >= eg.EVIDENCE_MATCH, f"garbled echo should match, got {m:.2f}"
eg.record_hit(); eg.record_hit()
assert eg.gate_engaged()
assert eg.loopback_overlap(now + 5, now + 8) < 0.1
ok("echo gate: evidence, engagement, overlap math")

# ---- 3. real ASR via `say` (Apple TTS) -> faster-whisper ----
PHRASE = "the quarterly report is due next thursday afternoon"
subprocess.run(["say", "-o", "/tmp/speech.aiff", PHRASE], check=True)
subprocess.run(
    ["afconvert", "/tmp/speech.aiff", "-o", "/tmp/speech.wav", "-d", "LEI16@16000", "-c", "1", "-f", "WAVE"],
    check=True,
)
with wave.open("/tmp/speech.wav", "rb") as w:
    audio = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
print(f"synthesized {len(audio)/16000:.1f}s of speech")

from faster_whisper import WhisperModel  # noqa: E402
model = WhisperModel(os.environ["EARSHOT_MODEL"], device="cpu", compute_type="int8")
segments, _ = model.transcribe(audio, language="en", beam_size=1, vad_filter=True)
text = " ".join(s.text.strip() for s in segments).lower()
print("whisper heard:", repr(text))
assert "quarterly" in text and "thursday" in text, f"ASR failed: {text!r}"
ok("faster-whisper transcribes Apple TTS speech on macOS CPU")

# ---- 4. speaker embeddings + clustering (real synthesized voices) ----
if not os.path.exists(os.path.join(os.path.dirname(__file__), "models", "nemo_en_titanet_small.onnx")):
    print("  SKIP  speaker model not downloaded")
else:
    lab = SpeakerLabeler(store="")  # store="" : never touch the real app-data voiceprint
    # two genuinely different Apple voices saying the same thing
    clips = {}
    for name, voice in [("a", "Samantha"), ("b", "Daniel")]:
        subprocess.run(["say", "-v", voice, "-o", f"/tmp/v{name}.aiff", PHRASE], check=True)
        subprocess.run(
            ["afconvert", f"/tmp/v{name}.aiff", "-o", f"/tmp/v{name}.wav", "-d", "LEI16@16000", "-c", "1", "-f", "WAVE"],
            check=True,
        )
        with wave.open(f"/tmp/v{name}.wav", "rb") as w:
            clips[name] = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    a1 = lab.label(clips["a"])
    b1 = lab.label(clips["b"])
    a2 = lab.label(clips["a"])
    print(f"voice A -> {a1}, voice B -> {b1}, voice A again -> {a2}")
    assert a1 == a2, "same voice must keep its label"
    assert a1 != b1, "different voices must get different labels"
    ok("speaker clustering separates two real synthesized voices")

    # ...and the same two voices sharing the MIC (speakerphone, someone in the
    # room): the one the mic hears most becomes the owner, the other a
    # participant. Same real embeddings, mic side. test_speakers.py covers the
    # election's edges with a fake extractor.
    import speakers as sp
    clip_s = len(clips["a"]) / 16000
    if clip_s < sp.MIN_EMBED_S:
        print(f"  SKIP  TTS clip too short ({clip_s:.1f}s) to accumulate cluster time")
    else:
        mic = SpeakerLabeler(store="")
        for _ in range(int(sp.OWNER_MIN_S / clip_s) + 2):
            me = mic.label(clips["a"], "me")
        other = mic.label(clips["b"], "me")
        print(f"mic owner -> {me}, other mic voice -> {other}")
        assert me == "me", f"the dominant mic voice must be the owner, got {me}"
        assert other and other.startswith("them-"), f"a second mic voice must be a participant, got {other}"
        ok("two people on one mic are told apart (owner + participant)")

# ---- 5. segmenter mechanics ----
seg = Segmenter("them")
chunk = int(16000 * 0.1)
for i in range(0, len(audio), chunk):
    seg.feed(audio[i : i + chunk])
seg.feed(np.zeros(16000, dtype=np.float32))  # 1s silence closes the segment
src, seg_audio, ts = asr_queue.get_nowait()
assert src == "them" and len(seg_audio) > 16000
ok("segmenter emits speech segments on silence")

print(f"\nALL {PASS} TEST GROUPS PASSED")
