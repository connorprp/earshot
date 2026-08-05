# Earshot

Ambient conversation dashboard: always-on listener that captures mic + system
audio, transcribes locally on the GPU, distills the conversation into
live-morphing "concept bubbles," and attaches **hedged action buttons**
(calendar, email draft, spreadsheet, Claude Code brief, note) inferred from
context. Personal tool for Connor; planning docs live in this file.

## Run

```
npm run dev        # everything: hub (:7071) + dashboard (:5173) + capture
npm run inject     # replay a fake work call through the pipeline (server must be up) — test without audio
```

Individual: `npm run server` / `npm run dashboard` / `npm run capture`.

Env knobs: `EARSHOT_MODEL` (whisper model, default large-v3-turbo; use base.en
for quick tests), `EARSHOT_DEVICE` (cuda|cpu), `EARSHOT_LLM` (distill model,
default sonnet), `EARSHOT_PORT` (hub, default 7071), `EARSHOT_MONGO`
(connection string — lives in `server/.env`, gitignored, NEVER copy it into
this file or README), `EARSHOT_DB` (default "earshot").

## Architecture

```
capture/    Python 3.12 (.venv here) — WASAPI loopback + mic → RMS segmentation
            → faster-whisper on GPU → {type:"transcript", source:"me"|"them",
            text, ts, speaker?} over ws to hub /ingest. speakers.py labels
            "them" voices (sherpa-onnx TitaNet embeddings on CPU + online
            cosine clustering → them-1, them-2…; labels stable for the
            capture process lifetime; model at models/*.onnx, missing model
            = no-op) and ships {type:"speakers"} centroid snapshots.
            echo_gate.py — echo suppression layer 1 (primary): tracks when
            loopback speech is playing; once text-level echo evidence exists
            (a mic line fuzzy-matching a recent loopback line, ≥2 hits/2min)
            mic segments ≥60% inside loopback speech are dropped PRE-ASR.
            Auto-engagement keeps headphone interjections safe (no echoes →
            gate stays off). EARSHOT_MIC_GATE = auto|on|off.
server/     Node ESM — ws hub (fan-in capture, fan-out dashboards), distill
            scheduler, action executor. State = {bubbles:[], rev}.
            db.js — MongoDB Atlas persistence (Connor's "rusty" cluster, db
            "earshot"): sessions / transcripts (every line verbatim) /
            bubbles (upserted per change, removed = flag not delete) / ops
            (distill audit trail). Sessions are manual: POST /record/start
            opens one (clears the board), /record/stop flushes a final
            distill and sets endedAt; ingest lines are dropped while not
            recording. Hub restart < 30 min after last activity resumes an
            unfinished session (already recording) and restores the live
            board; Mongo down = warn + memory-only, never crash. GET
            /sessions and /sessions/:id serve the read side. Scripts run
            node with --env-file-if-exists=server/.env.
            Echo suppression, layer 2 (backstop): "me" lines wait in a 6s
            hold and are dropped when ≥62% of their tokens FUZZY-match (4-char
            prefix — mic-path ASR garbles word tails) one "them" line within
            ±15s. Constants tuned on a real captured echo set (exact 0.8/8s
            caught 19%, this catches 59%); capture's timing gate is layer 1.
            Held lines flush on Stop.
            closeout.js — after Stop (async, doesn't block the button): LLM
            pass writes a session report (title/summary/participants/
            decisions/openItems) onto the session doc + out/<title>-session.md,
            and decides if the session CONTINUES the previous one (voice-match
            cosine on persisted speaker centroids + content) → sessions share
            a chained conversationId; never merged. Record < 45 min after a
            Stop provisionally restores the previous board with bubbles
            marked restored:true + a distill note; an update confirms a
            bubble (clears the flag), and bubbles still unconfirmed after 4
            distills are auto-archived (removedReason "stale-restore").
dashboard/  Vue 3 + Vite — bubble grid (TransitionGroup morphing), transcript
            ticker, action buttons POST /action, ✕ POSTs /dismiss.
out/        action artifacts (.ics, .eml, .csv, *-brief.md, notes.md)
scripts/    inject.js — fake-conversation replayer
```

Data flow: capture never talks to the LLM; hub batches pending transcript
lines and every ~18s (or eagerly at 6 lines) asks the model for **patch ops**
(`add`/`update`/`remove` bubbles) against current state — the bubbles ARE the
compressed context; transcript history is never in the prompt. See
`server/distill.js` for the system prompt and bubble/action schema.

## Hosted mode (coworker on a MacBook)

Split rule: audio capture MUST run on the user's machine; everything else
(hub + dashboard + Mongo + LLM) runs on Connor's server.

**Multi-tenant (2026-08-05):** ONE hub instance serves all users. Google
sign-in decides identity; a Tenant object (server/index.js) owns each user's
entire state — board, transcript, recording, echo suppression, sessions,
out/<email-slug>/ artifacts — and every Mongo doc carries userId. Local mode
= single "local" tenant, identical to old behavior; old docs were migrated
to userId "local" automatically on first start. Isolation is covered by
server/ci_test.mjs (state, ws fan-out, capture routing, /files, settings).

**Self-serve onboarding (Connor's call: native capture agents only — no
browser capture; rusty has no GPU and agents give the best quality):**
anyone @<company-domain> signs in (EARSHOT_ALLOWED_DOMAINS; plus
EARSHOT_ALLOWED_EMAILS extras). First sign-in auto-provisions a users doc
{captureKey, claudeTokenEnc}. The dashboard ⚙ Settings panel shows the
user's capture key + server address for the per-OS installers (mac/ and
windows/), and a paste box for their `claude setup-token` token — stored
AES-GCM-encrypted with EARSHOT_SECRET (changing that secret orphans stored
tokens), distills run under it via options.env. Topbar warning chips show
"no capture agent" / "connect Claude" live (per-tenant ws status messages).
Browser capture (getDisplayMedia) was considered and declined; macOS
browsers can only capture tab audio anyway. Capture agents connect to
wss://earshot.rustycloud.dev/ingest?key=<theirs>; Connor's own Windows agent
has capture/cloud.env (gitignored) + `npm run capture:cloud`.

**Packaged desktop app (the real ship vehicle for non-technical users):**
capture/tray.py — PyInstaller-frozen tray app (Windows onefile .exe ~105MB,
Mac .app zip ~83MB), built by CI jobs app-windows/app-mac on every main push
and synced onto rusty by ~/earshot/deploy/sync-apps.sh into deploy/downloads/
(gitignored; mounted ro at /app/downloads), served at /installer/app/windows|mac
(gated). First run does DEVICE PAIRING — app POSTs /pair/start with a code,
opens {hub}/?pair=CODE, the signed-in user clicks "Allow this computer",
app claims key via /pair/claim (single-use, 10-min TTL) — so one generic
binary serves everyone, no keys typed. Tray menu: pause/resume (PAUSED event
in main.py), open dashboard, quit. Models download on first run to the
platform app-data dir. Verified E2E with the real CI-built exe: launch →
pair → approve → key claim → capture connected. After changing capture code,
CI rebuilds the apps; run sync-apps.sh on rusty to publish them. Unsigned:
Windows = one SmartScreen click; macOS Sequoia = Privacy & Security "Open
Anyway" (clean fix = Apple Developer ID $99/yr + notarize step in CI).

**One-click installers (script tier, kept as fallback):** the hub serves PERSONALIZED installers (Settings ⚙
→ download buttons): GET /installer/windows|mac templates
windows/installer-template.bat / mac/installer-template.command with the
user's server URL + capture key substituted — zero questions during install,
auto-starts capture, Desktop launcher for next time. Code ships via public
GET /installer/capture.tgz (pure-node ustar+gzip — platform tar is quirky:
MSYS tar on Windows treats C:\ paths as remote hosts). Windows installer
auto-installs Python via winget; mac one auto-downloads the BlackHole pkg
from GitHub releases. Verified E2E on real Windows: generated bat → deps →
config → agent connected+authed to the hub. Unsigned scripts = one
SmartScreen/Gatekeeper "run anyway" click; signed native apps are the next
tier if that's still too much friction.

- Auth: Google Sign-In (server/auth.js). Dashboard posts a Google ID token,
  hub verifies via google-auth-library + EARSHOT_ALLOWED_EMAILS, mints a
  signed cookie (EARSHOT_SECRET). Headless capture uses EARSHOT_CAPTURE_KEY
  (?key= on /ingest). EARSHOT_GOOGLE_CLIENT_ID unset = local mode, no auth,
  CORS open for the 5173 vite dev server (hosted mode is same-origin, no CORS).
  Google client id is a one-time creation in console.cloud.google.com
  (OAuth web client; authorized origin = the dashboard URL).
- Hub serves the built dashboard (dashboard/dist) itself; EARSHOT_HOSTED=1
  makes actions return /files/<name> download links instead of opening
  locally (browser downloads → user's default app opens it). openFile is
  now cross-platform (win/mac/linux) for local mode.
- Per-user Claude: CLAUDE_CODE_OAUTH_TOKEN env (from `claude setup-token`)
  — distills bill that user's subscription. deploy/ has Dockerfile (installs
  claude-code CLI), docker-compose.yml (one service per user, separate
  EARSHOT_DB + out/ volume), Caddyfile (TLS per subdomain), .env.example.
- Mac capture: capture/mac_audio.py (sounddevice; system audio via BlackHole
  2ch + Multi-Output Device), platform switches in main.py (cpu/small.en
  defaults on darwin). mac/ has a click-only installer (`Install
  Earshot.command`, GUI dialogs, venv + model download + Desktop launcher),
  SETUP-MAC.md for the coworker, and `Connect Claude.command` (guided
  setup-token). ⚠ UNTESTED on real Mac hardware — verify once before
  distributing.

## Live deployment (rusty)

- **https://earshot.rustycloud.dev** — Connor's hosted instance on rusty,
  deployed 2026-08-05. Manual-Traefik convention (like suitecrm/openproject):
  `~/earshot/deploy/docker-compose.rusty.yml` on the box, container on the
  `coolify` network, Let's Encrypt via coolify-proxy. DNS via the existing
  `*.rustycloud.dev` wildcard A record (DDNS-maintained).
- Env/secrets: `/home/<user>/earshot-connor.env` on rusty (chmod 600) —
  includes EARSHOT_CAPTURE_KEY (needed by any capture agent pointing at the
  hosted hub) and EARSHOT_DB=earshot-cloud (separate from local dev's
  "earshot" db). Restart after env edits:
  `cd ~/earshot/deploy && docker compose -f docker-compose.rusty.yml up -d`
  (add `--build` after a `git pull`).
- Currently FAIL-CLOSED pending two Connor-only credentials in that env file:
  EARSHOT_GOOGLE_CLIENT_ID (real OAuth web client, authorized origin
  https://earshot.rustycloud.dev) and CLAUDE_CODE_OAUTH_TOKEN (from
  `claude setup-token`). ⚠ Never BLANK the client id — empty = auth disabled
  entirely (local mode), not locked.
- Git: GitHub **connorprp/earshot** (private; CI incl. macOS capture job) +
  bare mirror `~/earshot.git` on rusty. Local remote "rusty" pushes there;
  mirror to GitHub from the box: `cd ~/earshot.git && git push --mirror
  git@github.com:connorprp/earshot.git`.

## Context architecture (token discipline)

Tiered, so cost never scales with corpus size or meeting length:
- **Tier 1 — always in the distill prompt (~200-400 tok):** people directory
  (auto-built from Google sign-in names via users collection; db.directory())
  + the current calendar meeting (title/attendees/agenda, fetched at Record
  start when the user connected Google). Built in Tenant.buildSessionContext,
  stored on the session doc (calendarEvent), included in distill + closeout.
- **Tier 2 — retrieval on trigger (designed, NOT built):** Asana / GBN notes /
  wordpress-ops changelogs get indexed (keyword/embedding, no LLM cost);
  top-K snippets attach only when a NEW bubble's terms match. Cost scales
  with new concepts per meeting, not time.
- **Tier 3 — closeout only:** deeper pulls are affordable once per session.

Per-user Google (server/google.js): OAuth code flow, scopes calendar.events
+ gmail.compose, refresh token AES-encrypted on the user doc, routes
/google/connect (authed 302) + /google/callback (public, signed expiring
state). Requires GOOGLE_CLIENT_SECRET env + {origin}/google/callback as an
authorized redirect URI on the existing OAuth client — feature is dormant
(Settings hides the button) until the secret is set. ⚠ If the consent screen
is in "Testing" mode, Google expires refresh tokens after 7 days — publish
the app (Internal for Workspace) to avoid weekly re-connects.
Actions upgrade: with Google connected, calendar → real event (sendUpdates=
all, attendees from payload, model told to use directory emails) and email →
real Gmail DRAFT (never auto-send, hedged); artifact fallback on any failure.

## Hard-won facts (don't re-derive)

- **GPU/Blackwell**: faster-whisper works on the RTX 5080 via pip
  `nvidia-cublas-cu12` + `nvidia-cudnn-cu12`; `capture/cuda_paths.py` must be
  imported BEFORE faster_whisper to add those DLL dirs. Verified working.
- **Loopback = ALL render devices, not the default output.** Apps pick their
  own output device: Teams uses the communications endpoint (HyperX "Chat")
  while the system default is HyperX "Game" — tapping only the default
  silently misses calls. `capture/main.py` opens a loopback stream per render
  device; failures log `SKIP` and are non-fatal. `capture/list_devices.py`
  prints the device map for debugging.
- **Distill auth**: uses `@anthropic-ai/claude-agent-sdk` → rides the local
  Claude Code login. No ANTHROPIC_API_KEY anywhere.
- **LLM date math is unreliable**: the model resolved "next Thursday" to a
  Friday. The prompt includes an explicit 14-day weekday/date calendar
  (`upcomingDays()` in distill.js). Keep it.
- **Actions are local-artifact based** (no external auth): .ics opened by
  default calendar app, .eml with `X-Unsent: 1` opens as editable draft,
  .csv → Excel, claude_code → brief .md in out/. Upgrade path is real MCP
  connectors (Google Calendar, Gmail) through the Agent SDK.
- The python venv was moved with the project — fine for `python.exe` runs;
  pip console scripts have stale shebangs, use `python -m pip` if needed.

## Product decisions (Connor's calls, don't relitigate)

- **Hedged actions over confident prediction**: 2-4 plausible action buttons
  per bubble + ignore, ordered by likelihood. Wrong-but-present beats
  missing. Never an "ignore" action from the model (UI provides ✕).
- Action clicks are intended as future training signal: log which action type
  gets picked per bubble kind → few-shot examples in the distill prompt
  (same pattern as his GBN learned-solutions loop). Not built yet.
- Privacy: personal-use-first; Read.ai-style disclosure only if productized.
- Wear headphones on calls; open speakers muddy me/them attribution.

## Status / roadmap

Working end-to-end (verified via inject + live use): capture, GPU
transcription, distill morphing (bubbles update/collapse as conversation
resolves), spreadsheet action fired successfully.

Persistence: DONE via MongoDB (see db.js above) — full transcripts, bubbles,
ops, sessions; resume-on-restart verified.

Record/Stop: DONE — dashboard topbar button drives /record/start|stop;
session boundaries are now manual (capture streams constantly, hub gates).
Bubbles stay on the board after Stop so actions remain clickable; Record
clears them. `npm run inject` auto-starts a recording (leaves it open —
press Stop yourself).

Closeout + session linking: DONE (see closeout.js above) — verified via two
back-to-back inject runs: reports written, continuation detected with voice
match 1/1, conversationId chained across three sessions.

Speaker ID: DONE capture-side (speakers.py); voice tags flow into the
distill prompt, which maintains a hedged "Participants" contact bubble
(names inferred from context only — them-2 "likely Dave"). Constants tuned
against a played-back YouTube meeting (0.45 / 2.0s — the old 0.50/1.0s split
5 voices into 7); re-check on a live Teams call.

Simulated-meeting audit (2026-08-04, YouTube "Weekly Meeting Example"
played over open speakers): all topics correctly bubbled + reported, but
found 4 gaps, all FIXED same night — mic echo (~40% junk "me" lines → hub
echo suppression), stale restored bubbles surviving a different
conversation (→ confirm-or-archive above), voice over-segmentation
(→ retuned constants), and an ASR tense flip ("we should put up posters" →
"I put up posters") that distill+report stated as completed work (→ prompt
rule: hedge uncorroborated already-done claims as proposed/claimed).

Second audit round (same night, two more simulated meetings): echoes still
present — root cause: the dev stack had NOT been restarted, fixes never ran.
The captured echo set showed text matching alone tops out (~59% even fuzzy;
mic-path ASR garbles too hard), driving the two-layer design above (capture
timing gate = primary, hub fuzzy match = backstop). Third round confirmed
the echo gate live (0 junk "me" lines in 44).
LESSON: after code changes, restart npm run dev BEFORE the next test run.

Live speaker names: distill emits {"op":"speakers","map":{"them-2":"Dave",
"them-3":"Sarah?"}} ops ("?" = tentative) merged into state.speakers,
persisted per session (speakerNames), restored on crash-resume, and cleared
on Record. The ticker resolves voice tags through state.speakers live —
past lines re-caption too. Names deliberately do NOT depend on the
Participants bubble: v1 put the map on that bubble and the model simply
never created it in one session (names were sitting in the transcript,
"Thanks, Josh"), so the op is independent and can ride an otherwise empty
patch. Verified end-to-end: named test convo -> map after first distill.

Next agreed slice (designed, not built): stale-bubble auto-archive shelf
(idle ~15-20 min → out of prompt, still rendered). Later:
cross-session carryover of open items only, auto session detection, Electron
always-on-top wrap, Haiku pre-filter tier, per-device capture toggles.
