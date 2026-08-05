"""Speaker labeling for loopback ("them") segments.

Each speech segment gets a 192-dim voice embedding (sherpa-onnx TitaNet-small,
CPU — milliseconds per segment) and is cosine-matched against running cluster
centroids: same voice -> same label ("them-1", "them-2", ...). Labels are
anonymous but stable for the lifetime of the capture process, so the same
voice keeps its label across recording sessions — the hub snapshots centroids
per session and uses voice overlap as a session-relatedness signal.

Names are NOT resolved here; the distill LLM infers them from conversation
context. If the model file is missing this degrades to no-op (label() -> None)
so capture never breaks.
"""
import os

import numpy as np

MODEL_PATH = os.path.join(os.path.dirname(__file__), "models", "nemo_en_titanet_small.onnx")
SAMPLE_RATE = 16000
# Tuned against a played-back YouTube meeting (2026-08): 0.50/1.0s over-segmented
# 5 voices into 7 clusters — short interjections spawned duplicates. Compressed
# call/video audio needs the looser threshold and a longer create/update gate.
SIM_THRESHOLD = 0.45   # cosine similarity to join an existing cluster
MIN_EMBED_S = 2.0      # segments shorter than this match but never create/update clusters
MAX_CLUSTERS = 12      # junk-audio guard (music, sfx spawning voices)


class SpeakerLabeler:
    def __init__(self):
        self.clusters = []  # {id, centroid (unit vec), seconds}
        self._extractor = None
        self._disabled = False

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

    def label(self, audio: np.ndarray):
        """Returns a stable speaker id for this segment, or None if unknown."""
        emb = self._embed(audio)
        if emb is None:
            return None
        dur = len(audio) / SAMPLE_RATE

        best, best_sim = None, -1.0
        for c in self.clusters:
            sim = float(np.dot(emb, c["centroid"]))
            if sim > best_sim:
                best, best_sim = c, sim

        if best is not None and best_sim >= SIM_THRESHOLD:
            if dur >= MIN_EMBED_S:
                # duration-weighted running mean, re-normalized
                w = best["seconds"]
                merged = (best["centroid"] * w + emb * dur) / (w + dur)
                best["centroid"] = merged / np.linalg.norm(merged)
                best["seconds"] = w + dur
            return best["id"]

        if dur < MIN_EMBED_S or len(self.clusters) >= MAX_CLUSTERS:
            return best["id"] if best is not None and best_sim >= SIM_THRESHOLD * 0.8 else None

        cluster = {"id": f"them-{len(self.clusters) + 1}", "centroid": emb, "seconds": dur}
        self.clusters.append(cluster)
        print(f"[speakers] new voice: {cluster['id']}")
        return cluster["id"]

    def snapshot(self):
        """Serializable cluster state for the hub (persisted per session)."""
        return [
            {"id": c["id"], "centroid": [round(float(x), 5) for x in c["centroid"]], "seconds": round(c["seconds"], 1)}
            for c in self.clusters
        ]
