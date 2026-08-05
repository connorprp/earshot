"""Smoke test: verify faster-whisper runs on the GPU (Blackwell / RTX 5080).

Loads the tiny model on CUDA and transcribes 2s of synthetic audio.
Success = no CUDA/cuDNN load errors. Exit code 0 on success.
"""
import cuda_paths  # noqa: F401  (must be first)

import numpy as np
from faster_whisper import WhisperModel

print("Loading tiny model on cuda/float16 ...")
model = WhisperModel("tiny.en", device="cuda", compute_type="float16")

audio = (0.02 * np.sin(2 * np.pi * 220 * np.arange(32000) / 16000)).astype(np.float32)
segments, info = model.transcribe(audio, beam_size=1)
text = " ".join(s.text for s in segments)
print(f"OK: transcribed on GPU (lang={info.language}, text={text!r})")
