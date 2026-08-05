"""Make the pip-installed NVIDIA runtime DLLs (cuBLAS, cuDNN) visible to ctranslate2.

Import this BEFORE faster_whisper / ctranslate2.
"""
import os
import sys
from pathlib import Path

_site = Path(sys.executable).parent.parent / "Lib" / "site-packages"

for _sub in ("nvidia/cublas/bin", "nvidia/cudnn/bin"):
    _p = _site / Path(_sub)
    if _p.is_dir():
        os.add_dll_directory(str(_p))
        os.environ["PATH"] = str(_p) + os.pathsep + os.environ.get("PATH", "")
