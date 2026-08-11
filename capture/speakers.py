"""Speaker labeling for both captured channels.

Each speech segment gets a 192-dim voice embedding (sherpa-onnx TitaNet-small,
CPU — milliseconds per segment) and is cosine-matched against running cluster
centroids: same voice -> same label. Labels are anonymous but stable for the
lifetime of the capture process, so the same voice keeps its label across
recording sessions — the hub snapshots centroids per session and uses voice
overlap as a session-relatedness signal.

The MIC is clustered too (2026-08-07), because the mic is not one person: a
phone call on speakerphone, a coworker at the desk, anyone in the room — they
all arrive on the same stream as the owner and used to be labeled "You"
wholesale. So exactly one cluster is the device OWNER, labeled "me", and
everyone else is "them-N" on whichever channel they arrive.

Electing the owner: the first voice heard on the mic is provisionally it (with
one person at the mic that reproduces the old "mic = you" assumption exactly),
and the election below can correct that while the evidence is still thin — the
owner is the voice the mic hears MOST, and hears far more than the loopback
does. Once settled, the centroid is written to disk, so the election only ever
has to happen once per machine and "me" is right from the first line afterward.

Names are NOT resolved here; the distill LLM infers them from conversation
context. If the model file is missing this degrades to no-op (label() -> None)
so capture never breaks.
"""
import json
import os
import sys
from pathlib import Path

import numpy as np

MODEL_PATH = os.environ.get(
    "EARSHOT_SPEAKER_MODEL",
    os.path.join(os.path.dirname(__file__), "models", "nemo_en_titanet_small.onnx"),
)
SAMPLE_RATE = 16000
# Tuned against a played-back YouTube meeting (2026-08): 0.50/1.0s over-segmented
# 5 voices into 7 clusters — short interjections spawned duplicates. Compressed
# call/video audio needs the looser threshold and a longer create/update gate.
SIM_THRESHOLD = 0.45   # cosine similarity to join an existing cluster
MIN_EMBED_S = 2.0      # segments shorter than this match but never create/update clusters
MAX_CLUSTERS = 12      # junk-audio guard (music, sfx spawning voices)

# Owner election, mic side only.
OWNER_MIN_S = 12.0      # mic seconds a candidate needs before it can be elected
OWNER_MARGIN = 1.5      # the winner needs this much more mic time than the runner-up
OWNER_MIC_RATIO = 2.0   # ...and must be mostly mic, not loopback bleeding into it
OWNER_LOCK_S = 90.0     # mic seconds after which ownership stops moving (and is saved)


def _store_path() -> str:
    """Where the owner voiceprint lives — the platform app-data dir, next to
    the tray app's other state."""
    if os.environ.get("EARSHOT_VOICE_STORE"):
        return os.environ["EARSHOT_VOICE_STORE"]
    if sys.platform == "win32":
        base = os.environ.get("APPDATA", os.path.expanduser("~"))
        return os.path.join(base, "Earshot", "voice-me.json")
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Application Support/Earshot/voice-me.json")
    return os.path.expanduser("~/.earshot/voice-me.json")


class SpeakerLabeler:
    def __init__(self, store=None):
        """store: path for the remembered owner voiceprint. None = platform
        default; "" (any falsy value) = don't persist, used by tests."""
        self.clusters = []  # {tag, centroid (unit vec), seconds, mic_s, loop_s}
        self.owner = None   # the cluster labeled "me"
        self.owner_locked = False
        self.store = _store_path() if store is None else store
        self.rev = 0        # bumped when the label set changes (new voice, owner moved)
        self._tags = 0
        self._saved_s = 0.0
        self._extractor = None
        self._disabled = False
        self._load_owner()

    # ---- model ----
    def _ensure_model(self):
        if self._extractor or self._disabled:
            return self._extractor
        try:
            import sherpa_onnx
            cfg = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=MODEL_PATH, num_threads=2)
            self._extractor = sherpa_onnx.SpeakerEmbeddingExtractor(cfg)
            print("[speakers] embedding model ready")
        except Exception as e:
            print(f"[speakers] DISABLED ({e}) — transcripts will have no speaker labels")
            self._disabled = True
        return self._extractor

    def _embed(self, audio: np.ndarray):
        ex = self._ensure_model()
        if not ex:
            return None
        stream = ex.create_stream()
        stream.accept_waveform(SAMPLE_RATE, audio)
        stream.input_finished()
        emb = np.array(ex.compute(stream), dtype=np.float32)
        norm = np.linalg.norm(emb)
        return emb / norm if norm > 0 else None

    # ---- labeling ----
    def label(self, audio: np.ndarray, source: str = "them"):
        """Identity for this segment: "me" (the device owner's own voice) or a
        stable "them-N", or None when the voice can't be placed."""
        emb = self._embed(audio)
        if emb is None:
            return None
        dur = len(audio) / SAMPLE_RATE
        mic = source == "me"

        best, best_sim = None, -1.0
        for c in self.clusters:
            sim = float(np.dot(emb, c["centroid"]))
            if sim > best_sim:
                best, best_sim = c, sim

        if best is not None and best_sim >= SIM_THRESHOLD:
            if dur >= MIN_EMBED_S:
                self._absorb(best, emb, dur, mic)
                if mic:
                    self._elect_owner()
            return self._label_of(best)

        if dur < MIN_EMBED_S or len(self.clusters) >= MAX_CLUSTERS:
            # too short (or too many voices already) to trust with a cluster of
            # its own: take a looser match, else admit we don't know
            if best is not None and best_sim >= SIM_THRESHOLD * 0.8:
                return self._label_of(best)
            return None

        c = {
            "tag": None,
            "centroid": emb,
            "seconds": dur,
            "mic_s": dur if mic else 0.0,
            "loop_s": 0.0 if mic else dur,
        }
        self.clusters.append(c)
        if mic and self.owner is None:
            self.owner = c
            print("[speakers] owner voice = first voice on the mic (provisional)")
        return self._label_of(c)

    def is_loopback_voice(self, label) -> bool:
        """True when this voice is one we mostly know from the loopback stream.
        A MIC segment matching it is room echo of the call, or someone talking
        on both channels — echo evidence, never proof on its own."""
        c = self._cluster_for(label)
        return bool(c) and c is not self.owner and c["loop_s"] >= 2.0 and c["loop_s"] > c["mic_s"] * 2

    def snapshot(self):
        """Serializable cluster state for the hub (persisted per session)."""
        return [
            {
                "id": self._label_of(c),
                "centroid": [round(float(x), 5) for x in c["centroid"]],
                "seconds": round(c["seconds"], 1),
            }
            for c in self.clusters
        ]

    # ---- internals ----
    def _label_of(self, c):
        if c is self.owner:
            return "me"
        if not c.get("tag"):
            self._tags += 1
            self.rev += 1
            c["tag"] = f"them-{self._tags}"
            print(f"[speakers] new voice: {c['tag']}")
        return c["tag"]

    def _cluster_for(self, label):
        if label == "me":
            return self.owner
        return next((c for c in self.clusters if c.get("tag") == label), None)

    def _absorb(self, c, emb, dur, mic):
        # duration-weighted running mean, re-normalized
        w = c["seconds"]
        merged = (c["centroid"] * w + emb * dur) / (w + dur)
        c["centroid"] = merged / np.linalg.norm(merged)
        c["seconds"] = w + dur
        c["mic_s" if mic else "loop_s"] += dur

    def _elect_owner(self):
        """Move "me" onto the mic-dominant voice with the most mic speech, while
        the provisional guess is still cheap to change. Locks once that voice is
        established (so a long conversation can never renumber people halfway
        through), and remembers it on disk only if it won clearly."""
        if self.owner_locked:
            return
        cands = [
            c for c in self.clusters
            if c["mic_s"] >= OWNER_MIN_S and c["mic_s"] >= c["loop_s"] * OWNER_MIC_RATIO
        ]
        if not cands:
            return
        cands.sort(key=lambda c: c["mic_s"], reverse=True)
        top = cands[0]
        if len(cands) > 1 and top["mic_s"] < cands[1]["mic_s"] * OWNER_MARGIN:
            return  # too close to call; leave the provisional owner alone
        if top is not self.owner:
            old = self.owner
            self.owner = top
            self.rev += 1
            # lines already sent this session keep the label they went out with
            # (and the new owner's old them-N tag is retired, leaving a gap in
            # the numbering); the saved voiceprint means a machine only ever
            # pays that once
            if old is None:
                print("[speakers] owner voice elected")
            else:
                print(f"[speakers] owner voice corrected — what was 'me' is now {self._label_of(old)}")
        if top["mic_s"] >= OWNER_LOCK_S:
            # locked for this process either way: renumbering people halfway
            # through a conversation is worse than a label that stays put
            self.owner_locked = True
            # ...but only MEMORIZE a clear winner. A print learned from a
            # session where two people split the mic would be wrong on every
            # later run too; without a file, the next run just elects again.
            runner_up = cands[1]["mic_s"] if len(cands) > 1 else 0.0
            if top["mic_s"] >= runner_up * 2:
                self._save_owner()
            else:
                print(f"[speakers] owner voice not saved — {top['mic_s']:.0f}s vs "
                      f"{runner_up:.0f}s on the mic is too close to memorize")

    def _load_owner(self):
        """A remembered voiceprint makes "me" correct from the very first line."""
        if not self.store:
            return
        try:
            with open(self.store) as f:
                data = json.load(f)
            if data.get("model") and data["model"] != os.path.basename(MODEL_PATH):
                print("[speakers] stored voiceprint is from another embedding model — ignoring")
                return
            emb = np.array(data["centroid"], dtype=np.float32)
            norm = float(np.linalg.norm(emb))
            if emb.size < 32 or norm == 0:
                return
            seconds = min(float(data.get("seconds") or 60.0), 600.0)  # capped: keeps adapting
            c = {"tag": None, "centroid": emb / norm, "seconds": seconds, "mic_s": seconds, "loop_s": 0.0}
            self.clusters.append(c)
            self.owner = c
            self.owner_locked = True
            self._saved_s = seconds
            # the path is logged on purpose: deleting this file is how a wrong
            # owner (new mic, someone else's print) gets re-elected from scratch
            print(f"[speakers] owner voiceprint loaded ({seconds:.0f}s) from {self.store}")
        except FileNotFoundError:
            pass
        except Exception as e:
            print(f"[speakers] stored voiceprint unreadable ({e}) — electing from this session")

    def _save_owner(self):
        if not self.store or not self.owner:
            return
        try:
            path = Path(self.store)
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps({
                "centroid": [round(float(x), 5) for x in self.owner["centroid"]],
                "seconds": round(self.owner["seconds"], 1),
                "model": os.path.basename(MODEL_PATH),
            }))
            tmp.replace(path)
            self._saved_s = self.owner["seconds"]
            print(f"[speakers] owner voiceprint saved ({self.owner['seconds']:.0f}s of voice)")
        except Exception as e:
            print(f"[speakers] could not save owner voiceprint ({e})")
