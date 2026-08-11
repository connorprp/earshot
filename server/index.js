// Earshot hub, multi-tenant: websocket fan-in (capture) / fan-out (dashboards),
// per-user distill scheduling, the action API, and (hosted mode) the dashboard
// itself + auth. Every signed-in Google account (or capture key) maps to a
// Tenant that owns ALL of its own state — board, transcript, recording flag,
// echo suppression, sessions, artifact files — so users never see each other's
// data. Local mode (no EARSHOT_GOOGLE_CLIENT_ID) runs a single "local" tenant.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { distill, applyOps } from "./distill.js";
import { applyEditOps, applyArchivedEdit, boardSnapshot, notesBlock, EDIT_DOC } from "./boardedit.js";
import { executeAction, withUserNotes } from "./actions.js";
import { closeoutSession } from "./closeout.js";
import { handleMcp } from "./mcp.js";
import { renderExport, speakerLabel } from "./export.js";
import {
  authEnabled,
  publicConfig,
  verifyGoogleCredential,
  sessionCookie,
  browserUser,
  envCaptureKeyPairs,
  encryptSecret,
  decryptSecret,
} from "./auth.js";
import {
  googleConfigured,
  buildAuthUrl,
  handleCallback,
  currentCalendarEvent,
} from "./google.js";
import { groqConfigured, transcribeSegment, ASR_MODELS, defaultAsrMode } from "./asr.js";
import {
  initDb,
  seedCaptureKeys,
  loadUsers,
  getOrCreateUser,
  rotateCaptureKey,
  setClaudeToken,
  setUserField,
  directory,
  userByCaptureKey,
  usersWithOpenSessions,
  resumeSession,
  saveSessionReport,
  startSession,
  endSession,
  persistTranscript,
  persistSpeakers,
  persistSpeakerNames,
  persistOps,
  persistBubble,
  persistRemoval,
  listSessions,
  getSession,
  getSessionBubble,
  getSessionTail,
  setBubbleActionStatus,
  getPreviousSession,
  saveThread,
  appendThreadMessages,
  getThread,
  findThreads,
} from "./db.js";

const PORT = process.env.EARSHOT_PORT || 7071;
const DISTILL_EVERY_MS = 18_000; // distill at most this often...
const DISTILL_MIN_LINES = 1;     // ...when at least this many new lines exist
const DISTILL_EAGER_LINES = 6;   // distill immediately at this many lines
const RESTORE_WINDOW_MS = 45 * 60 * 1000; // Record this soon after a Stop -> restore bubbles provisionally
const RESTORE_MAX_DISTILLS = 4;  // restored bubbles untouched after this many distills get dropped
// echo suppression backstop (layer 2; capture's timing gate is layer 1).
// Constants tuned against a real captured echo set — see CLAUDE.md.
const ECHO_WINDOW_MS = 15_000;   // a "them" line this recent can claim a "me" line as its echo
const ECHO_HOLD_MS = 6_000;      // "me" lines wait this long in case their "them" twin arrives late
const ECHO_OVERLAP = 0.62;       // fraction of "me" tokens fuzzy-found in one "them" line = echo
const TASK_TIMEOUT_MS = 15 * 60 * 1000; // device-agent task with no task_done by then = error
const PRIMARY_IDLE_MS = 15_000;  // stream ownership can pass to another agent after this much silence
const TASK_PRUNE_MS = 60_000;    // finished tasks linger this long in the dashboard task list
// "✦ Ask Claude" threads reuse the (session, bubble, action) thread key: the
// action is always ASK_ACTION, and a board-wide chat hangs off BOARD_BUBBLE
// instead of a concept. Both are reserved ids no distill can produce.
const ASK_ACTION = "__ask";
const BOARD_BUBBLE = "__board";

// Shared server-side API key (sk-ant-api03-…): when set, EVERY tenant's
// distills run on it (billed to this API account, not any coworker's
// subscription). This is the sanctioned third-party path — Anthropic does not
// allow apps to mint subscription tokens via OAuth. See CLAUDE.md.
const SHARED_ANTHROPIC_KEY = process.env.EARSHOT_ANTHROPIC_KEY || "";

// per-user Claude subscription tokens: "email:sk-ant-oat...,email:..." —
// legacy fallback used only when SHARED_ANTHROPIC_KEY is unset.
const CLAUDE_TOKENS = new Map(
  (process.env.EARSHOT_CLAUDE_TOKENS || "")
    .split(",")
    .map((pair) => pair.trim().split(/:(.+)/s))
    .filter(([email, token]) => email && token)
    .map(([email, token]) => [email.toLowerCase(), token])
);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(ROOT, "..", "dashboard", "dist");
const OUT_ROOT = path.join(ROOT, "..", "out");

// ---------- tenant ----------
class Tenant {
  constructor(userId) {
    this.userId = userId;
    // notes + speakerPins are the USER's own edits (see boardedit.js): standing
    // corrections that ride in every distill prompt, and voice names a later
    // distill may not overwrite.
    this.state = { bubbles: [], speakers: {}, speakerPins: [], notes: [], rev: 0 };
    this.userEdits = new Map(); // bubbleId -> when the user last edited it
    this.transcript = [];       // full session log, in memory
    this.pending = [];          // lines not yet distilled
    this.distilling = false;
    this.lastDistill = 0;
    this.recording = false;     // capture lines are dropped unless recording
    this.speakerProfiles = []; // latest voice-cluster snapshot from capture
    this.activeSpeakers = new Set();
    this.sessionId = null;
    this.lastSessionId = null;   // the stopped session still on the board (bubbles stay actionable)
    this.sessionStartedAt = null;
    this.distillNote = "";      // context prepended to distills while restored bubbles are unconfirmed
    this.restoreState = null;   // { distills } while provisionally-restored bubbles await confirmation
    this.recentThem = [];       // [{ set, list, at }] for echo matching
    this.heldMe = new Set();    // { ev, tokens, timer } "me" lines waiting out ECHO_HOLD_MS
    this.dashboards = new Set();
    this.captureSockets = new Set();
    this.primaryCapture = null;  // the one capture socket whose audio we ingest
    this.primaryLastAt = 0;      // last stream event from it (ownership can pass when quiet)
    this.sessionContext = ""; // Tier-1 context: directory + current calendar meeting
    this.googleConnected = false;
    this.asrMode = defaultAsrMode(); // "local" | "groq"; user pref overrides on hydration
    this.asrModel = null;            // local-mode whisper model; null = agent's platform default
    this.groqChain = Promise.resolve(); // serializes Groq calls per tenant (transcript order)
    this.tasks = new Map();      // device-agent tasks: id -> {id, bubbleId, actionId, title, status, note}
    this.threads = new Map();    // agent conversations: threadId -> {bubbleId, actionId, claudeSessionId, messages[]}
    this.taskTimers = new Map(); // task id -> timeout handle (kept out of the JSON-serialized task)
    this.claudeToken = CLAUDE_TOKENS.get(userId) || null; // may be replaced from the user's stored token
    this.outDir = path.join(OUT_ROOT, userId === "local" ? "local" : userId.replace(/[^a-z0-9]+/gi, "-"));
    fs.mkdirSync(this.outDir, { recursive: true });
  }

  get claudeEnv() {
    // Shared API key wins: pass it as ANTHROPIC_API_KEY and strip any OAuth
    // token from the child env so Claude Code doesn't see two auth sources.
    if (SHARED_ANTHROPIC_KEY) {
      const env = { ...process.env, ANTHROPIC_API_KEY: SHARED_ANTHROPIC_KEY };
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      return env;
    }
    return this.claudeToken ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: this.claudeToken } : null;
  }

  // local mode rides the machine's own Claude login; hosted needs the shared
  // API key (or, legacy, a per-user token / process-env OAuth token)
  get claudeConnected() {
    return !authEnabled || Boolean(SHARED_ANTHROPIC_KEY || this.claudeToken || process.env.CLAUDE_CODE_OAUTH_TOKEN);
  }

  status() {
    return {
      type: "status",
      captureConnected: this.captureSockets.size > 0,
      captureAgents: this.captureSockets.size, // >1 = duplicate audio, extras muted
      claudeConnected: this.claudeConnected,
      googleConnected: this.googleConnected,
      asrMode: this.asrMode,
      asrOk: this.asrMode !== "groq" || groqConfigured,
      agentAvailable: Boolean(this.agentSocket()),
      agentConnectors: this.agentConnectors(),
    };
  }

  // ---- device-agent tasks ----
  // "agent" actions don't run on the hub at all: the task (a self-contained
  // prompt) goes DOWN the capture websocket to the user's machine, where the
  // capture agent spawns the user's own Claude Code (their login, their
  // billing) to do the real work. The hub's contribution is context: it holds
  // the transcript, bubble, and session context the local agent can't see.
  agentSocket() {
    for (const ws of this.captureSockets) if (ws.readyState === 1 && ws._caps?.claude) return ws;
    return null;
  }

  // apps connected to the user's own Claude (claude.ai connectors), as
  // reported by their capture agent — steers both the distill (which action
  // buttons to offer) and the task missions (where deliverables land)
  agentConnectors() {
    const all = new Set();
    for (const ws of this.captureSockets)
      if (ws.readyState === 1 && ws._caps?.claude) for (const c of ws._caps.connectors || []) all.add(c);
    return [...all];
  }

  // appended to the distill context live (caps can change mid-session)
  connectorContext() {
    const apps = this.agentConnectors();
    if (!apps.length) return "";
    return (
      `\nAction buttons execute through the user's own Claude agent, which has these apps ` +
      `connected: ${apps.join(", ")}. Prefer actions those apps make REAL (email → Gmail draft, ` +
      `scheduling → Google Calendar event, notes/docs → Notion or Drive, spreadsheets → Google ` +
      `Sheets, tasks → Asana/Linear/monday) and word labels accordingly ("Draft in Gmail", ` +
      `"Add to Google Calendar").`
    );
  }

  tasksMsg() {
    return { type: "tasks", tasks: [...this.tasks.values()] };
  }

  broadcastTasks() {
    this.broadcast(this.tasksMsg());
  }

  // per-type mission: calendar/email actions prefer the user's ALREADY
  // CONNECTED apps (claude.ai connectors surface in their Claude Code as
  // mcp__claude_ai_* tools) — no Earshot-side Google OAuth involved
  taskMission(bubble, action) {
    const p = action.payload || {};
    // connector tools are DEFERRED in Claude Code — they don't appear until a
    // ToolSearch loads them, so every mission must say "search before you
    // decide it isn't connected" (verified live: without this line the agent
    // wrote the fallback artifact while a working Gmail connector sat unused)
    if (action.type === "calendar") {
      return [
        `Create this calendar event for the user:`,
        JSON.stringify(p, null, 1),
        ``,
        `- FIRST run ToolSearch (e.g. "google calendar create event") — the user's connected apps are deferred tools that only appear after a search.`,
        `- If Google Calendar tools load (mcp__claude_ai_Google_Calendar__*), create the real event there, inviting the listed attendees.`,
        `- Only if no calendar tools exist (never try to authenticate anything): write the event as an RFC-5545 .ics file in the current working directory instead.`,
      ].join("\n");
    }
    if (action.type === "email") {
      return [
        `Draft this email for the user:`,
        JSON.stringify(p, null, 1),
        ``,
        `- FIRST run ToolSearch (e.g. "gmail create draft") — the user's connected apps are deferred tools that only appear after a search.`,
        `- If Gmail tools load (mcp__claude_ai_Gmail__*), create a DRAFT with create_draft. NEVER send an email — drafts only; the user reviews and sends.`,
        `- Only if no Gmail tools exist (never try to authenticate anything): write a .eml file (starting with an "X-Unsent: 1" header line) in the current working directory instead.`,
        `- If the subject or body is thin, complete it from the conversation context below.`,
      ].join("\n");
    }
    if (action.type === "note") {
      return [
        `Save this note for the user:`,
        JSON.stringify(p, null, 1),
        ``,
        `- FIRST run ToolSearch — the user's connected apps are deferred tools that only appear after a search.`,
        `- Save it where the user keeps notes: a Notion page if Notion is connected, else a Google Doc (Google Drive create_file) titled like the note.`,
        `- Only if neither is connected (never try to authenticate anything): write it as a .md file in the current working directory.`,
      ].join("\n");
    }
    if (action.type === "spreadsheet") {
      return [
        `Create this spreadsheet for the user:`,
        JSON.stringify(p, null, 1),
        ``,
        `- FIRST run ToolSearch — the user's connected apps are deferred tools that only appear after a search.`,
        `- If Google Drive is connected, create it as a real Google Sheet (create_file supports Google Workspace types) so the user can open and extend it.`,
        `- Only if Drive isn't connected (never try to authenticate anything): write a .csv in the current working directory.`,
      ].join("\n");
    }
    if (action.type === "claude_code") {
      return [
        `Prepare this coding task for the user:`,
        JSON.stringify(p, null, 1),
        ``,
        `- Write the full brief to a "<slug>-brief.md" file in the current working directory so the user can hand it to a coding session with repo access.`,
        `- You have no repository access here — do NOT attempt the code changes; sharpen the brief instead (acceptance criteria, files likely involved if the conversation named any).`,
      ].join("\n");
    }
    return p.brief || bubble.summary || "";
  }

  // ctx lets an ARCHIVED bubble supply its own session's transcript/names/date
  // instead of the live board's — running a past session's button must never
  // read the conversation happening right now.
  // notes = whatever the user typed in the send sheet before clicking; it wins
  // over the model-written mission (they saw the mission and chose to change it)
  buildTaskPrompt(bubble, action, ctx = null, notes = "") {
    const p = action.payload || {};
    const names = ctx ? ctx.speakerNames || {} : this.state.speakers || {};
    const who = (l) => speakerLabel(l, names);
    const lines = ctx ? ctx.lines || [] : this.transcript.slice(-150);
    const transcript = lines.map((l) => `[${who(l)}] ${l.text}`).join("\n");
    const past = ctx
      ? `This conversation is NOT happening right now: it was recorded${ctx.title ? ` as "${ctx.title}"` : ""}` +
        `${ctx.startedAt ? ` on ${new Date(ctx.startedAt).toDateString()}` : ""}, and the user is acting on it after the fact. ` +
        `Treat any relative dates spoken in it ("Thursday", "next week") relative to that recording date, and prefer explicit dates in what you produce.`
      : "";
    return [
      `You are completing a real-world task on behalf of the user ("Me"). It was identified during a ${ctx ? "" : "live "}conversation captured by Earshot, an ambient meeting assistant. Work autonomously — nobody is available to answer questions.`,
      ...(past ? [``, past] : []),
      ``,
      `# Task: ${p.title || p.subject || action.label || bubble.title}`,
      ``,
      this.taskMission(bubble, action),
      ...(notes
        ? [
            ``,
            `# The user's own instructions for this task`,
            `The user typed these just now, while looking at the task above. They are the most`,
            `recent and most authoritative word on what they want: where they conflict with`,
            `anything else here, follow these. Do not treat them as optional flavor.`,
            ``,
            notes,
          ]
        : []),
      ``,
      `# The conversation concept this came from`,
      JSON.stringify({ title: bubble.title, summary: bubble.summary, details: bubble.details || [] }, null, 1),
      ...(ctx?.report ? [``, `# Report from that session`, JSON.stringify(ctx.report, null, 1)] : []),
      ...(this.sessionContext ? [``, `# Context`, this.sessionContext] : []),
      ...(transcript ? [``, `# ${ctx ? "Conversation transcript (that session)" : "Recent conversation transcript"}`, transcript] : []),
      ``,
      `Current datetime: ${new Date().toString()}`,
      ``,
      `# Instructions`,
      `- The user's own connected apps are available as mcp__claude_ai_* tools${this.agentConnectors().length ? ` — verified connected: ${this.agentConnectors().join(", ")}` : " (Gmail, Google Calendar, Google Drive, ...)"}. They are DEFERRED — run ToolSearch to load them before concluding one isn't connected. Prefer them whenever the task calls for a real-world object (an email draft, a calendar event, a shared doc). Never authenticate or connect a new service, and never SEND email — drafts only.`,
      `- Otherwise produce the deliverable as one or more files in the current working directory (markdown unless the task clearly calls for another format).`,
      `- An "earshot" MCP server is connected, holding the user's past recorded conversations (list_sessions, get_session, get_transcript, search_transcripts, get_live_board). Use it when the task needs context beyond the transcript above.`,
      `- The transcript is speech-to-text: words get garbled and tense/agency can flip. Hedge uncertain facts rather than inventing specifics.`,
      `- End with a 2-3 sentence summary of what you produced (mention where it landed: Gmail draft, calendar, or files).`,
      // the dashboard turns this into real buttons — a file opens on the
      // user's machine, a url opens in their browser
      `- Then, as the LAST thing in your reply, list what you made so the user can open it, in a fenced block exactly like this (omit the block only if you produced nothing):`,
      "```earshot-links",
      `[{"label": "Open the proposal", "file": "proposal.docx"}, {"label": "Open the Gmail draft", "url": "https://mail.google.com/mail/u/0/#drafts?compose=..."}]`,
      "```",
      `  Use "file" for something you wrote in the working directory (name only, no path) and "url" for anything that lives on the web — the real link to the draft, event, doc, sheet or page you created, never a guessed one. Label them the way a person would say it out loud.`,
    ].join("\n");
  }

  // ---- "✦ Ask Claude": the general-purpose channel to the user's own agent ----
  // Not a hedged button the model offered — the user's own words, either about
  // one concept or about the whole board. The agent can do anything a task agent
  // can (research, drafts, real objects through their connected apps) AND edit
  // the notes live through the earshot MCP write tools, which is what makes
  // "actually, them-2 is Dave" land on every screen a second later.
  buildAskPrompt(text, { bubble = null, ctx = null } = {}) {
    const names = ctx ? ctx.speakerNames || {} : this.state.speakers || {};
    const who = (l) => speakerLabel(l, names);
    const lines = ctx ? ctx.lines || [] : this.transcript.slice(-150);
    const transcript = lines.map((l) => `[${who(l)}] ${l.text}`).join("\n");
    const board = ctx
      ? boardSnapshot({ bubbles: ctx.bubbles || [], speakers: names, notes: ctx.notes || [] })
      : boardSnapshot(this.state);
    return [
      `You are the user's own Claude, working inside Earshot — an ambient dashboard that listens to their ${ctx ? "recorded" : "live"} conversation and distills it into "concept" cards with action buttons. The user just asked you something directly. Work autonomously: nobody is available to answer questions.`,
      ...(ctx
        ? [
            ``,
            `This conversation is NOT happening right now: it was recorded${ctx.title ? ` as "${ctx.title}"` : ""}` +
              `${ctx.startedAt ? ` on ${new Date(ctx.startedAt).toDateString()}` : ""} and the user reopened it from their archive. ` +
              `Resolve anything relative said in it ("Thursday", "next week") against that date.`,
          ]
        : []),
      ``,
      `# What the user asked`,
      text,
      ...(bubble
        ? [
            ``,
            `# They asked it from this concept card (id "${bubble.id}")`,
            JSON.stringify(
              { id: bubble.id, kind: bubble.kind, title: bubble.title, summary: bubble.summary, details: bubble.details || [] },
              null,
              1
            ),
            `Unless they say otherwise, this card is what they mean by "this", "that" and "it".`,
          ]
        : []),
      ``,
      `# Their notes board right now`,
      JSON.stringify(board, null, 1),
      ...(this.sessionContext ? [``, `# Context`, this.sessionContext] : []),
      ...(transcript ? [``, `# ${ctx ? "Transcript of that session" : "Recent conversation transcript"}`, transcript] : []),
      ``,
      `Current datetime: ${new Date().toString()}`,
      ``,
      `# What you can do`,
      `1. EDIT THE NOTES. The "earshot" MCP server has write tools — edit_notes, name_speakers, add_note, remove_note — and what they change appears on the user's screen within a second. Use them whenever the ask is about the notes themselves: naming a speaker, fixing a wrong fact, re-titling or re-classifying a card, splitting or merging cards, adding context, deleting something that never mattered. Reference concepts by the exact ids above.`,
      `   ${EDIT_DOC.split("\n").join("\n   ")}`,
      `   Your edits are AUTHORITATIVE: the automatic distiller is told never to revert them. So edit precisely, keep the cards short and glanceable (a title of 3-6 words, a 1-2 sentence summary, a few load-bearing bullets), and change NOTHING the user didn't ask about.`,
      `   add_note is for a standing correction or piece of context that should shape everything the distiller does from now on ("Dave is the vendor, not staff", "we decided against the Q4 launch") — use it when the fix belongs to the whole conversation rather than one card.`,
      `2. DO THE WORK. This is also just a general-purpose request: research it, draft it, look things up, produce files. The user's own connected apps are available as mcp__claude_ai_* tools${this.agentConnectors().length ? ` — verified connected: ${this.agentConnectors().join(", ")}` : " (Gmail, Google Calendar, Google Drive, ...)"}. They are DEFERRED — run ToolSearch before concluding one isn't connected. Never authenticate or connect a new service, and never SEND email (drafts only). Files go in the current working directory.`,
      `3. LOOK THINGS UP. The same earshot MCP server holds every conversation they've ever recorded (list_sessions, get_session, get_transcript, search_transcripts, get_live_board) — use it when the ask reaches past this conversation, and to re-read the board after you edit it.`,
      ``,
      `# Instructions`,
      `- Do what they asked, then say what you did in 2-3 sentences. If you edited the notes, name what changed; the cards themselves are already on their screen, so don't paste them back.`,
      `- The transcript is speech-to-text: words get garbled and tense/agency can flip. Prefer the user's correction over what the transcript says, and hedge uncertain facts instead of inventing specifics.`,
      `- If the ask is ambiguous, take the most useful reasonable reading and say which one you took.`,
      // same convention as action tasks: a finished turn hands over openable things
      `- If you produced a file or created something on the web, end with a fenced block exactly like this (omit it if you produced nothing openable):`,
      "```earshot-links",
      `[{"label": "Open the comparison", "file": "vendors.md"}, {"label": "Open the Gmail draft", "url": "https://mail.google.com/mail/u/0/#drafts?compose=..."}]`,
      "```",
      `  "file" = a name in the working directory, "url" = the real link to what you made. Never a guessed one.`,
    ].join("\n");
  }

  // returns the task if it was dispatched, null if no capable device agent.
  // opts.sessionId + opts.ctx mark it as an archived-session action;
  // opts.notes carries the user's typed instructions into the prompt;
  // opts.thread attaches it to a concept's conversation (opts.prompt +
  // opts.resume = a follow-up turn continuing that same Claude session).
  dispatchTask(bubble, action, opts = {}) {
    const ws = this.agentSocket();
    if (!ws) return null;
    const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const p = action.payload || {};
    const task = {
      id,
      bubbleId: bubble.id,
      actionId: action.id,
      sessionId: opts.sessionId || null, // set = the bubble lives in the archive, not on the board
      threadId: opts.thread?.id || null,
      title: p.title || p.subject || action.label || bubble.title,
      status: "running",
      note: "sent to your device",
      startedAt: Date.now(),
    };
    this.tasks.set(id, task);
    this.taskTimers.set(
      id,
      setTimeout(
        () => this.handleTaskEvent({ type: "task_done", id, ok: false, summary: "Timed out — no result from the device agent after 15 minutes." }),
        TASK_TIMEOUT_MS
      )
    );
    ws.send(
      JSON.stringify({
        type: "task",
        id,
        threadId: task.threadId,
        title: task.title,
        prompt: opts.prompt || this.buildTaskPrompt(bubble, action, opts.ctx || null, opts.notes || ""),
        // the claude session id of an earlier turn: the agent resumes THAT
        // conversation instead of starting a new one
        resume: opts.resume || null,
      })
    );
    this.log(`task ${id} -> device agent: ${task.title}${opts.resume ? " (follow-up)" : ""}`);
    this.broadcastTasks();
    return task;
  }

  // ---- agent threads ----
  // A thread is one Claude conversation, owned by the concept it came from:
  // (session, bubble, action). Its messages are what the user's own Claude
  // streamed back — the same text a terminal would print — so the dashboard
  // can show the session live and the user can keep talking to it.
  threadView(th) {
    return { ...th, messages: th.messages || [] };
  }

  // the NEWEST thread for that button: clicking an action again starts a fresh
  // run, and the sheet should open the conversation the user just started
  async lookupThread(sessionKey, bubbleId, actionId) {
    let newest = null;
    for (const th of this.threads.values())
      if (th.sessionId === sessionKey && th.bubbleId === bubbleId && th.actionId === actionId)
        if (!newest || new Date(th.updatedAt) >= new Date(newest.updatedAt)) newest = th;
    if (newest) return newest;
    const [doc] = await findThreads(this.userId, { sessionId: sessionKey, bubbleId, actionId }, 1).catch(() => []);
    if (!doc) return null;
    const th = { ...doc, id: doc._id, messages: doc.messages || [] };
    delete th._id;
    this.threads.set(th.id, th);
    return th;
  }

  async threadById(threadId) {
    if (this.threads.has(threadId)) return this.threads.get(threadId);
    const doc = await getThread(this.userId, threadId).catch(() => null);
    if (!doc) return null;
    const th = { ...doc, id: doc._id, messages: doc.messages || [] };
    delete th._id;
    this.threads.set(th.id, th);
    return th;
  }

  newThread(sessionKey, bubble, action) {
    const th = {
      id: `th-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      userId: this.userId,
      sessionId: sessionKey,
      bubbleId: bubble.id,
      actionId: action.id,
      actionLabel: action.label || "",
      actionType: action.type,
      concept: bubble.title, // "organized by concept" is the whole point: a
      title: (action.payload || {}).title || action.label || bubble.title, // thread never floats free of its bubble
      claudeSessionId: null,
      status: "idle",
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.threads.set(th.id, th);
    saveThread(th);
    return th;
  }

  // An "✦ Ask Claude" conversation: same thread machinery, anchored either to a
  // concept or to the board itself (bubbleId BOARD_BUBBLE), so reopening the
  // button finds it exactly like an action's session.
  newAskThread(sessionKey, bubble, text) {
    const th = this.newThread(sessionKey, bubble || { id: BOARD_BUBBLE, title: "the whole board" }, {
      id: ASK_ACTION,
      label: "Ask Claude",
      type: "ask",
      payload: {},
    });
    th.title = text.split("\n")[0].slice(0, 70) || "Ask Claude";
    th.concept = bubble ? bubble.title : "the whole board";
    saveThread(th);
    return th;
  }

  // ---- the user's own edits to the board ----
  // Called from the MCP write tools (mcp.js). threadId, when the device agent
  // sent one, says WHICH conversation the edit belongs to — that decides whether
  // it lands on the live board or on an archived session, and lets the user see
  // "✎ updated …" inside the chat they asked from.
  async applyUserEdit(ops, threadId = "") {
    const th = threadId ? await this.threadById(threadId).catch(() => null) : null;
    const board = this.boardSessionId() ? String(this.boardSessionId()) : null;
    const key = th?.sessionId || null;
    const archivedId = key && key !== "live" && key !== board ? key : null;
    const res = archivedId
      ? await applyArchivedEdit(this.userId, archivedId, ops)
      : this.applyLiveEdit(ops);
    if (archivedId && res.changed) this.broadcast({ type: "session_patch", sessionId: archivedId });
    if (th && res.summary.length) this.appendThread(th, [{ role: "system", text: `✎ ${res.summary.join("; ")}` }]);
    if (res.summary.length) this.log(`user edit${archivedId ? ` (archived ${archivedId})` : ""}: ${res.summary.join("; ")}`);
    return res;
  }

  applyLiveEdit(ops) {
    const res = applyEditOps(this.state, ops);
    res.board = boardSnapshot(this.state);
    if (!res.changed) return res;
    const sid = this.boardSessionId();
    for (const b of res.touched) persistBubble(this.userId, sid, b);
    for (const id of res.removedIds) persistRemoval(sid, id, "user-edit");
    if (res.speakersChanged) persistSpeakerNames(sid, this.state.speakers, this.state.speakerPins);
    if (res.notesChanged) saveSessionReport(sid, { boardNotes: this.state.notes });
    persistOps(this.userId, sid, ops); // same audit trail as a distill batch
    // a distill that started before this edit must not undo it (runDistill)
    for (const id of res.editedIds) this.userEdits.set(id, Date.now());
    this.bumpAndBroadcast();
    return res;
  }

  // the user's standing notes, as the distiller and the closeout see them
  notesForPrompt() {
    return notesBlock(this.state.notes);
  }

  // append + persist + push to open dashboards, all in one place so a live
  // viewer and the stored record can never disagree
  appendThread(th, messages, head = {}) {
    if (!messages.length && !Object.keys(head).length) return;
    const stamped = messages.map((m) => ({ at: new Date(), ...m }));
    th.messages.push(...stamped);
    Object.assign(th, head);
    th.updatedAt = new Date();
    appendThreadMessages(th.id, stamped, head);
    this.broadcast({
      type: "thread",
      threadId: th.id,
      bubbleId: th.bubbleId,
      actionId: th.actionId,
      status: th.status,
      messages: stamped,
    });
  }

  handleTaskEvent(ev) {
    const task = this.tasks.get(ev.id);
    if (!task || task.status !== "running") return;
    if (ev.type === "task_update") {
      task.note = String(ev.note || "").slice(0, 200);
      return this.broadcastTasks();
    }
    // the agent's own session id, learned from the first stream event: this is
    // what a follow-up resumes
    if (ev.type === "task_session") {
      const th = this.threads.get(task.threadId);
      if (th && ev.sessionId) {
        th.claudeSessionId = String(ev.sessionId);
        saveThread(th);
      }
      return;
    }
    // the Claude session as it happens: assistant text, tool calls, results
    if (ev.type === "task_stream") {
      const th = this.threads.get(task.threadId);
      if (!th || !Array.isArray(ev.items) || !ev.items.length) return;
      this.appendThread(
        th,
        ev.items.slice(0, 40).map((it) => ({
          role: ["text", "thinking"].includes(it.kind) ? "assistant" : it.kind === "tool" ? "tool" : "tool_result",
          text: String(it.text || "").slice(0, 6000),
          ...(it.name ? { name: String(it.name).slice(0, 80) } : {}),
          ...(it.ok === false ? { ok: false } : {}),
        }))
      );
      return;
    }
    // task_done
    clearTimeout(this.taskTimers.get(task.id));
    this.taskTimers.delete(task.id);
    task.status = ev.cancelled ? "cancelled" : ev.ok ? "done" : "error";
    task.note = String(ev.summary || "").slice(0, 600);
    task.files = Array.isArray(ev.files) ? ev.files.slice(0, 20).map(String) : [];
    // what the agent made, as things the user can actually open: a file (the
    // device agent opens it) or a url (the browser does)
    task.links = (Array.isArray(ev.links) ? ev.links : [])
      .slice(0, 12)
      .map((l) => ({
        label: String(l.label || "Open").slice(0, 80),
        ...(String(l.url || "").startsWith("http") ? { url: String(l.url).slice(0, 500) } : {}),
        ...(l.file ? { file: String(l.file).slice(0, 200) } : {}),
      }))
      .filter((l) => l.url || l.file);
    task.endedAt = Date.now();
    // a stopped task leaves the button clickable again — nothing was finished
    const buttonStatus = task.status === "cancelled" ? "idle" : task.status;
    // an "✦ Ask Claude" turn has no button to flip (it isn't one of the bubble's
    // actions), so skip straight to the thread and the broadcast
    if (task.actionId === ASK_ACTION) {
      /* nothing to write on the bubble */
    } else if (task.sessionId) {
      // archived bubble: the board doesn't hold it, so the status goes straight
      // to its stored doc and the dashboard patches the session it's viewing
      setBubbleActionStatus(this.userId, task.sessionId, task.bubbleId, task.actionId, buttonStatus);
    } else {
      const bubble = this.state.bubbles.find((b) => b.id === task.bubbleId);
      const action = bubble?.actions?.find((a) => a.id === task.actionId);
      if (action) {
        action.status = buttonStatus;
        persistBubble(this.userId, this.boardSessionId(), bubble);
        this.bumpAndBroadcast();
      }
    }
    const th = this.threads.get(task.threadId);
    if (th) {
      this.appendThread(
        th,
        [
          task.status === "cancelled"
            ? { role: "system", text: "You stopped this task." }
            : { role: "result", text: task.note, ok: ev.ok === true, files: task.files, links: task.links },
        ],
        { status: task.status === "error" ? "error" : "idle", lastTaskId: null }
      );
    }
    this.broadcast({
      type: "task_done",
      ok: ev.ok === true,
      cancelled: task.status === "cancelled",
      title: task.title,
      summary: task.note,
      files: task.files,
      links: task.links,
      bubbleId: task.bubbleId,
      actionId: task.actionId,
      sessionId: task.sessionId,
      threadId: task.threadId,
      status: buttonStatus,
    });
    this.broadcastTasks();
    this.log(`task ${task.id} ${task.status}: ${task.title}`);
    const timer = setTimeout(() => {
      this.tasks.delete(task.id);
      this.broadcastTasks();
    }, TASK_PRUNE_MS);
    timer.unref?.();
  }

  // Stop a task the user changed their mind about. The kill has to happen on
  // their machine (that's where Claude runs), so we ask the agent — but we
  // finish the task here immediately rather than waiting for a clean exit
  // that a killed process may never produce. The agent's own task_done then
  // hits the "not running" guard and is ignored.
  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "running") return false;
    const ws = this.agentSocket();
    if (ws) ws.send(JSON.stringify({ type: "task_cancel", id: taskId }));
    this.handleTaskEvent({ type: "task_done", id: taskId, ok: false, cancelled: true, summary: "Stopped by you." });
    return true;
  }

  runningTaskForThread(threadId) {
    for (const t of this.tasks.values()) if (t.threadId === threadId && t.status === "running") return t;
    return null;
  }

  // downlink to capture agents: which ASR mode to run and (local mode) which
  // whisper model; sent on /ingest connect and on every settings change
  configMsg() {
    return { type: "config", asrMode: this.asrMode, asrModel: this.asrModel };
  }

  pushConfig() {
    const msg = JSON.stringify(this.configMsg());
    for (const ws of this.captureSockets) if (ws.readyState === 1) ws.send(msg);
  }

  async loadStoredToken() {
    const user = await getOrCreateUser(this.userId);
    if (user.asrMode === "local" || user.asrMode === "groq") this.asrMode = user.asrMode;
    if (user.asrModel && ASR_MODELS.includes(user.asrModel)) this.asrModel = user.asrModel;
    if (!authEnabled || this.userId === "local") return;
    this.googleConnected = Boolean(user.googleTokenEnc);
    if (user.claudeTokenEnc) {
      const token = decryptSecret(user.claudeTokenEnc);
      if (token) this.claudeToken = token;
      else console.error(`[hub:${this.userId}] stored Claude token undecryptable (EARSHOT_SECRET changed?)`);
    }
  }

  // Tier-1 session context: tiny and always in the distill prompt. Bigger
  // sources (Asana, notes, changelogs) belong to the retrieval tier — indexed,
  // pulled per new concept, never blanket-injected (token discipline).
  async buildSessionContext() {
    const parts = [];
    try {
      const people = await directory();
      if (people.length) {
        parts.push(
          "Known people at this company: " +
            people.map((p) => (p.name ? `${p.name} <${p.email}>` : p.email)).join("; ")
        );
      }
      if (this.userId !== "local") parts.push(`The user ("me") is ${this.userId}.`);
      if (this.googleConnected) {
        const user = await getOrCreateUser(this.userId);
        const ev = await currentCalendarEvent(user).catch((e) => {
          console.error(`[google:${this.userId}] calendar context failed: ${e.message}`);
          return null;
        });
        if (ev) {
          const who = ev.attendees.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(", ");
          parts.push(
            `This recording likely corresponds to the calendar meeting "${ev.title}"` +
              `${ev.start ? ` (${ev.start})` : ""}. Attendees: ${who || "none listed"}.` +
              (ev.description ? ` Agenda: ${ev.description}` : "")
          );
          saveSessionReport(this.sessionId, { calendarEvent: ev });
          this.log(`calendar context: "${ev.title}" (${ev.attendees.length} attendees)`);
        }
      }
    } catch (e) {
      console.error(`[hub:${this.userId}] context build failed: ${e.message}`);
    }
    this.sessionContext = parts.join("\n");
  }

  log(msg) {
    console.log(`[hub:${this.userId}] ${msg}`);
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.dashboards) if (ws.readyState === 1) ws.send(msg);
  }

  bumpAndBroadcast() {
    this.state.rev++;
    this.broadcast({ type: "state", state: this.state });
  }

  // the session the board currently shows: the one recording, or (after Stop)
  // the one whose bubbles are still up
  boardSessionId() {
    return this.sessionId || this.lastSessionId;
  }

  async resume() {
    const r = await resumeSession(this.userId);
    if (!r) return;
    // hub died mid-recording (< 30 min ago): pick up where it left off
    this.recording = true;
    this.sessionId = r.sessionId;
    this.lastSessionId = r.sessionId;
    this.sessionStartedAt = r.startedAt ? new Date(r.startedAt).getTime() : Date.now();
    this.state.bubbles = r.bubbles;
    this.state.speakers = r.speakerNames || {};
    this.state.speakerPins = r.speakerPins || [];
    this.state.notes = r.boardNotes || [];
    this.state.rev++;
  }

  // ---- one capture agent owns the stream ----
  // Several agents on one account hear the SAME microphone, so every utterance
  // arrives once per agent — verified in production 2026-08-06: four instances
  // of the app (one an old build whose single-instance guard predated the
  // feature) stored every line 4x, each with slightly different ASR wording.
  // Extra agents stay CONNECTED (caps, tasks and config all keep working);
  // only their stream events are dropped, before any Groq spend. Ownership
  // passes on close or after PRIMARY_IDLE_MS of silence, so a real handoff
  // (machine swapped, agent restarted) heals itself with no reconnect fight —
  // and a duplicate can never slip through the gap, because whichever copy of
  // an utterance lands first takes ownership and mutes the rest.
  streamOwner(ws) {
    if (!ws) return true; // hub-generated (groq re-entry), already gated on the way in
    const now = Date.now();
    if (this.primaryCapture !== ws) {
      const free =
        !this.primaryCapture ||
        this.primaryCapture.readyState !== 1 ||
        now - this.primaryLastAt > PRIMARY_IDLE_MS;
      if (!free) {
        if (!ws._muted) {
          ws._muted = true;
          this.log(
            `duplicate capture agent streaming (${this.captureSockets.size} connected) — ignoring its audio; ` +
              `quit the extra copies of the Earshot app`
          );
          this.broadcast(this.status());
        }
        return false;
      }
      this.primaryCapture = ws;
      ws._muted = false;
      if (this.captureSockets.size > 1) this.log(`capture stream owner changed (${this.captureSockets.size} agents connected)`);
      this.broadcast(this.status());
    }
    this.primaryLastAt = now;
    return true;
  }

  // ---- capture ingest ----
  handleCaptureEvent(ev, ws) {
    // capability + task events work regardless of recording: bubbles stay
    // actionable after Stop, so their agent tasks must too
    if (ev.type === "caps" && ws) {
      ws._caps = {
        claude: Boolean(ev.claude),
        connectors: Array.isArray(ev.connectors) ? ev.connectors.slice(0, 40).map(String) : [],
      };
      this.log(
        `capture caps: claude ${ws._caps.claude ? "available" : "not found"}` +
          (ws._caps.connectors.length ? ` (${ws._caps.connectors.join(", ")})` : "")
      );
      this.broadcast(this.status());
      return;
    }
    if (["task_update", "task_done", "task_stream", "task_session"].includes(ev.type))
      return this.handleTaskEvent(ev);
    if (!this.recording) return; // not recording: nothing shown, saved, or sent to Groq
    // audio/transcript/voice-profile events come from exactly one agent
    if ((ev.type === "transcript" || ev.type === "audio" || ev.type === "speakers") && !this.streamOwner(ws)) return;
    if (ev.type === "speakers" && Array.isArray(ev.speakers)) {
      this.speakerProfiles = ev.speakers;
      persistSpeakers(this.sessionId, this.speakerProfiles, [...this.activeSpeakers]);
      return;
    }
    if (ev.type === "audio") return this.handleAudioSegment(ev, ws);
    if (ev.type !== "transcript" || !ev.text) return;
    // a voice tag is a participant whichever channel carried it (the mic hears
    // speakerphone calls and the room); "me" is the owner, never a participant
    if (ev.speaker && ev.speaker !== "me") this.activeSpeakers.add(ev.speaker);
    if (ev.source === "them") {
      const now = Date.now();
      const tok = tokenize(ev.text);
      const entry = { set: new Set(tok), list: tok, at: now };
      this.recentThem = this.recentThem.filter((t) => now - t.at < ECHO_WINDOW_MS).concat(entry);
      // a mic echo can flush BEFORE its loopback twin: reclaim held "me" lines
      for (const h of [...this.heldMe]) {
        if (echoOverlap(h.tokens, entry) >= ECHO_OVERLAP) {
          clearTimeout(h.timer);
          this.heldMe.delete(h);
          this.log(`echo dropped: "${h.ev.text}"`);
        }
      }
      this.acceptLine(ev);
    } else {
      const mt = tokenize(ev.text);
      const now = Date.now();
      if (this.recentThem.some((t) => now - t.at < ECHO_WINDOW_MS && echoOverlap(mt, t) >= ECHO_OVERLAP)) {
        this.log(`echo dropped: "${ev.text}"`);
        return;
      }
      const h = { ev, tokens: mt };
      h.timer = setTimeout(() => {
        this.heldMe.delete(h);
        if (this.recording) this.acceptLine(ev);
      }, ECHO_HOLD_MS);
      this.heldMe.add(h);
    }
  }

  // thin capture mode: the agent shipped raw audio instead of text — transcribe
  // via Groq, then feed the result through the normal transcript path (layer-2
  // echo, persistence, ticker, distill all inherited). Calls are serialized per
  // tenant so lines land in speaking order; failures drop the segment, never
  // the hub. Transcripts are also echoed down the originating socket so the
  // agent's echo gate can gather its text evidence (it has no local ASR).
  handleAudioSegment(ev, ws) {
    if (this.asrMode !== "groq" || !groqConfigured) return; // stale/old agent: ignore
    if (ev.format !== "wav" || typeof ev.data !== "string" || ev.data.length > 2_000_000) return;
    const { source, ts, speaker } = ev;
    if (source !== "me" && source !== "them") return;
    this.groqChain = this.groqChain
      .then(async () => {
        if (!this.recording) return; // recording stopped while queued
        const wav = Buffer.from(ev.data, "base64");
        let text;
        try {
          text = await transcribeSegment(wav);
        } catch (e) {
          if (e.status && e.status < 500) throw e; // 4xx: retrying won't help
          text = await transcribeSegment(wav); // one retry on 5xx/network
        }
        if (!text) return;
        const tev = { type: "transcript", source, text, ts, ...(speaker ? { speaker } : {}) };
        if (ws && ws.readyState === 1) ws.send(JSON.stringify(tev)); // pre-filter, on purpose
        this.handleCaptureEvent(tev);
      })
      .catch((e) => this.log(`groq asr failed, segment dropped: ${e.message}`));
  }

  acceptLine(ev) {
    this.transcript.push(ev);
    this.pending.push(ev);
    persistTranscript(this.userId, this.sessionId, ev);
    this.broadcast(ev); // live ticker, before any distill
  }

  // ---- distill ----
  distillDue() {
    return (
      this.recording &&
      (this.pending.length >= DISTILL_EAGER_LINES ||
        (this.pending.length >= DISTILL_MIN_LINES && Date.now() - this.lastDistill >= DISTILL_EVERY_MS))
    );
  }

  async runDistill() {
    if (this.distilling || this.pending.length === 0) return;
    const lines = this.pending;
    this.pending = [];
    this.distilling = true;
    const startedAt = Date.now();
    this.broadcast({ type: "distilling", value: true });
    try {
      const note = [this.distillNote, this.notesForPrompt()].filter(Boolean).join("\n\n");
      const raw = await distill(this.state, lines, note, this.claudeEnv, this.sessionContext + this.connectorContext());
      // a user edit that landed WHILE this pass was thinking wins: the model was
      // reasoning about a bubble the user has since corrected by hand
      const ops = raw.filter((op) => {
        const id = op.op === "update" || op.op === "remove" ? op.id : null;
        if (id && (this.userEdits.get(id) || 0) > startedAt) {
          this.log(`distill ${op.op} on "${id}" dropped — the user edited it mid-pass`);
          return false;
        }
        return true;
      });
      this.log(`distill: ${lines.length} lines -> ${ops.length} ops`);
      let changed = applyOps(this.state, ops);
      if (changed) {
        persistOps(this.userId, this.sessionId, ops);
        for (const b of this.state.bubbles) persistBubble(this.userId, this.sessionId, b);
        for (const op of ops) if (op.op === "remove" && op.id) persistRemoval(this.sessionId, op.id, "distill");
      }
      if (ops.some((o) => o.op === "speakers")) persistSpeakerNames(this.sessionId, this.state.speakers, this.state.speakerPins);
      // restored bubbles must earn their place: an update clears the flag (in
      // applyOps); whatever is still flagged after a few distills gets dropped
      if (this.restoreState) {
        this.restoreState.distills++;
        const unconfirmed = this.state.bubbles.filter((b) => b.restored);
        if (!unconfirmed.length) {
          this.restoreState = null;
          this.distillNote = "";
        } else if (this.restoreState.distills >= RESTORE_MAX_DISTILLS) {
          this.state.bubbles = this.state.bubbles.filter((b) => !b.restored);
          for (const b of unconfirmed) persistRemoval(this.sessionId, b.id, "stale-restore");
          this.log(`archived ${unconfirmed.length} unconfirmed restored bubble(s)`);
          this.restoreState = null;
          this.distillNote = "";
          changed = true;
        }
      }
      if (changed) this.bumpAndBroadcast();
    } catch (e) {
      console.error(`[distill:${this.userId}] error:`, e.message);
      this.pending = lines.concat(this.pending); // retry these lines next round
    } finally {
      this.lastDistill = Date.now();
      this.distilling = false;
      this.broadcast({ type: "distilling", value: false });
    }
  }

  // ---- record lifecycle ----
  async recordStart() {
    if (this.recording) return;
    this.state.bubbles = [];
    this.state.speakers = {}; // voice tags persist per capture process, but names re-earn their place
    this.state.speakerPins = [];
    this.state.notes = [];
    this.userEdits.clear();
    this.transcript.length = 0;
    this.pending = [];
    this.activeSpeakers = new Set();
    this.sessionStartedAt = Date.now();
    this.distillNote = "";
    this.restoreState = null;
    this.recentThem = [];
    for (const h of [...this.heldMe]) clearTimeout(h.timer);
    this.heldMe.clear();
    this.sessionId = await startSession(this.userId);
    this.lastSessionId = this.sessionId;
    await this.buildSessionContext();
    // provisional restore: recording again shortly after a stop is often the
    // same conversation resuming — bring the board back and let the distiller
    // keep or drop the bubbles once it sees what's actually being said
    const prev = await getPreviousSession(this.userId).catch(() => null);
    const gapMs = prev?.session.endedAt ? Date.now() - new Date(prev.session.endedAt).getTime() : Infinity;
    if (gapMs < RESTORE_WINDOW_MS && prev.bubbles.length) {
      const agoMin = Math.max(1, Math.round(gapMs / 60000));
      this.state.bubbles = prev.bubbles;
      for (const b of this.state.bubbles) {
        b.restored = true; // cleared the moment a distill updates the bubble
        persistBubble(this.userId, this.sessionId, b);
      }
      // the user's own corrections come back with the board they belong to —
      // if this is the same conversation resuming, so is what they fixed about it
      this.state.notes = prev.session.boardNotes || [];
      for (const tag of prev.session.speakerPins || []) {
        if (prev.session.speakerNames?.[tag]) {
          this.state.speakers[tag] = prev.session.speakerNames[tag];
          this.state.speakerPins.push(tag);
        }
      }
      if (this.state.speakerPins.length) persistSpeakerNames(this.sessionId, this.state.speakers, this.state.speakerPins);
      if (this.state.notes.length) saveSessionReport(this.sessionId, { boardNotes: this.state.notes });
      this.restoreState = { distills: 0 };
      this.distillNote =
        `NOTE: bubbles marked "restored": true were provisionally carried over from the previous ` +
        `session ("${prev.session.report?.title || "untitled"}", ended ${agoMin} min ago) in case ` +
        `this is the same conversation resuming after a recording pause. If the new lines continue ` +
        `that conversation, UPDATE those bubbles (even a small update confirms them). If this is a ` +
        `different conversation, REMOVE the ones that don't apply — do not leave stale bubbles. ` +
        `Restored bubbles you never touch will be auto-archived shortly.`;
      this.log(`provisionally restored ${this.state.bubbles.length} bubbles (previous session ended ${agoMin} min ago)`);
    }
    this.recording = true;
    this.broadcast({ type: "recording", value: true });
    this.bumpAndBroadcast();
    this.log("recording started");
  }

  async recordStop() {
    if (!this.recording) return;
    this.recording = false;
    this.broadcast({ type: "recording", value: false });
    // release "me" lines still waiting out the echo hold — they're real speech
    for (const h of [...this.heldMe]) {
      clearTimeout(h.timer);
      this.heldMe.delete(h);
      this.acceptLine(h.ev);
    }
    // flush: distill whatever arrived since the last pass so the session's
    // final lines still land on the board and in Mongo before it closes
    while (this.distilling) await new Promise((r) => setTimeout(r, 200));
    if (this.pending.length) await this.runDistill();
    this.pending = []; // lines are persisted verbatim regardless; don't leak into the next session
    if (this.speakerProfiles.length) persistSpeakers(this.sessionId, this.speakerProfiles, [...this.activeSpeakers]);
    const endedId = await endSession(this.sessionId);
    this.sessionId = null;
    this.log("recording stopped");
    if (endedId && (this.transcript.length || this.state.bubbles.length)) {
      this.runCloseout(endedId); // after the response; don't hold up the Stop button
    }
  }

  async runCloseout(endedSessionId) {
    this.broadcast({ type: "closeout", value: true });
    try {
      const { report } = await closeoutSession(endedSessionId, {
        userId: this.userId,
        outDir: this.outDir,
        env: this.claudeEnv,
        // the user's own corrections outrank the transcript in the report too
        context: [this.sessionContext, this.notesForPrompt()].filter(Boolean).join("\n"),
        bubbles: this.state.bubbles,
        speakerNames: this.state.speakers,
        tailLines: this.transcript.slice(-60),
        startedAt: this.sessionStartedAt || Date.now(),
        lineCount: this.transcript.length,
        speakers: this.speakerProfiles,
        activeSpeakers: [...this.activeSpeakers],
      });
      this.broadcast({ type: "report", report });
    } catch (e) {
      console.error(`[closeout:${this.userId}] error:`, e.message);
    } finally {
      this.broadcast({ type: "closeout", value: false });
    }
  }
}

const pairings = new Map(); // code -> { host, userId (null until approved), expiresAt }

const tenants = new Map();
function tenantFor(userId) {
  if (!tenants.has(userId)) {
    const t = new Tenant(userId);
    tenants.set(userId, t);
    // async; lands well before the first distill. /ingest awaits it so the
    // config downlink carries the user's stored ASR mode, not the default.
    t.ready = t.loadStoredToken().catch((e) => console.error(`[hub:${userId}] hydration failed: ${e.message}`));
  }
  return tenants.get(userId);
}

// ---------- shared helpers ----------
function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
}

// fraction of meTokens found in one "them" line; short lines can't be judged.
// Fuzzy: exact hit, or shared 4-char prefix — the mic path garbles word tails
function echoOverlap(meTokens, them) {
  if (meTokens.length < 2) return 0;
  let hit = 0;
  for (const w of meTokens) {
    if (them.set.has(w)) hit++;
    else if (w.length >= 4) {
      const p = w.slice(0, 4);
      if (them.list.some((v) => v.length >= 4 && (v.startsWith(p) || w.startsWith(v.slice(0, 4))))) hit++;
    }
  }
  return hit / meTokens.length;
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
  ".map": "application/json", ".md": "text/markdown", ".ics": "text/calendar",
  ".eml": "message/rfc822", ".csv": "text/csv",
};

function serveFile(res, file, download) {
  res.setHeader("content-type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
  if (download) res.setHeader("content-disposition", `attachment; filename="${path.basename(file)}"`);
  res.end(fs.readFileSync(file));
}

// ---------- personalized installers ----------
// The hub knows each user's server address and capture key, so the installer
// it serves needs zero questions: download, double-click, done.
const CAPTURE_FILES = [
  "main.py", "speakers.py", "echo_gate.py", "cuda_paths.py", "mac_audio.py",
  "mac_blackhole.py", "list_devices.py",
  "requirements-mac.txt", "requirements-win-cpu.txt",
];
let captureBundle = null;
function getCaptureBundle() {
  if (!captureBundle) {
    // minimal ustar writer (avoids platform tar quirks; extracts with any tar)
    const blocks = [];
    for (const name of CAPTURE_FILES) {
      const data = fs.readFileSync(path.join(ROOT, "..", "capture", name));
      const header = Buffer.alloc(512);
      header.write(name, 0, 100);
      header.write("0000644\0", 100); // mode
      header.write("0000000\0", 108); // uid
      header.write("0000000\0", 116); // gid
      header.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
      header.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136);
      header.write("        ", 148); // checksum placeholder = spaces
      header.write("0", 156); // regular file
      header.write("ustar\0", 257);
      header.write("00", 263);
      let sum = 0;
      for (const b of header) sum += b;
      header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
      blocks.push(header, data, Buffer.alloc(512 - (data.length % 512 || 512)));
    }
    blocks.push(Buffer.alloc(1024)); // end-of-archive
    captureBundle = zlib.gzipSync(Buffer.concat(blocks));
  }
  return captureBundle;
}

function personalizedInstaller(osName, req, captureKey) {
  const template = fs.readFileSync(
    osName === "windows"
      ? path.join(ROOT, "..", "windows", "installer-template.bat")
      : path.join(ROOT, "..", "mac", "installer-template.command"),
    "utf8"
  );
  const https = (req.headers["x-forwarded-proto"] || "") === "https";
  const host = req.headers.host;
  return template
    .replaceAll("{{HTTP_URL}}", `${https ? "https" : "http"}://${host}`)
    .replaceAll("{{WS_URL}}", `${https ? "wss" : "ws"}://${host}/ingest`)
    .replaceAll("{{CAPTURE_KEY}}", captureKey);
}

// Where an action click lands: a bubble on the live board, or one read back
// out of the archive (which brings its OWN session as context). Shared by
// /action and /action/preview so the previewed prompt is the sent prompt.
async function resolveActionTarget(t, userId, { bubbleId, actionId, sessionId }) {
  const board = t.boardSessionId() ? String(t.boardSessionId()) : null;
  const archivedId = sessionId && sessionId !== "live" && sessionId !== board ? String(sessionId) : null;
  let bubble, ctx = null;
  if (archivedId) {
    bubble = await getSessionBubble(userId, archivedId, bubbleId).catch(() => null);
    const tail = bubble ? await getSessionTail(userId, archivedId).catch(() => null) : null;
    if (tail) {
      ctx = {
        lines: tail.lines,
        speakerNames: tail.session.speakerNames || {},
        startedAt: tail.session.startedAt,
        title: tail.session.report?.title || tail.session.calendarEvent?.title || "",
        report: tail.session.report || null,
      };
    }
  } else {
    bubble = t.state.bubbles.find((b) => b.id === bubbleId);
  }
  const action = bubble?.actions?.find((a) => a.id === actionId);
  // calendar without a start time skips the agent so executeAction can return
  // its "edit the bubble first" message
  const agentRoutable = action ? action.type !== "calendar" || Boolean((action.payload || {}).start) : false;
  return { bubble, action, ctx, archivedId, agentRoutable };
}

// Everything an "✦ Ask Claude" agent needs about a session read back out of the
// archive: its OWN board, names, notes and transcript tail — never the live
// conversation, which is a different day.
async function askContext(userId, sessionId) {
  const data = await getSession(userId, sessionId).catch(() => null);
  if (!data) return null;
  return {
    lines: data.transcript.slice(-150),
    bubbles: data.bubbles.filter((b) => !b.removed),
    speakerNames: data.session.speakerNames || {},
    notes: data.session.boardNotes || [],
    startedAt: data.session.startedAt,
    title: data.session.report?.title || data.session.calendarEvent?.title || "",
  };
}

// user-typed instructions are free text from the browser: trim + cap so a
// paste can't balloon the prompt sent to the device agent
function cleanNotes(raw) {
  return String(raw || "").trim().slice(0, 4000);
}

// Which conversation a thread belongs to, as a plain string. "live" is a real
// key, not a placeholder: a bubble clicked while nothing is recording still
// owns its thread, and the same bubble reopened from the archive resolves to
// the session's id either way.
function threadSessionKey(t, sessionId) {
  const board = t.boardSessionId() ? String(t.boardSessionId()) : null;
  if (!sessionId || sessionId === "live") return board || "live";
  return String(sessionId);
}

// ---------- http api ----------
const server = http.createServer(async (req, res) => {
  if (!authEnabled) {
    // local mode: vite dev server (5173) talks to us cross-origin
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, mcp-protocol-version, x-earshot-thread");
  }
  if (req.method === "OPTIONS") return res.end();
  const urlPath = req.url?.split("?")[0] || "/";

  // public: the dashboard app shell + auth endpoints (state stays gated)
  if (req.method === "GET" && req.url === "/auth/config") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(publicConfig()));
  }
  if (req.method === "POST" && req.url === "/auth/google") {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    try {
      const who = await verifyGoogleCredential(JSON.parse(body || "{}").credential);
      if (!who) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ ok: false, message: "This Google account isn't on the allowlist." }));
      }
      const secure = (req.headers["x-forwarded-proto"] || "") === "https";
      res.setHeader("set-cookie", sessionCookie(who.email, secure));
      await getOrCreateUser(who.email); // provision tenant resources on first sign-in
      if (who.name) await setUserField(who.email, { name: who.name }); // feeds the people directory
      console.log(`[auth] ${who.email} signed in`);
      return res.end(JSON.stringify({ ok: true, email: who.email }));
    } catch {
      res.statusCode = 401;
      return res.end(JSON.stringify({ ok: false, message: "Sign-in could not be verified." }));
    }
  }
  // ---- device pairing (packaged app first run; no keys typed anywhere) ----
  // app: POST /pair/start {code, host} -> opens browser to /?pair=CODE ->
  // signed-in user approves (POST /pair/approve) -> app claims the key once
  // (GET /pair/claim?code=). Codes are single-use and expire in 10 minutes.
  if (req.method === "POST" && urlPath === "/pair/start") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { code, host } = JSON.parse(body || "{}");
    res.setHeader("content-type", "application/json");
    if (!/^[A-Z0-9]{6,12}$/.test(code || "")) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, message: "bad code" }));
    }
    for (const [c, p] of pairings) if (Date.now() > p.expiresAt) pairings.delete(c);
    if (pairings.size >= 50) {
      res.statusCode = 429;
      return res.end(JSON.stringify({ ok: false, message: "too many pending pairings" }));
    }
    pairings.set(code, { host: String(host || "computer").slice(0, 60), userId: null, expiresAt: Date.now() + 10 * 60_000 });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (req.method === "GET" && urlPath === "/pair/claim") {
    const code = new URL(req.url, "http://x").searchParams.get("code") || "";
    const p = pairings.get(code);
    res.setHeader("content-type", "application/json");
    if (!p || Date.now() > p.expiresAt) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ ok: false, status: "unknown" }));
    }
    if (!p.userId) return res.end(JSON.stringify({ ok: true, status: "pending" }));
    pairings.delete(code); // single-use handoff
    const user = await getOrCreateUser(p.userId);
    const https = (req.headers["x-forwarded-proto"] || "") === "https";
    console.log(`[pair] "${p.host}" claimed key for ${p.userId}`);
    return res.end(
      JSON.stringify({
        ok: true,
        status: "approved",
        captureKey: user.captureKey,
        wsUrl: `${https ? "wss" : "ws"}://${req.headers.host}/ingest`,
      })
    );
  }

  // Google OAuth callback (public; the signed+expiring state carries the user)
  if (req.method === "GET" && urlPath === "/google/callback") {
    const q = new URL(req.url, "http://x").searchParams;
    try {
      const https = (req.headers["x-forwarded-proto"] || "") === "https";
      const email = await handleCallback(q.get("code"), q.get("state"), `${https ? "https" : "http"}://${req.headers.host}/google/callback`);
      const t = tenants.get(email);
      if (t) {
        t.googleConnected = true;
        t.broadcast(t.status());
      }
      res.writeHead(302, { location: "/?google=connected" });
      return res.end();
    } catch (e) {
      console.error("[google] callback failed:", e.message);
      res.statusCode = 400;
      return res.end("Google connection failed — close this tab and try again from Settings.");
    }
  }

  if (req.method === "GET" && urlPath === "/installer/capture.tgz") {
    // public: just the open-source capture code, no secrets — the installer
    // scripts fetch it outside any browser session
    res.setHeader("content-type", "application/gzip");
    res.setHeader("content-disposition", 'attachment; filename="capture.tgz"');
    return res.end(getCaptureBundle());
  }
  if (req.method === "GET" && /^\/(assets\/[\w.-]+|[\w.-]*)$/.test(urlPath)) {
    const file = path.join(DIST_DIR, urlPath === "/" ? "index.html" : urlPath);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file, false);
    if (urlPath === "/") {
      res.statusCode = 404;
      return res.end("dashboard not built — run: cd dashboard && npx vite build");
    }
  }

  // MCP endpoint for the user's own Claude (Claude Code, Desktop, or the
  // device task agent). Not cookie-gated like the rest: headless clients
  // authenticate with their capture key as a bearer token instead.
  if (urlPath === "/mcp") {
    const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const mcpUser = !authEnabled ? "local" : (bearer && userByCaptureKey(bearer)) || browserUser(req);
    if (!mcpUser) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Authorization: Bearer <capture key> required." }, id: null }));
    }
    return handleMcp(req, res, tenantFor(mcpUser)).catch((e) => {
      console.error("[mcp] request failed:", e.message);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  }

  // everything below belongs to exactly one signed-in tenant
  const userId = browserUser(req);
  if (!userId) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: false, message: "sign in required" }));
  }
  const t = tenantFor(userId);

  // approve a device pairing (browser side; requires signed-in user)
  if (req.method === "POST" && urlPath === "/pair/approve") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { code } = JSON.parse(body || "{}");
    const p = pairings.get(code || "");
    res.setHeader("content-type", "application/json");
    if (!p || Date.now() > p.expiresAt) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ ok: false, message: "Pairing code expired or unknown — restart the app and try again." }));
    }
    p.userId = userId;
    console.log(`[pair] ${userId} approved "${p.host}"`);
    return res.end(JSON.stringify({ ok: true, host: p.host }));
  }
  if (req.method === "GET" && urlPath === "/pair/info") {
    const code = new URL(req.url, "http://x").searchParams.get("code") || "";
    const p = pairings.get(code);
    res.setHeader("content-type", "application/json");
    if (!p || Date.now() > p.expiresAt) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ ok: false }));
    }
    return res.end(JSON.stringify({ ok: true, host: p.host, approved: Boolean(p.userId) }));
  }

  // packaged desktop apps (CI-built binaries synced into downloads/ on the
  // server; they pair on first run, so one generic binary serves everyone)
  if (req.method === "GET" && (urlPath === "/installer/app/windows" || urlPath === "/installer/app/mac")) {
    const file = path.join(
      ROOT, "..", "downloads",
      urlPath.endsWith("windows") ? "EarshotCapture.exe" : "EarshotCapture-mac.zip"
    );
    if (!fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end("app build not synced yet — ask Connor");
    }
    return serveFile(res, file, true);
  }

  // personalized installers (this user's server + capture key baked in)
  if (req.method === "GET" && (urlPath === "/installer/windows" || urlPath === "/installer/mac")) {
    const osName = urlPath.split("/")[2];
    const user = await getOrCreateUser(userId);
    const body = personalizedInstaller(osName, req, user.captureKey || "");
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader(
      "content-disposition",
      `attachment; filename="${osName === "windows" ? "Install Earshot.bat" : "Install Earshot.command"}"`
    );
    return res.end(body);
  }

  // ---- self-serve settings ----
  if (req.method === "GET" && req.url === "/me") {
    const user = await getOrCreateUser(userId);
    const https = (req.headers["x-forwarded-proto"] || "") === "https";
    const proto = https ? "wss" : "ws";
    res.setHeader("content-type", "application/json");
    return res.end(
      JSON.stringify({
        email: userId,
        captureKey: user.captureKey || null,
        wsUrl: `${proto}://${req.headers.host}/ingest`,
        mcpUrl: `${https ? "https" : "http"}://${req.headers.host}/mcp`,
        agentAvailable: Boolean(t.agentSocket()),
        agentConnectors: t.agentConnectors(),
        captureConnected: t.captureSockets.size > 0,
        captureAgents: t.captureSockets.size,
        claudeConnected: t.claudeConnected,
        googleConfigured,
        googleConnected: Boolean(user.googleTokenEnc),
        asrMode: t.asrMode,
        asrModel: t.asrModel,
        asrModels: ASR_MODELS,
        groqConfigured,
      })
    );
  }
  if (req.method === "GET" && req.url === "/google/connect") {
    if (!googleConfigured) {
      res.statusCode = 503;
      return res.end("Google integration not configured on this server (GOOGLE_CLIENT_SECRET missing).");
    }
    const https = (req.headers["x-forwarded-proto"] || "") === "https";
    res.writeHead(302, { location: buildAuthUrl(userId, `${https ? "https" : "http"}://${req.headers.host}/google/callback`) });
    return res.end();
  }
  if (req.method === "POST" && req.url === "/me/claude-token") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const token = (JSON.parse(body || "{}").token || "").trim();
    res.setHeader("content-type", "application/json");
    if (token && !token.startsWith("sk-ant-")) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, message: "That doesn't look like a Claude token (expected sk-ant-…)." }));
    }
    t.claudeToken = token || null;
    await setClaudeToken(userId, token ? encryptSecret(token) : null);
    t.broadcast(t.status());
    return res.end(JSON.stringify({ ok: true, claudeConnected: t.claudeConnected }));
  }
  if (req.method === "POST" && req.url === "/me/asr") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { asrMode, asrModel } = JSON.parse(body || "{}");
    res.setHeader("content-type", "application/json");
    const fail = (message) => {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, message }));
    };
    if (asrMode !== "local" && asrMode !== "groq") return fail("asrMode must be 'local' or 'groq'.");
    if (asrMode === "groq" && !groqConfigured) return fail("Cloud transcription isn't configured on this server (GROQ_API_KEY missing).");
    if (asrModel != null && !ASR_MODELS.includes(asrModel)) return fail("Unknown whisper model.");
    t.asrMode = asrMode;
    t.asrModel = asrModel || null;
    await setUserField(userId, { asrMode: t.asrMode, asrModel: t.asrModel });
    t.broadcast(t.status());
    t.pushConfig(); // connected capture agents switch live
    return res.end(JSON.stringify({ ok: true, asrMode: t.asrMode, asrModel: t.asrModel }));
  }
  if (req.method === "POST" && req.url === "/me/capture-key/rotate") {
    const captureKey = await rotateCaptureKey(userId);
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: true, captureKey }));
  }

  if (req.method === "GET" && urlPath.startsWith("/files/")) {
    const name = path.basename(decodeURIComponent(urlPath.slice("/files/".length)));
    const file = path.join(t.outDir, name);
    if (!name || !fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end("not found");
    }
    return serveFile(res, file, true);
  }

  if (req.method === "GET" && req.url === "/state") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ...t.state, recording: t.recording }));
  }

  if (req.method === "POST" && req.url === "/record/start") {
    res.setHeader("content-type", "application/json");
    await t.recordStart();
    return res.end(JSON.stringify({ ok: true, recording: true }));
  }

  if (req.method === "POST" && req.url === "/record/stop") {
    res.setHeader("content-type", "application/json");
    await t.recordStop();
    return res.end(JSON.stringify({ ok: true, recording: false }));
  }

  // ---- session archive (sidebar nav + export) ----
  // The list is searchable: q matches closeout reports AND transcript text
  // (db.listSessions), so "what did we say about pricing" finds the session.
  if (req.method === "GET" && urlPath === "/sessions") {
    const q = new URL(req.url, "http://x").searchParams;
    const sessions = await listSessions(userId, {
      q: q.get("q") || "",
      limit: Number(q.get("limit")) || 40,
    });
    res.setHeader("content-type", "application/json");
    return res.end(
      JSON.stringify({
        sessions: sessions.map((s) => ({ ...s, id: String(s._id), _id: undefined })),
        boardSessionId: t.boardSessionId() ? String(t.boardSessionId()) : null,
        recording: t.recording,
      })
    );
  }

  // id "live" = the session on the board right now. Mongo mirrors the board
  // line-by-line, so the stored copy is preferred (it also carries the report);
  // memory is the fallback that keeps export working with Mongo down.
  if (req.method === "GET" && urlPath.startsWith("/sessions/")) {
    const [, , id, sub] = urlPath.split("/");
    const board = t.boardSessionId() ? String(t.boardSessionId()) : null;
    const isLive = id === "live" || (board && id === board);
    const lookupId = id === "live" ? board : id;
    let data = lookupId ? await getSession(userId, lookupId).catch(() => null) : null;
    if (!data && isLive) {
      data = {
        session: {
          _id: board,
          startedAt: t.sessionStartedAt ? new Date(t.sessionStartedAt) : null,
          endedAt: null,
          speakerNames: t.state.speakers || {},
          speakerPins: t.state.speakerPins || [],
          boardNotes: t.state.notes || [],
          live: true,
        },
        transcript: t.transcript,
        bubbles: t.state.bubbles,
      };
    }
    if (!data) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, message: "not found" }));
    }
    if (sub === "export") {
      const format = new URL(req.url, "http://x").searchParams.get("format") || "md";
      const { body, contentType, filename } = renderExport(data, format);
      res.setHeader("content-type", contentType);
      res.setHeader("content-disposition", `attachment; filename="${filename}"`);
      return res.end(body);
    }
    if (sub) {
      res.statusCode = 404;
      return res.end("not found");
    }
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(data));
  }

  // CI-only: seed a bubble without a distill so the action/task path is
  // testable end-to-end (bubbles otherwise only exist via the LLM)
  if (process.env.EARSHOT_TEST_SEED === "1" && req.method === "POST" && urlPath === "/test/seed-bubble") {
    let body = "";
    for await (const chunk of req) body += chunk;
    t.state.bubbles.push(JSON.parse(body));
    t.bumpAndBroadcast();
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: true }));
  }

  // ---- agent threads: the Claude session that a concept's button opened ----
  // the sheet asks for the thread behind (bubble, action) when it opens
  if (req.method === "GET" && urlPath === "/thread") {
    const q = new URL(req.url, "http://x").searchParams;
    res.setHeader("content-type", "application/json");
    const thread = await t.lookupThread(
      threadSessionKey(t, q.get("sessionId")),
      q.get("bubbleId") || "",
      q.get("actionId") || ""
    );
    return res.end(
      JSON.stringify({
        ok: true,
        thread: thread ? t.threadView(thread) : null,
        running: thread ? Boolean(t.runningTaskForThread(thread.id)) : false,
      })
    );
  }

  // ---- "✦ Ask Claude": free-form direction, per concept or board-wide ----
  // The first turn of a conversation. It is deliberately NOT one of the model's
  // hedged buttons: the user types anything ("them-2 is Dave", "split this card",
  // "find me three vendors"), and the agent can both answer and rewrite the
  // notes. Follow-ups go through /thread/reply like any other thread.
  if (req.method === "POST" && urlPath === "/ask") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { text, bubbleId, sessionId } = JSON.parse(body || "{}");
    res.setHeader("content-type", "application/json");
    const message = cleanNotes(text);
    if (!message) return res.end(JSON.stringify({ ok: false, message: "Type something first." }));
    if (!t.agentSocket())
      return res.end(
        JSON.stringify({
          ok: false,
          message: "Your Claude agent isn't connected on this computer — open the Earshot app and sign in to Claude Code.",
        })
      );
    const board = t.boardSessionId() ? String(t.boardSessionId()) : null;
    const archivedId = sessionId && sessionId !== "live" && sessionId !== board ? String(sessionId) : null;
    const ctx = archivedId ? await askContext(userId, archivedId) : null;
    if (archivedId && !ctx) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ ok: false, message: "That session isn't in the archive." }));
    }
    const bubble = bubbleId
      ? (ctx ? (ctx.bubbles || []).find((b) => b.id === bubbleId) : t.state.bubbles.find((b) => b.id === bubbleId))
      : null;
    if (bubbleId && !bubble) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ ok: false, message: "That concept is no longer on the board." }));
    }
    const thread = t.newAskThread(threadSessionKey(t, archivedId), bubble, message);
    const task = t.dispatchTask(
      bubble || { id: BOARD_BUBBLE, title: "the whole board" },
      { id: ASK_ACTION, label: "Ask Claude", type: "ask", payload: { title: thread.title } },
      { thread, prompt: t.buildAskPrompt(message, { bubble, ctx }), ...(archivedId ? { sessionId: archivedId } : {}) }
    );
    if (!task) return res.end(JSON.stringify({ ok: false, message: "Your Claude agent isn't connected on this computer." }));
    t.appendThread(thread, [{ role: "user", text: message }], { status: "running", lastTaskId: task.id });
    // the concept remembers its chat, so the ✦ button reopens it (and shows 💬).
    // Archived bubbles skip the marker — the sheet still finds the thread by
    // (session, bubble, __ask); only the 💬 dot is missing there.
    if (bubble && !archivedId) {
      bubble.askThreadId = thread.id;
      persistBubble(userId, t.boardSessionId(), bubble);
      t.bumpAndBroadcast();
    }
    return res.end(JSON.stringify({ ok: true, status: "running", threadId: thread.id }));
  }

  // Standing notes, by hand: the same list the agent writes with add_note, so a
  // correction can be pinned (or dropped) without asking anyone.
  if (req.method === "POST" && urlPath === "/board/note") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { text, index, sessionId } = JSON.parse(body || "{}");
    res.setHeader("content-type", "application/json");
    const ops = [
      index === undefined || index === null
        ? { op: "note", text: cleanNotes(text) }
        : { op: "unnote", index: Number(index) },
    ];
    const board = t.boardSessionId() ? String(t.boardSessionId()) : null;
    const archivedId = sessionId && sessionId !== "live" && sessionId !== board ? String(sessionId) : null;
    const result = archivedId ? await applyArchivedEdit(userId, archivedId, ops) : t.applyLiveEdit(ops);
    if (archivedId && result.changed) t.broadcast({ type: "session_patch", sessionId: archivedId });
    return res.end(
      JSON.stringify({
        ok: result.changed,
        notes: archivedId ? undefined : t.state.notes,
        message: result.changed ? "" : result.errors[0] || "Nothing changed.",
      })
    );
  }

  // keep talking to the same Claude session (it resumes on the user's machine)
  if (req.method === "POST" && urlPath === "/thread/reply") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { threadId, text } = JSON.parse(body || "{}");
    res.setHeader("content-type", "application/json");
    const thread = await t.threadById(String(threadId || ""));
    const message = cleanNotes(text);
    if (!thread) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ ok: false, message: "not found" }));
    }
    if (!message) return res.end(JSON.stringify({ ok: false, message: "Type something first." }));
    if (t.runningTaskForThread(thread.id))
      return res.end(JSON.stringify({ ok: false, message: "Your Claude is still working — stop it first." }));
    if (!thread.claudeSessionId)
      return res.end(
        JSON.stringify({ ok: false, message: "That session can't be resumed — run the action again to start a new one." })
      );
    // a follow-up carries no mission or transcript: the resumed session on the
    // user's machine still holds all of it
    const task = t.dispatchTask(
      { id: thread.bubbleId, title: thread.concept || "" },
      { id: thread.actionId, label: thread.actionLabel, type: thread.actionType, payload: { title: thread.title } },
      { thread, prompt: message, resume: thread.claudeSessionId, sessionId: thread.sessionId === "live" ? null : thread.sessionId }
    );
    if (!task)
      return res.end(JSON.stringify({ ok: false, message: "Your Claude agent isn't connected on this computer." }));
    t.appendThread(thread, [{ role: "user", text: message }], { status: "running", lastTaskId: task.id });
    return res.end(JSON.stringify({ ok: true, status: "running" }));
  }

  // open a deliverable. The file is on the USER's machine (a browser can't
  // reach it, and file:// links are blocked from an https page), so the click
  // becomes a request to the device agent that holds it.
  if (req.method === "POST" && urlPath === "/thread/open") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { threadId, file } = JSON.parse(body || "{}");
    res.setHeader("content-type", "application/json");
    const thread = await t.threadById(String(threadId || ""));
    if (!thread) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ ok: false, message: "not found" }));
    }
    const ws = t.agentSocket();
    if (!ws)
      return res.end(
        JSON.stringify({ ok: false, message: "That file is on the computer that ran the task — start Earshot there to open it." })
      );
    // a name, never a path: the agent re-checks this against its task folder
    const name = String(file || "").replace(/[\\/]/g, "").slice(0, 200);
    ws.send(JSON.stringify({ type: "open", threadId: thread.id, file: name }));
    return res.end(JSON.stringify({ ok: true, message: name ? `Opening ${name} on your computer.` : "Opening the folder on your computer." }));
  }

  // stop a task mid-flight (the kill happens on the user's machine)
  if (req.method === "POST" && urlPath === "/thread/cancel") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { threadId, taskId } = JSON.parse(body || "{}");
    res.setHeader("content-type", "application/json");
    const task = taskId ? t.tasks.get(String(taskId)) : t.runningTaskForThread(String(threadId || ""));
    if (!task || !t.cancelTask(task.id))
      return res.end(JSON.stringify({ ok: false, message: "Nothing is running for that action." }));
    return res.end(JSON.stringify({ ok: true, message: "Stopped." }));
  }

  // what WOULD be sent: the exact prompt the device agent gets, so the send
  // sheet can show it (and show it changing as the user types instructions)
  if (req.method === "POST" && req.url === "/action/preview") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const req_ = JSON.parse(body || "{}");
    res.setHeader("content-type", "application/json");
    const { bubble, action, ctx, agentRoutable } = await resolveActionTarget(t, userId, req_);
    if (!bubble || !action) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ ok: false, message: "not found" }));
    }
    const p = action.payload || {};
    return res.end(
      JSON.stringify({
        ok: true,
        title: p.title || p.subject || action.label || bubble.title,
        type: action.type,
        // routing the click will actually take, so the sheet can say so
        route: agentRoutable && t.agentSocket() ? "agent" : "hub",
        prompt: agentRoutable
          ? t.buildTaskPrompt(bubble, action, ctx, cleanNotes(req_.notes))
          : "",
      })
    );
  }

  if (req.method === "POST" && (req.url === "/action" || req.url === "/dismiss")) {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { bubbleId, actionId, sessionId, notes } = JSON.parse(body || "{}");
    res.setHeader("content-type", "application/json");

    if (req.url === "/dismiss") {
      t.state.bubbles = t.state.bubbles.filter((b) => b.id !== bubbleId);
      persistRemoval(t.boardSessionId(), bubbleId, "dismissed");
      t.bumpAndBroadcast();
      return res.end(JSON.stringify({ ok: true }));
    }

    // A bubble from a PAST session is just as clickable as a live one; it only
    // changes where the bubble is read from, which conversation the agent gets
    // as context, and where the resulting status is written.
    const { bubble, action, ctx, archivedId, agentRoutable } = await resolveActionTarget(t, userId, {
      bubbleId,
      actionId,
      sessionId,
    });
    if (!bubble || !action) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ ok: false, message: "not found" }));
    }
    const userNotes = cleanNotes(notes);
    // recorded on the action itself so the board (and the archive, months
    // later) shows what was actually asked for, not just that it ran. Set even
    // when empty: a re-run with a cleared box means "no instructions this time"
    action.userNotes = userNotes;
    // EVERY action prefers the user's OWN Claude on their device (it already
    // has their Gmail/Calendar/Drive/Notion connected via claude.ai
    // connectors) → hub-side Google (if linked here) → artifact file.
    if (agentRoutable) {
      // the click opens a CONVERSATION with the user's Claude, kept under the
      // concept it came from; follow-ups (POST /thread/reply) resume it
      const thread = t.agentSocket() ? t.newThread(threadSessionKey(t, archivedId), bubble, action) : null;
      const task = t.dispatchTask(bubble, action, {
        notes: userNotes,
        thread,
        ...(archivedId ? { sessionId: archivedId, ctx } : {}),
      });
      if (task) {
        action.threadId = thread.id;
        t.appendThread(
          thread,
          [{ role: "user", text: userNotes || `▶ ${action.label || "Run this action"}` }],
          { status: "running", lastTaskId: task.id }
        );
        action.status = "running";
        if (archivedId) {
          setBubbleActionStatus(userId, archivedId, bubbleId, actionId, "running", {
            notes: userNotes,
            threadId: thread.id,
          });
        } else {
          persistBubble(userId, t.boardSessionId(), bubble);
          t.bumpAndBroadcast();
        }
        return res.end(
          JSON.stringify({ ok: true, status: "running", message: `Your Claude is on it: ${task.title}` })
        );
      }
    }
    let result;
    try {
      const user = await getOrCreateUser(userId);
      const googleUser = googleConfigured && user.googleTokenEnc ? user : null;
      // no agent to read instructions: fold them into the artifact itself so
      // what the user typed still reaches the .ics/.eml/brief they get back
      result = await executeAction(withUserNotes(action, userNotes), bubble, t.outDir, googleUser);
    } catch (e) {
      result = { ok: false, message: String(e.message || e) };
    }
    action.status = result.ok ? "done" : "error";
    if (archivedId) {
      setBubbleActionStatus(userId, archivedId, bubbleId, actionId, action.status, { notes: userNotes });
    } else {
      persistBubble(userId, t.boardSessionId(), bubble);
      t.bumpAndBroadcast();
    }
    return res.end(JSON.stringify(result));
  }

  res.statusCode = 404;
  res.end("not found");
});

// ---------- websockets ----------
// maxPayload: audio segments top out ~700KB (15.8s base64 WAV); 8MB is
// headroom, not the default 100MiB attack surface
const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 * 1024 });

wss.on("connection", (ws, req) => {
  if (req.url?.startsWith("/ingest")) {
    const key = new URL(req.url, "http://x").searchParams.get("key") || "";
    const userId = authEnabled ? userByCaptureKey(key) : "local";
    if (!userId) {
      console.log("[hub] capture REJECTED (bad or missing key)");
      return ws.close(4401, "capture key required");
    }
    const t = tenantFor(userId);
    t.captureSockets.add(ws);
    t.log("capture connected");
    t.broadcast(t.status());
    // config downlink: wait for hydration so the stored pref (not the server
    // default) is what the agent hears first
    Promise.resolve(t.ready).then(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify(t.configMsg()));
    });
    ws.on("message", (data) => {
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        return;
      }
      t.handleCaptureEvent(ev, ws);
    });
    ws.on("close", () => {
      t.captureSockets.delete(ws);
      // the stream owner left: the next agent to send audio takes over
      if (t.primaryCapture === ws) t.primaryCapture = null;
      t.broadcast(t.status());
    });
  } else {
    const userId = browserUser(req);
    if (!userId) return ws.close(4401, "sign in required");
    const t = tenantFor(userId);
    t.log("dashboard connected");
    t.dashboards.add(ws);
    ws.send(JSON.stringify({ type: "state", state: t.state }));
    ws.send(JSON.stringify({ type: "recording", value: t.recording }));
    ws.send(JSON.stringify(t.status()));
    if (t.tasks.size) ws.send(JSON.stringify(t.tasksMsg()));
    for (const line of t.transcript.slice(-30)) ws.send(JSON.stringify(line));
    ws.on("close", () => t.dashboards.delete(ws));
  }
});

// ---------- distill scheduler ----------
setInterval(() => {
  for (const t of tenants.values()) if (t.distillDue()) t.runDistill();
}, 3_000);

// ---------- startup ----------
await initDb();
seedCaptureKeys(envCaptureKeyPairs()); // env-configured keys keep working
await loadUsers();                     // Mongo-provisioned keys into the cache
// tenants are created lazily on sign-in / capture connect; at boot we only
// need tenants whose recording was cut off mid-session
const openUsers = authEnabled ? await usersWithOpenSessions() : ["local"];
for (const userId of openUsers) {
  await tenantFor(userId).resume();
}

server.listen(PORT, () =>
  console.log(`[hub] listening on :${PORT} (${authEnabled ? "hosted, self-serve sign-in" : "local mode"})`)
);
