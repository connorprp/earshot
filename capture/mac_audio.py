"""macOS audio backend (UNTESTED on real hardware — verify on a Mac).

Windows gets loopback for free via WASAPI; macOS has no equivalent before the
CoreAudio process-tap API (14.4+, needs a SIGNED app), so system audio ("them")
comes through BlackHole, a free virtual output device — installed for the user
by mac_blackhole.py, no donation form. The user plays call/video audio to a
Multi-Output Device (real speakers + BlackHole) and we record BlackHole's
input side.

  mic  ("me")   -> default input device via sounddevice
  them          -> the BlackHole input device, if present (mic-only otherwise)

Feeds the same Segmenter pipeline as the Windows path: mono float32 @ 16k.
"""
import numpy as np
import sounddevice as sd
import soxr

TARGET_RATE = 16000


def find_blackhole():
    for idx, dev in enumerate(sd.query_devices()):
        if "blackhole" in dev["name"].lower() and dev["max_input_channels"] > 0:
            return idx, dev
    return None, None


def start_streams(make_segmenter):
    """Opens mic + BlackHole input streams; returns them (keep a reference)."""
    streams = []

    def open_stream(source, device_index, info):
        seg = make_segmenter(source)
        rate = int(info["default_samplerate"])
        channels = min(2, max(1, int(info["max_input_channels"])))

        def cb(indata, frames, time_info, status):
            pcm = indata.mean(axis=1) if indata.shape[1] > 1 else indata[:, 0]
            if rate != TARGET_RATE:
                pcm = soxr.resample(pcm, rate, TARGET_RATE)
            seg.feed(np.ascontiguousarray(pcm, dtype=np.float32))

        stream = sd.InputStream(
            device=device_index,
            channels=channels,
            samplerate=rate,
            blocksize=int(rate * 0.1),
            dtype="float32",
            callback=cb,
        )
        stream.start()
        streams.append(stream)
        print(f"[capture] {source}: '{info['name']}' @ {rate}Hz x{channels}")

    mic_idx = sd.default.device[0]
    if mic_idx is None or mic_idx < 0:
        raise RuntimeError("No default input device — check System Settings > Sound > Input")
    mic_info = sd.query_devices(mic_idx)

    bh_idx, bh_info = find_blackhole()
    if bh_idx == mic_idx:
        print("[capture] WARNING: BlackHole is the default INPUT — set your real mic as default input")

    open_stream("me", mic_idx, mic_info)
    if bh_idx is not None:
        open_stream("them", bh_idx, bh_info)
    else:
        print("[capture] WARNING: BlackHole not found — capturing mic only.")
        print("          Install it and route output to a Multi-Output Device (see SETUP-MAC.md).")
    return streams
