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
import { executeAction } from "./actions.js";
import { closeoutSession } from "./closeout.js";
import { handleMcp } from "./mcp.js";
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
  getPreviousSession,
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
const TASK_PRUNE_MS = 60_000;    // finished tasks linger this long in the dashboard task list

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
    this.state = { bubbles: [], speakers: {}, rev: 0 };
    this.transcript = [];       // full session log, in memory
    this.pending = [];          // lines not yet distilled
    this.distilling = false;
    this.lastDistill = 0;
    this.recording = false;     // capture lines are dropped unless recording
    this.speakerProfiles = []; // latest voice-cluster snapshot from capture
    this.activeSpeakers = new Set();
    this.sessionId = null;
    this.sessionStartedAt = null;
    this.distillNote = "";      // context prepended to distills while restored bubbles are unconfirmed
    this.restoreState = null;   // { distills } while provisionally-restored bubbles await confirmation
    this.recentThem = [];       // [{ set, list, at }] for echo matching
    this.heldMe = new Set();    // { ev, tokens, timer } "me" lines waiting out ECHO_HOLD_MS
    this.dashboards = new Set();
    this.captureSockets = new Set();
    this.sessionContext = ""; // Tier-1 context: directory + current calendar meeting
    this.googleConnected = false;
    this.asrMode = defaultAsrMode(); // "local" | "groq"; user pref overrides on hydration
    this.asrModel = null;            // local-mode whisper model; null = agent's platform default
    this.groqChain = Promise.resolve(); // serializes Groq calls per tenant (transcript order)
    this.tasks = new Map();      // device-agent tasks: id -> {id, bubbleId, actionId, title, status, note}
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
      claudeConnected: this.claudeConnected,
      googleConnected: this.googleConnected,
      asrMode: this.asrMode,
      asrOk: this.asrMode !== "groq" || groqConfigured,
      agentAvailable: Boolean(this.agentSocket()),
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
    return p.brief || bubble.summary || "";
  }

  buildTaskPrompt(bubble, action) {
    const p = action.payload || {};
    const names = this.state.speakers || {};
    const who = (l) => (l.source === "me" ? "Me" : names[l.speaker] || l.speaker || "Them");
    const transcript = this.transcript.slice(-150).map((l) => `[${who(l)}] ${l.text}`).join("\n");
    return [
      `You are completing a real-world task on behalf of the user ("Me"). It was identified during a live conversation captured by Earshot, an ambient meeting assistant. Work autonomously — nobody is available to answer questions.`,
      ``,
      `# Task: ${p.title || p.subject || action.label || bubble.title}`,
      ``,
      this.taskMission(bubble, action),
      ``,
      `# The conversation concept this came from`,
      JSON.stringify({ title: bubble.title, summary: bubble.summary, details: bubble.details || [] }, null, 1),
      ...(this.sessionContext ? [``, `# Context`, this.sessionContext] : []),
      ...(transcript ? [``, `# Recent conversation transcript`, transcript] : []),
      ``,
      `Current datetime: ${new Date().toString()}`,
      ``,
      `# Instructions`,
      `- The user's own connected apps may be available as mcp__claude_ai_* tools (Gmail, Google Calendar, Google Drive, Notion, ...). They are DEFERRED — run ToolSearch to load them before concluding one isn't connected. Prefer them whenever the task calls for a real-world object (an email draft, a calendar event, a shared doc). Never authenticate or connect a new service, and never SEND email — drafts only.`,
      `- Otherwise produce the deliverable as one or more files in the current working directory (markdown unless the task clearly calls for another format).`,
      `- An "earshot" MCP server is connected, holding the user's past recorded conversations (list_sessions, get_session, get_transcript, search_transcripts, get_live_board). Use it when the task needs context beyond the transcript above.`,
      `- The transcript is speech-to-text: words get garbled and tense/agency can flip. Hedge uncertain facts rather than inventing specifics.`,
      `- End with a 2-3 sentence summary of what you produced (mention where it landed: Gmail draft, calendar, or files).`,
    ].join("\n");
  }

  // returns the task if it was dispatched, null if no capable device agent
  dispatchTask(bubble, action) {
    const ws = this.agentSocket();
    if (!ws) return null;
    const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const p = action.payload || {};
    const task = {
      id,
      bubbleId: bubble.id,
      actionId: action.id,
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
    ws.send(JSON.stringify({ type: "task", id, title: task.title, prompt: this.buildTaskPrompt(bubble, action) }));
    this.log(`task ${id} -> device agent: ${task.title}`);
    this.broadcastTasks();
    return task;
  }

  handleTaskEvent(ev) {
    const task = this.tasks.get(ev.id);
    if (!task || task.status !== "running") return;
    if (ev.type === "task_update") {
      task.note = String(ev.note || "").slice(0, 200);
      return this.broadcastTasks();
    }
    // task_done
    clearTimeout(this.taskTimers.get(task.id));
    this.taskTimers.delete(task.id);
    task.status = ev.ok ? "done" : "error";
    task.note = String(ev.summary || "").slice(0, 600);
    task.files = Array.isArray(ev.files) ? ev.files.slice(0, 20).map(String) : [];
    task.endedAt = Date.now();
    const bubble = this.state.bubbles.find((b) => b.id === task.bubbleId);
    const action = bubble?.actions?.find((a) => a.id === task.actionId);
    if (action) {
      action.status = task.status;
      persistBubble(this.userId, this.sessionId, bubble);
      this.bumpAndBroadcast();
    }
    this.broadcast({ type: "task_done", ok: ev.ok === true, title: task.title, summary: task.note, files: task.files });
    this.broadcastTasks();
    this.log(`task ${task.id} ${task.status}: ${task.title}`);
    const timer = setTimeout(() => {
      this.tasks.delete(task.id);
      this.broadcastTasks();
    }, TASK_PRUNE_MS);
    timer.unref?.();
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

  async resume() {
    const r = await resumeSession(this.userId);
    if (!r) return;
    // hub died mid-recording (< 30 min ago): pick up where it left off
    this.recording = true;
    this.sessionId = r.sessionId;
    this.sessionStartedAt = r.startedAt ? new Date(r.startedAt).getTime() : Date.now();
    this.state.bubbles = r.bubbles;
    this.state.speakers = r.speakerNames || {};
    this.state.rev++;
  }

  // ---- capture ingest ----
  handleCaptureEvent(ev, ws) {
    // capability + task events work regardless of recording: bubbles stay
    // actionable after Stop, so their agent tasks must too
    if (ev.type === "caps" && ws) {
      ws._caps = { claude: Boolean(ev.claude) };
      this.log(`capture caps: claude ${ws._caps.claude ? "available" : "not found"}`);
      this.broadcast(this.status());
      return;
    }
    if (ev.type === "task_update" || ev.type === "task_done") return this.handleTaskEvent(ev);
    if (!this.recording) return; // not recording: nothing shown, saved, or sent to Groq
    if (ev.type === "speakers" && Array.isArray(ev.speakers)) {
      this.speakerProfiles = ev.speakers;
      persistSpeakers(this.sessionId, this.speakerProfiles, [...this.activeSpeakers]);
      return;
    }
    if (ev.type === "audio") return this.handleAudioSegment(ev, ws);
    if (ev.type !== "transcript" || !ev.text) return;
    if (ev.source === "them") {
      if (ev.speaker) this.activeSpeakers.add(ev.speaker);
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
    this.broadcast({ type: "distilling", value: true });
    try {
      const ops = await distill(this.state, lines, this.distillNote, this.claudeEnv, this.sessionContext);
      this.log(`distill: ${lines.length} lines -> ${ops.length} ops`);
      let changed = applyOps(this.state, ops);
      if (changed) {
        persistOps(this.userId, this.sessionId, ops);
        for (const b of this.state.bubbles) persistBubble(this.userId, this.sessionId, b);
        for (const op of ops) if (op.op === "remove" && op.id) persistRemoval(this.sessionId, op.id, "distill");
      }
      if (ops.some((o) => o.op === "speakers")) persistSpeakerNames(this.sessionId, this.state.speakers);
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
        context: this.sessionContext,
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
  "list_devices.py", "requirements-mac.txt", "requirements-win-cpu.txt",
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

// ---------- http api ----------
const server = http.createServer(async (req, res) => {
  if (!authEnabled) {
    // local mode: vite dev server (5173) talks to us cross-origin
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, mcp-protocol-version");
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
        captureConnected: t.captureSockets.size > 0,
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

  if (req.method === "GET" && req.url === "/sessions") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(await listSessions(userId)));
  }

  if (req.method === "GET" && req.url?.startsWith("/sessions/")) {
    const data = await getSession(userId, req.url.split("/")[2]).catch(() => null);
    res.setHeader("content-type", "application/json");
    if (!data) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ ok: false, message: "not found" }));
    }
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

  if (req.method === "POST" && (req.url === "/action" || req.url === "/dismiss")) {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { bubbleId, actionId } = JSON.parse(body || "{}");
    const bubble = t.state.bubbles.find((b) => b.id === bubbleId);
    res.setHeader("content-type", "application/json");

    if (req.url === "/dismiss") {
      t.state.bubbles = t.state.bubbles.filter((b) => b.id !== bubbleId);
      persistRemoval(t.sessionId, bubbleId, "dismissed");
      t.bumpAndBroadcast();
      return res.end(JSON.stringify({ ok: true }));
    }

    const action = bubble?.actions?.find((a) => a.id === actionId);
    if (!bubble || !action) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ ok: false, message: "not found" }));
    }
    // Preference order for actions with real-world side effects: the user's
    // OWN Claude on their device (it already has their Gmail/Calendar/Drive
    // connected via claude.ai connectors) → hub-side Google (if they linked
    // it here) → artifact file. Calendar without a start time skips the agent
    // so executeAction can return its "edit the bubble first" message.
    const agentRoutable =
      action.type === "agent" ||
      action.type === "email" ||
      (action.type === "calendar" && (action.payload || {}).start);
    if (agentRoutable) {
      const task = t.dispatchTask(bubble, action);
      if (task) {
        action.status = "running";
        persistBubble(userId, t.sessionId, bubble);
        t.bumpAndBroadcast();
        return res.end(
          JSON.stringify({ ok: true, status: "running", message: `Your Claude is on it: ${task.title}` })
        );
      }
    }
    let result;
    try {
      const user = await getOrCreateUser(userId);
      const googleUser = googleConfigured && user.googleTokenEnc ? user : null;
      result = await executeAction(action, bubble, t.outDir, googleUser);
    } catch (e) {
      result = { ok: false, message: String(e.message || e) };
    }
    action.status = result.ok ? "done" : "error";
    persistBubble(userId, t.sessionId, bubble);
    t.bumpAndBroadcast();
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
