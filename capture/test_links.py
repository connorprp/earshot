"""Deliverable links: what the agent says it made -> what the dashboard can
open, and the guardrails on opening it. Pure logic, no audio, no Claude:

    python capture/test_links.py

Runs on every platform (CI runs it on both Windows and macOS).
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import main  # noqa: E402

fails = 0


def check(label, cond, got=""):
    global fails
    print(f"  {'PASS' if cond else 'FAIL'}  {label}")
    if not cond:
        fails += 1
        if got:
            print(f"        got: {got}")


tmp = Path(tempfile.mkdtemp(prefix="earshot-links-"))
tdir = tmp / "th-1"
tdir.mkdir()
(tdir / "proposal.docx").write_text("x")
(tdir / "evil.bat").write_text("echo pwned")

summary = """I drafted the proposal and created the Gmail draft.

```earshot-links
[{"label": "Open the proposal", "file": "proposal.docx"},
 {"label": "Open the Gmail draft", "url": "https://mail.google.com/mail/u/0/#drafts?compose=abc"},
 {"label": "Ghost", "file": "not-there.docx"},
 {"label": "Escape", "file": "../../../secrets.txt"},
 {"label": "Bad scheme", "url": "javascript:alert(1)"}]
```"""

text, links = main._parse_links(summary, tdir)
check("the block is stripped out of the summary the user reads",
      "earshot-links" not in text and text.startswith("I drafted"), text[:60])
labels = [l.get("label") for l in links]
check("a real file in the task dir becomes a link",
      {"label": "Open the proposal", "file": "proposal.docx"} in links, json.dumps(links))
check("an https url becomes a link", any(l.get("url", "").startswith("https://mail.google") for l in links))
check("a file that does not exist is dropped", "Ghost" not in labels)
check("a path escaping the task dir is dropped", "Escape" not in labels)
check("a non-http scheme is dropped", "Bad scheme" not in labels)

text2, links2 = main._parse_links("Just a summary, nothing made.", tdir)
check("no block = no links, summary untouched", links2 == [] and text2 == "Just a summary, nothing made.")

text3, links3 = main._parse_links("Broke it.\n```earshot-links\n{not json\n```", tdir)
check("a malformed block is ignored, not fatal", links3 == [] and "earshot-links" not in text3)

# ---- opening: a click must never launch something runnable, and never reach
# outside the task folder (a hostile meeting is a prompt-injection vector) ----
opened: list[str] = []
main._tasks_root = lambda: tmp                                    # type: ignore[assignment]
main.os.startfile = lambda p: opened.append(str(p))               # type: ignore[attr-defined]
main.subprocess.Popen = lambda cmd, *a, **k: opened.append(str(cmd[-1]))  # type: ignore[assignment]

main._open_path("th-1", "proposal.docx")
check("opens a real deliverable", bool(opened) and opened[-1].endswith("proposal.docx"), str(opened))
main._open_path("th-1", "evil.bat")
check("refuses to launch an executable, opens the folder instead",
      opened[-1].endswith("th-1"), str(opened))
before = len(opened)
main._open_path("th-1", "../../../Windows/System32/calc.exe")
main._open_path("th-1", "nope.docx")
check("refuses to open outside the task folder or a missing file", len(opened) == before, str(opened))
main._open_path("th-1", "")
check("an empty name opens the task folder", opened[-1].endswith("th-1"))

print("\nALL CAPTURE LINK CHECKS PASSED" if not fails else f"\n{fails} FAILURE(S)")
sys.exit(1 if fails else 0)
