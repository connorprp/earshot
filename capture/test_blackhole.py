"""The BlackHole driver fetch: pin integrity + the guardrails on what we hand
to Apple's Installer. Pure logic plus ONE network check:

    python capture/test_blackhole.py

Runs on every platform (CI runs it on macOS). The network check is what stops
this from silently rotting the way the old GitHub-release grep did — that one
looked fine forever while returning an empty URL, because BlackHole has never
published a .pkg asset on a release.
"""
import hashlib
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mac_blackhole as bh  # noqa: E402

fails = 0


def check(label, cond, got=""):
    global fails
    print(f"  {'PASS' if cond else 'FAIL'}  {label}")
    if not cond:
        fails += 1
        if got:
            print(f"        got: {got}")


tmp = Path(tempfile.mkdtemp(prefix="earshot-bh-test-"))
body = b"not really a package, but it hashes"
src = tmp / "fake.pkg"
src.write_bytes(body)
src_url = src.as_uri()
real_url, real_sha = bh.PKG_URL, bh.PKG_SHA256

print("fetch() verifies before we hand the file to Installer")
try:
    bh.PKG_URL, bh.PKG_SHA256 = src_url, hashlib.sha256(body).hexdigest()
    out = Path(bh.fetch(str(tmp / "ok.pkg")))
    check("a matching hash downloads", out.exists() and out.read_bytes() == body)

    bh.PKG_SHA256 = "0" * 64
    bad = tmp / "bad.pkg"
    raised = False
    try:
        bh.fetch(str(bad))
    except ValueError:
        raised = True
    check("a mismatched hash raises", raised)
    check("...and the bad file is deleted, never left for Installer", not bad.exists())
finally:
    bh.PKG_URL, bh.PKG_SHA256 = real_url, real_sha

print("the pin itself")
check("url is https", bh.PKG_URL.startswith("https://"))
check("sha256 is a full digest", len(bh.PKG_SHA256) == 64)
check("installed() survives a machine with no HAL dir", bh.installed() in (True, False))

print("the pinned url still serves the pinned bytes")
try:
    req = urllib.request.Request(bh.PKG_URL, headers={"User-Agent": bh.UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        got = hashlib.sha256(r.read()).hexdigest()
    check("live pkg matches PKG_SHA256 (bump both together)", got == bh.PKG_SHA256, got)
except (urllib.error.URLError, TimeoutError) as e:
    # their host being down is not our bug; a CHANGED file is
    print(f"  WARN  could not reach {bh.PKG_URL}: {e}")

print(f"\n{'FAILED' if fails else 'ALL PASS'} ({fails} failures)")
sys.exit(1 if fails else 0)
