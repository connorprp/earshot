# Earshot

> Returning to this project? Read **HANDOFF.md** for current state, the
> pick-up list, and the operational crib sheet. This file is architecture +
> decisions.

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
this file or README), `EARSHOT_DB` (default "earshot"),
`EARSHOT_ANTHROPIC_KEY` (hosted: shared sk-ant-api03 key all distills bill to;
unset in local mode, which rides the machine's Claude login), `GROQ_API_KEY`
(enables cloud ASR — see "ASR modes" below; unset = local-whisper only),
`EARSHOT_GROQ_MODEL` (default whisper-large-v3-turbo), `EARSHOT_GROQ_URL`
(API base override, used by the CI stub).

## Architecture

```
capture/    Python 3.12 (.venv here) — WASAPI loopback + mic → RMS segmentation
            → faster-whisper on GPU → {type:"transcript", source:"me"|"them",
            text, ts, speaker?} over ws to hub /ingest. `source` is the
            CHANNEL (mic vs loopback — both echo layers key off it),
            `speaker` is WHO. speakers.py labels voices on BOTH channels
            (sherpa-onnx TitaNet embeddings on CPU + online cosine clustering;
            labels stable for the capture process lifetime; model at
            models/*.onnx, missing model = no-op) and ships {type:"speakers"}
            centroid snapshots — see "Speaker identity" below.
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
            (distill audit trail) / threads (a Claude conversation per
            concept+action — see "Threads" below). Sessions are manual: POST /record/start
            opens one (clears the board), /record/stop flushes a final
            distill and sets endedAt; ingest lines are dropped while not
            recording. Hub restart < 30 min after last activity resumes an
            unfinished session (already recording) and restores the live
            board; Mongo down = warn + memory-only, never crash. Read side:
            GET /sessions (searchable list), /sessions/:id, and
            /sessions/:id/export (see "Session archive"). Scripts run
            node with --env-file-if-exists=server/.env.
            export.js — one renderer for md / txt / json exports, shared by
            the archive and the live board.
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
            boardedit.js — the board as edited by the USER (see "Ask Claude"
            below): the distiller's own patch vocabulary, applied on their
            behalf and therefore authoritative.
dashboard/  Vue 3 + Vite — bubble grid (TransitionGroup morphing), transcript
            ticker, action buttons POST /action, ✕ POSTs /dismiss, plus the
            session sidebar (search + click-to-reopen), Export menu, and the
            "✦ Ask Claude" sheet (per concept + board-wide).
out/        action artifacts (.ics, .eml, .csv, *-brief.md, notes.md)
scripts/    inject.js — fake-conversation replayer
```

Data flow: capture never talks to the LLM; hub batches pending transcript
lines and every ~18s (or eagerly at 6 lines) asks the model for **patch ops**
(`add`/`update`/`remove` bubbles) against current state — the bubbles ARE the
compressed context; transcript history is never in the prompt. See
`server/distill.js` for the system prompt and bubble/action schema.

## ASR modes (per-user, dashboard Settings → Transcription)

Two modes, chosen per user; unset pref defaults to **groq when the server has
GROQ_API_KEY, local otherwise** (so local dev never changes, and hosted test
users get the zero-download path automatically — Connor flips his own account
to local once to keep the 5080 doing his ASR):
- **local** — today's behavior: faster-whisper on the capture machine; the
  whisper model is also selectable in Settings (whitelist in server/asr.js).
  main.py loads whisper LAZILY (first segment, `_get_model`) so a groq-mode
  agent never downloads a model or pulls CUDA DLLs — that skipped ~1GB
  first-run download is the point of the feature (Mac install ease).
- **groq** — thin capture: main.py ships each finished segment as
  `{type:"audio", source, ts, rate, format:"wav", data:<base64 int16 WAV>}`
  (≤ ~700KB) up the same /ingest ws; the hub transcribes via Groq
  (`server/asr.js`, whisper-large-v3-turbo, $0.04/audio-hr; Groq bills a 10s
  minimum per request → a chatty hour ≈ $0.03 — do NOT bother batching) and
  feeds the resulting transcript event through handleCaptureEvent, inheriting
  layer-2 echo, persistence, ticker, distill. Calls are serialized per tenant
  (groqChain) so lines land in order; failures drop the segment, never the
  hub. Zero idle spend: audio is refused while not recording. Privacy note:
  in groq mode raw call audio leaves the user's machine (to Groq) while
  recording, same trust posture as transcripts leaving to the hub.

**Hub→capture downlink (new):** the hub now SENDS on /ingest —
`{type:"config", asrMode, asrModel}` on connect + on every Settings change
(agents switch modes live; `asrModel:null` = agent's platform default), and
in groq mode each produced `{type:"transcript"...}` is echoed down the
originating socket PRE-echo-filter so capture's echo-gate text-evidence layer
(auto-engagement) works exactly as it does with local ASR (`_handle_downlink`
in main.py; mic-segment overlaps are remembered in `_me_overlap`). Old agents
that never recv are fine: their local transcripts are accepted regardless of
asrMode (a user picking cloud with an old agent silently stays local).
Settings surface: GET /me (asrMode/asrModel/asrModels/groqConfigured),
POST /me/asr, "⚠ transcription offline" chip when groq mode lacks a key.

## Speaker identity (who said it, not which channel)

Added 2026-08-07 because a phone call on speakerphone read as one long "You":
the mic is NOT one person. Anyone in the room, or on a phone held near the
desk, arrives on the same stream as the owner, and the old code labeled every
mic line "You" by construction (only loopback was clustered).

The rule now: **`source` is the acoustic channel, `speaker` is the identity,
and `speaker` wins everywhere.** `source` stays the channel because both echo
layers key off it (a mic line reclassified as "them" would become an echo
*reference* and start suppressing real lines). One shared renderer,
`speakerLabel()` in server/export.js, is used by exports, task prompts and
MCP; the dashboard's `whoLabel`/`whoClass` and distill/closeout prompts follow
the same rule. `"me"` = the device owner, `them-N` = anyone else on EITHER
channel, no tag = fall back to `source` (short segments, no embedding model,
older capture agents — so old agents keep working unchanged).

- **Owner election (capture/speakers.py).** Nothing in the audio says which
  mic voice is you, so: the first voice heard on the mic is *provisionally*
  the owner (with one person at the mic that is exactly the old "mic = you"
  assumption, so a solo user sees no change), and the election can correct
  that while evidence is thin — the owner is the mic-dominant voice
  (`mic_s >= loop_s * 2`, so loopback bleed can never win) with the most mic
  talk-time, needing 12s and a 1.5x margin over the runner-up. At 90s of mic
  speech ownership LOCKS for the process (renumbering people mid-conversation
  is worse than a label that stays put) and the centroid is written to
  `<app-data>/voice-me.json` (`EARSHOT_VOICE_STORE` overrides; a print from a
  different embedding model is ignored) — but ONLY when the winner is clear
  (2x the runner-up). A session two people split is never memorized: better to
  elect again next run than to inherit a coin flip. When it does save, "me" is
  right from line one on every later run and a machine pays the bootstrap once. There is deliberately no
  auto-unlock: a rule like "the stored owner has been quiet, re-elect" would
  hand "me" to a coworker during a long speakerphone monologue. **Recovery is
  deleting `voice-me.json`** (capture logs its full path on load) — a new mic,
  or a machine that learned the wrong voice, re-elects from scratch.
- **Cost of a flip:** lines already sent keep the label they went out with,
  and the new owner's old `them-N` tag is retired (the numbering can have a
  gap). There is deliberately no relabel-the-past message — it would mean
  rewriting stored transcripts, the live ticker, and speaker names for a
  once-per-machine event. `labeler.rev` bumps on any label-set change so a
  fresh centroid snapshot ships immediately instead of up to 20s later.
- **Participants:** the hub adds any voice tag except "me" to
  `activeSpeakers` regardless of channel, so in-room people count as real
  participants in the closeout report and session-continuation voice match.
  closeout's `voiceMatch` explicitly skips "me" — the owner is in every
  session, so counting them would make every pair of sessions look related.
- **Echo, layer 3 (evidence only):** a mic segment whose voice we know mostly
  from loopback, arriving while loopback plays, calls
  `echo_gate.record_hit()`. It arms the existing timing gate sooner but never
  drops anything on its own, so a real interjection can't be suppressed by
  voice match alone.
- Known gap: segments under `MIN_EMBED_S` (2s) can't create or update a
  cluster, so a coworker's short "yeah" on the mic still falls back to "You".
- Tests: capture/test_speakers.py (election, flip, persistence, ambiguous
  sessions, corrupt-store fallback — fake extractor, no model needed; win +
  mac CI),
  ci_test_mac.py adds the same two real TTS voices sharing the MIC, and
  server/ci_test.mjs asserts a tagged mic line is that person while an
  untagged one is still "Me". `npm run inject` now includes a mic-side third
  voice; verified live end-to-end — distill named it ("Ollie", from the
  owner's "I've got Ollie here with me"), export attributed its lines to
  Ollie, and the closeout report listed three participants.

## "✦ Ask Claude" — the general-purpose channel (+ authoritative user edits)

Added 2026-08-11. Every concept card carries a `✦ Ask Claude` button and the
topbar carries a board-wide one; both open `dashboard/src/components/AskSheet.vue`
and start a normal thread (`POST /ask` → `dispatchTask`, follow-ups through the
existing `/thread/reply`). It is deliberately NOT one of the model's hedged
actions: the user types anything — a correction ("them-2 is Dave Ramirez"), a
restructure ("split this card"), or work that no button offered ("find three
alternatives and write it up") — and their own Claude both does it and, when the
ask is about the notes themselves, **rewrites the board live**.

- **Write tools on the MCP endpoint** (server/mcp.js): `edit_notes` (add/update/
  remove concepts, same op vocabulary as a distill patch), `name_speakers`,
  `add_note`, `remove_note`; `get_live_board` now returns concept **ids** (an
  agent that can't name a card can't edit one), pinned notes, and optional
  recent transcript lines. Applied by server/boardedit.js → `bumpAndBroadcast`,
  so a change lands on every open dashboard within a second.
- **Which board an edit hits:** capture writes `X-Earshot-Thread` into each
  task's mcp.json, so the hub knows which conversation is calling and routes the
  edit to the live board or to the archived session that chat was opened from
  (`applyArchivedEdit` → Mongo → `{type:"session_patch"}` → the open archive view
  re-reads). No header (Claude Desktop, an old capture agent) = the live board.
  Every applied edit also appends a `✎ updated “…”` system line to the thread, so
  the chat shows what changed.
- **Authority (the point of the feature).** A user edit outranks the distiller,
  three ways: (1) touched bubbles carry `userEdited: true` and the distill system
  prompt is told never to revert them (only to add new developments); (2) a voice
  the user names is PINNED — `applyOps` drops any later `speakers` op for that
  tag; (3) `state.notes` (pinned via `add_note` or the board's ＋ note row) ride
  in every later distill prompt AND the closeout as an explicit AUTHORITATIVE
  block. Plus an in-flight guard: a distill that started before an edit has its
  `update`/`remove` ops for that bubble dropped, since it was reasoning about a
  card the user has since fixed. Only kind/title/summary/details/actions are
  writable from a tool call, and `carryActionHistory` keeps button status +
  userNotes + threadId across an edit.
- Notes/pins persist on the session doc (`boardNotes`, `speakerPins`), are
  restored on hub-restart resume, carry through the 45-min provisional restore
  (same conversation resuming = same corrections), reset on Record, and appear in
  md + json exports.
- Verified live end-to-end, not just in CI: the real `claude` CLI against a real
  hub + Atlas drove `name_speakers` / `edit_notes` / `add_note`, then a REAL
  distill of contradicting new speech kept the user's title and pinned name while
  correctly updating the price it heard ($4k → $3k); and a stand-in capture agent
  took a real `/ask` task off the ws, ran it through `claude -p` with the thread
  header, and the edit came back narrated in the right thread. CI: +35 checks
  (158 total).

## Session archive (searchable sidebar + export)

Added 2026-08-06. Everything ever recorded is reachable from the dashboard, not
just via MCP.

- **Sidebar** (☰ in the topbar toggles it): "Live board" pinned at top, then
  every session grouped by day (Today / Yesterday / weekday / date) with
  title (closeout report title → calendar event title → start time), start
  time, duration, line + concept counts, and flags (`open` = never stopped,
  `continues` = chained conversationId, `on board` = the session whose
  bubbles are currently live).
- **Search** (debounced 250ms) hits BOTH sides in `db.listSessions`: session
  fields (report title/summary/decisions/openItems/participants, calendar
  event title) and every transcript line — transcript matches come back with
  `{matches, snippet}` and the sidebar shows the matching line, so "what did
  we say about the newsletter" finds the session by its words. Counts come
  from `$lookup` (not a stored counter) so pre-feature sessions are accurate.
  MCP `list_sessions` takes the same optional `query`.
- **Reopening** a session renders it in place of the live board: closeout
  report card (summary / participants / decisions / open items), its bubbles,
  and its full transcript in the ticker with speaker names resolved. Live ws
  updates keep flowing into the live refs behind it, so "← live board" is
  instant; pressing Record snaps back automatically.
- **Archived actions are real actions.** A click in the archive posts
  `{bubbleId, actionId, sessionId}`; the hub loads that bubble from Mongo
  (`getSessionBubble`) and builds the task prompt from THAT session's last 150
  lines + its speaker names + its report (`getSessionTail`), never the live
  conversation, with an explicit "this was recorded on <date>, resolve
  relative dates against it" preamble. Routing is unchanged (user's Claude →
  hub Google → artifact). Status is written with `setBubbleActionStatus`
  (targeted `arrayFilters` update, so a stored doc is never rewritten or
  un-removed) and the `task_done` broadcast carries bubbleId/actionId/
  sessionId so the open archive view flips the button like a live one.
  Bubbles keep no ✕ in the archive (history isn't dismissed after the fact).
  Post-Stop clicks on the live board now persist too — that path used
  `t.sessionId` (null after Stop) and now uses `boardSessionId()`.
- **Export** (any view): `GET /sessions/:id/export?format=md|txt|json`,
  `id=live` for the current board. md = report + concepts + full transcript,
  txt = speaker-labeled transcript, json = everything machine-readable.
  Downloads are cookie-authed and tenant-scoped; the live board works even
  with Mongo down (memory fallback in the route).
- Read paths project session.speakers (voice centroids) out — big and useless
  to readers. `getPreviousSession` still gets them (closeout voice match).

## User's-own-Claude integration (device agent tasks + MCP)

Added 2026-08-05, both directions verified live. Heavy per-user work never
bills the shared server key — it runs on the user's OWN Claude Code login on
their machine, the only sanctioned path (the server can't hold subscription
auth — see Claude auth notes).

- **Device tasks (write side):** EVERY action type routes by preference:
  **the user's own Claude on their device → hub Google (if linked) →
  artifact file** (Connor's call 2026-08-05: notes/spreadsheets too, not
  just side-effect types; only a calendar action missing its start time
  skips the agent). Type-specific missions: calendar → real Google Calendar
  event; email → Gmail DRAFT (never send); note → Notion page or Google
  Doc; spreadsheet → real Google Sheet; claude_code → sharpened brief file;
  agent → free-form work product. Every mission carries its own fallback
  ("if not connected, write the .ics/.eml/.md/.csv in cwd — never
  authenticate anything"), so nobody connects Google to Earshot for actions.
  **Connector awareness:** capture probes `claude mcp list` (~8s, background
  thread, cached per process) and ships the user's CONNECTED claude.ai
  connectors in its caps message; the hub (a) appends them to every distill
  prompt (connectorContext) so the model offers actions those apps make real
  — verified live: labels changed to "Add to Google Calendar" / "Create
  tasks in Asana" / "Save specs to Google Drive" — (b) names them in each
  task prompt as "verified connected", and (c) shows them in Settings.
  **Send sheet (2026-08-06):** a click no longer fires immediately — it opens
  `dashboard/src/components/ActionSheet.vue`, which offers a free-text
  "your instructions" box and a fold-out preview of the EXACT prompt the
  device agent will get (POST /action/preview, same
  `resolveActionTarget` + `buildTaskPrompt` path as the real send, so the
  preview can't drift from what ships; it re-renders debounced as you type).
  Sending with an empty box = the old behavior byte-for-byte. The notes ride
  /action → dispatchTask → a `# The user's own instructions for this task`
  section placed right after the mission and declared authoritative over it
  (the user typed them while looking at the mission). Trimmed + capped at 4000
  chars hub-side. No device agent = no model to read them, so
  `withUserNotes()` (actions.js) folds them into the artifact payload instead
  (email→body, note→markdown, brief→brief, else notes) on a COPY — the stored
  bubble keeps the model's original payload. Works identically on archived
  bubbles (the sheet passes sessionId through). ⌘/Ctrl+Enter sends, Esc
  cancels. **The instructions are part of the record:** they're written to
  `action.userNotes` on the bubble (live board via persistBubble; archive via
  setBubbleActionStatus's optional `notes` arg — passed on click, omitted on
  the task_done write so finishing never erases it), rendered under the
  buttons, included in md exports ("You asked (label): …"), and pre-filled
  when the sheet reopens. An empty box on a re-run clears the old note (that's
  why "" is a real value, distinct from undefined). Because a distill `update`
  op rewrites a bubble's whole actions array, `carryActionHistory` in
  distill.js re-applies status + userNotes onto actions that survive — matched
  on id AND label AND type, since ids are positional (a0, a1) and the model
  reuses them for different actions.
  **Threads — a Claude session per concept (2026-08-06):** a click no longer
  fires a one-shot task; it opens a CONVERSATION that lives on the bubble.
  New Mongo collection `threads`, one doc per (session, bubble, action):
  `{claudeSessionId, status, messages[]}`, where messages are what the user's
  own Claude streamed back. Capture forwards stream-json as compact display
  items (`_stream_items` in main.py: assistant text, thinking, `tool` with the
  one interesting arg, `tool_result` truncated to 800 chars — raw tool payloads
  never cross the wire) via `{type:"task_stream", id, threadId, items}`, plus
  `{type:"task_session"}` carrying Claude's own session id. The hub appends,
  persists, and broadcasts `{type:"thread", threadId, messages, status}`; the
  dashboard renders it terminal-style in ActionSheet.vue and follows along
  live. **Follow-ups resume that same session:** POST /thread/reply →
  dispatchTask with `resume: claudeSessionId` and the user's text as the WHOLE
  prompt (no mission, no transcript — the resumed session on their machine
  still holds it), and capture spawns `claude -p --resume <sid>`. The working
  directory is keyed by threadId, not task id, so every turn of a conversation
  shares one deliverables folder (and only NEW files pop it open). Reads: GET
  /thread?bubbleId&actionId[&sessionId] returns the newest thread for that
  button; clicking an action again starts a fresh thread (a new run), and the
  sheet always shows the latest. `action.threadId` is stored on the bubble so
  the button shows a 💬 and reopens the session — including in the archive
  (setBubbleActionStatus takes `{notes, threadId}`).
  **Deliverables (2026-08-06):** a finished task ends with things the user can
  OPEN, not just prose. The mission prompt asks the agent to close its reply
  with a fenced ```earshot-links block —
  `[{"label","file"}|{"label","url"}]` — which capture parses out of the final
  text (`_parse_links`), strips from the summary, and validates: a `file` must
  exist directly inside that thread's task dir, a `url` must be http(s).
  Whatever the model forgets, every NEW file in the task dir still gets an
  "Open <name>" link, so the buttons appear even with no cooperation. They ride
  task_done → the thread's result message → buttons in the sheet: a url is a
  plain anchor, a file POSTs /thread/open, which sends `{type:"open",
  threadId, file}` down the capture ws (`_open_path`) — the browser can't
  reach a file on the user's machine and file:// links are blocked from an
  https page, so opening happens on the device that holds it. Guardrails:
  the hub strips path separators (a bare NAME crosses the wire), capture
  re-validates against the tasks root, and it refuses to launch runnable
  extensions (`_NEVER_OPEN`: .exe/.bat/.ps1/.lnk/…) — opening the folder
  instead, so a prompt-injected agent can't hand the user a one-click payload.
  This REPLACED the old auto-open of the deliverables folder on completion:
  with real buttons, a window opening itself on every finished turn is noise.
  Tests: capture/test_links.py (parsing + the open guardrails, run on Windows
  and macOS in CI).
  **Stop (2026-08-06):** POST /thread/cancel → hub sends
  `{type:"task_cancel", id}` down the capture ws (capture keeps `_RUNNING`
  task_id → Popen and kills it), and the hub finishes the task IMMEDIATELY
  rather than waiting for a clean exit a killed process may never produce —
  the agent's own late task_done then hits the "not running" guard and is
  ignored. A cancelled task leaves the button `idle` (nothing was finished,
  so it stays clickable) and writes a "You stopped this task." system line
  into the thread. Running actions are clickable on purpose: the click opens
  the live session, which is where Stop lives.
  Click → hub builds a self-contained prompt (mission + payload + bubble +
  last 150 transcript lines with speaker names + Tier-1 context + date) and
  sends {type:"task", id, title, prompt} DOWN the capture ws
  (Tenant.dispatchTask). main.py spawns `claude -p` (prompt via stdin — no
  argv quoting issues; stream-json out) in <app-data>/Earshot/tasks/<id>.
  Guardrails: NO Bash, `--permission-mode acceptEdits` (file writes jailed
  to the task dir), allowlist = WebSearch/WebFetch/ToolSearch +
  mcp__earshot + server-level rules for exactly the user's connected
  connectors (pre-probe fallback: Gmail/Calendar/Drive/Notion); email
  missions say DRAFT only, never send; 14-min watchdog (hub times out at
  15). NOTE: allowing all connected connectors is Connor's
  breadth-over-caution call — a Groundhogg/QuickBooks connector means those
  tools run without asking too; revisit if coworkers get sensitive
  connectors. Progress
  streams back as {type:"task_update", note} / {type:"task_done", ok,
  summary, files}; hub tracks tenant.tasks, broadcasts {type:"tasks"},
  flips the action button running→done/error, and the finished task's
  deliverables become clickable buttons (see "Deliverables" above). Task events bypass
  the recording gate (bubbles stay actionable after Stop). Capture agents
  advertise {type:"caps", claude:true} on connect — _find_claude() checks
  PATH plus common install dirs because Finder/Explorer-launched apps get a
  bare PATH. No capable agent → executeAction fallback (hub Google →
  artifact). UX cues: pulsing "your Claude · <task>" topbar chip with the
  agent's live activity note, spinner on the action button, toast on done.
  Two hard-won spawn facts (both cost a live debug round): (1) connector
  tools are DEFERRED — invisible until a ToolSearch loads them, so every
  mission prompt says "search before deciding it isn't connected"; (2) MCP
  permission rules need SERVER-LEVEL names (mcp__claude_ai_Gmail) — wildcard
  tool patterns (mcp__claude_ai_*) silently deny.
- **MCP endpoint (read + write):** POST /mcp (server/mcp.js — stateless
  Streamable HTTP, @modelcontextprotocol/sdk). Auth: `Authorization: Bearer
  <captureKey>` or the browser cookie; local mode needs none. Read tools (all
  tenant-scoped): list_sessions, get_session, get_transcript,
  search_transcripts, get_live_board. Write tools (edit_notes, name_speakers,
  add_note, remove_note) — see "✦ Ask Claude" above. Settings → "Your Claude" shows a
  copyable `claude mcp add --transport http …` one-liner so ANY of the
  user's Claudes can search their conversations; device task agents get it
  automatically (mcp.json written per task).
- Accepted v1 tradeoff: transcript text reaches a web-enabled agent on the
  user's machine, so a hostile meeting participant is a prompt-injection
  vector. Mitigations: tasks fire only on the user's own click, no Bash,
  writes jailed to the task dir, work is visible in the topbar chip. Since
  2026-08-11 that agent can also edit the board — the blast radius of a bad
  edit is the user's own notes (nothing external), every edit is narrated in
  the thread the user opened, and only kind/title/summary/details/actions are
  writable, but an injected instruction CAN reword a card. Judged acceptable
  for a personal tool; revisit before productizing.
- Tests: ci_test.mjs covers caps→dispatch→progress→done, calendar/email
  routing preference, no-agent fallbacks (brief + .eml), MCP auth + tenant
  scoping (EARSHOT_TEST_SEED=1 enables POST /test/seed-bubble — bubbles
  without an LLM). Verified with real binaries: `claude` CLI against /mcp
  (listed 12 real sessions), _run_task end-to-end (file written under
  acceptEdits, MCP called from inside the task), and the FULL production
  path — seeded email action click → hub → capture ws → spawned Claude →
  real Gmail draft in Connor's account via his claude.ai connector.

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
windows/). **Claude auth is NOT per-user anymore** (2026-08-05): distills run
on ONE shared server key EARSHOT_ANTHROPIC_KEY (sk-ant-api03-…, billed to
Connor/GBN, pay-per-use), passed to the Agent SDK as ANTHROPIC_API_KEY via
options.env — coworkers connect nothing, the Settings "Connect Claude" step
is gone. Why not an OAuth button: Anthropic bans third-party OAuth clients for
claude.ai login / subscription tokens (see [[earshot-claude-auth-constraint]]
in auto-memory), so subscription billing can't be wired up without the
terminal `setup-token` paste — which is also being deprecated for third-party
apps. Legacy per-user token path (claudeTokenEnc + /me/claude-token, AES-GCM
w/ EARSHOT_SECRET) still exists in code as a fallback when EARSHOT_ANTHROPIC_KEY
is unset, but has no UI. Topbar warning chips show "no capture agent" /
"distilling offline" (key missing) live (per-tenant ws status messages).
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
auto-installs Python via winget; mac one installs BlackHole via
capture/mac_blackhole.py. Verified E2E on real Windows: generated bat → deps →
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
- Claude billing: one shared EARSHOT_ANTHROPIC_KEY (sk-ant-api03-…) for all
  tenants, billed to Connor/GBN pay-per-use (Connor's call — coworkers connect
  nothing; the OAuth/subscription path isn't available to third parties). Set
  it in the rusty env file. Legacy fallback: CLAUDE_CODE_OAUTH_TOKEN env or
  per-user tokens when the shared key is unset. deploy/ has Dockerfile
  (installs claude-code CLI), docker-compose.yml (one service per user,
  separate EARSHOT_DB + out/ volume), Caddyfile (TLS per subdomain),
  .env.example.
- Mac capture: capture/mac_audio.py (sounddevice; system audio via BlackHole
  2ch + Multi-Output Device), platform switches in main.py (cpu/small.en
  defaults on darwin). **BlackHole is installed FOR the user**
  (capture/mac_blackhole.py, offered once on the app's first run and by the
  script installer): existential.audio gates its download behind an
  email/donate form and BlackHole's GitHub releases are SOURCE ONLY — there
  has never been a .pkg asset, so the old "grep the latest release" installer
  step produced an empty URL and killed the install under `set -e`. We fetch
  the direct pkg URL Homebrew's cask uses, pinned with its sha256 (their host
  406s a default urllib User-Agent — send a browser one), verify before
  handing it to Apple's Installer, and continue mic-only if anything fails.
  Bump URL + hash together; capture/test_blackhole.py asserts the live file
  still matches (mac CI). Killing the driver entirely means CoreAudio process
  taps (14.4+), which only prompt for the "System Audio Recording" permission
  on a SIGNED app — blocked on the Apple Developer Program. mac/ has a click-only installer (`Install
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
NOTE (2026-08-05): this hub-side Google path is now the SECOND preference for
calendar/email actions — a connected device agent (user's own Claude +
claude.ai connectors) takes them first; hub Google remains the only source of
Tier-1 calendar CONTEXT (the record-start fetch runs hub-side).

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
- **Distill auth**: uses `@anthropic-ai/claude-agent-sdk`. Local mode rides
  the machine's own Claude Code login (no key). Hosted mode passes the shared
  EARSHOT_ANTHROPIC_KEY as ANTHROPIC_API_KEY via options.env (Tenant.claudeEnv
  strips CLAUDE_CODE_OAUTH_TOKEN from the child env so the SDK sees exactly one
  auth source).
- **LLM date math is unreliable**: the model resolved "next Thursday" to a
  Friday. The prompt includes an explicit 14-day weekday/date calendar
  (`upcomingDays()` in distill.js). Keep it.
- **Actions are local-artifact based** (no external auth): .ics opened by
  default calendar app, .eml with `X-Unsent: 1` opens as editable draft,
  .csv → Excel, claude_code → brief .md in out/. Upgrade path is real MCP
  connectors (Google Calendar, Gmail) through the Agent SDK.
- The python venv was moved with the project — fine for `python.exe` runs;
  pip console scripts have stale shebangs, use `python -m pip` if needed.
- **Windowed PyInstaller apps have sys.stdout/stderr = None** — prints
  vanish and stderr-writing libs can kill threads. tray.py redirects both to
  `<app-data>/Earshot/capture.log` (read that file FIRST when the exe
  misbehaves). And faster-whisper's `vad_filter=True` loads
  `faster_whisper/assets/silero_vad_v6.onnx` at TRANSCRIBE time — the bundle
  needs `--collect-all faster_whisper` or every segment errors NO_SUCHFILE
  while the app looks perfectly connected (2026-08-05: shipped exe captured
  nothing for exactly this reason; CI smoke now asserts the asset exists).
- **Two capture agents on one account = every line stored twice** (four = 4x).
  They hear the same microphone, so duplication looks like an ASR bug but is a
  process-count bug — the copies differ slightly ("it's not even, it's not." vs
  "…, it's not, it's not.") because each segments independently. Diagnosed
  2026-08-06 from a dupRatio of 1.6-1.8 on the day's sessions; cause was four
  live EarshotCapture.exe instances, three of them an older download whose
  single-instance guard predated the feature (a stale exe stays stale — after
  changing capture code, CI builds it but `sync-apps.sh` on rusty is what
  publishes it). Fixes: the hub now ingests stream events from ONE capture
  socket per tenant (`Tenant.streamOwner`, ownership passes on close or 15s of
  silence; extras stay connected for tasks/caps and cost zero Groq spend), the
  dashboard shows a "⚠ N capture agents" chip, and tray.py's guard gained an
  exclusive lock file (the mutex was Windows-only — macOS had NO guard at all)
  plus it opens the dashboard when it exits as a second instance, so a click
  that "does nothing" doesn't invite three more.
- **Audio interfaces can idle above SPEECH_RMS** (Focusrite floor ~0.0135 vs
  0.010 threshold) → segmenter saw never-ending speech. Segmenter now tracks
  a per-stream noise floor (fast fall, slow rise) and requires
  `max(SPEECH_RMS, floor * FLOOR_MARGIN)`.

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

Ask Claude / authoritative user edits: DONE (2026-08-11) — per-concept + global
button, MCP write tools, pinned notes and voices, in-flight distill guard. See
the section above; verified against the real CLI + a real distill.

Session archive: DONE (2026-08-06) — searchable sidebar, click-to-reopen,
md/txt/json export (see "Session archive" above). Verified against the real
dev cluster + CI.

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
5 voices into 7); re-check on a live Teams call. Extended 2026-08-07 to the
MIC channel with an elected + persisted owner voiceprint — see "Speaker
identity" above. ⚠ Not yet verified on a real two-people-one-mic recording
(a speakerphone call); CI covers the logic and real TTS voices only.

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
