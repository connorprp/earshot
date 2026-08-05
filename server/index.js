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
  initDb,
  seedCaptureKeys,
  loadUsers,
  getOrCreateUser,
  rotateCaptureKey,
  setClaudeToken,
  userByCaptureKey,
  usersWithOpenSessions,
  resumeSession,
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

// per-user Claude subscription tokens: "email:sk-ant-oat...,email:..." —
// distills for that tenant bill that user; others fall back to the process env
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
    this.claudeToken = CLAUDE_TOKENS.get(userId) || null; // may be replaced from the user's stored token
    this.outDir = path.join(OUT_ROOT, userId === "local" ? "local" : userId.replace(/[^a-z0-9]+/gi, "-"));
    fs.mkdirSync(this.outDir, { recursive: true });
  }

  get claudeEnv() {
    return this.claudeToken ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: this.claudeToken } : null;
  }

  // local mode rides the machine's own Claude login; hosted needs a token
  get claudeConnected() {
    return !authEnabled || Boolean(this.claudeToken || process.env.CLAUDE_CODE_OAUTH_TOKEN);
  }

  status() {
    return {
      type: "status",
      captureConnected: this.captureSockets.size > 0,
      claudeConnected: this.claudeConnected,
    };
  }

  async loadStoredToken() {
    if (!authEnabled || this.userId === "local") return;
    const user = await getOrCreateUser(this.userId);
    if (user.claudeTokenEnc) {
      const token = decryptSecret(user.claudeTokenEnc);
      if (token) this.claudeToken = token;
      else console.error(`[hub:${this.userId}] stored Claude token undecryptable (EARSHOT_SECRET changed?)`);
    }
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
  handleCaptureEvent(ev) {
    if (!this.recording) return; // not recording: nothing is shown or saved
    if (ev.type === "speakers" && Array.isArray(ev.speakers)) {
      this.speakerProfiles = ev.speakers;
      persistSpeakers(this.sessionId, this.speakerProfiles, [...this.activeSpeakers]);
      return;
    }
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
      const ops = await distill(this.state, lines, this.distillNote, this.claudeEnv);
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

const tenants = new Map();
function tenantFor(userId) {
  if (!tenants.has(userId)) {
    const t = new Tenant(userId);
    tenants.set(userId, t);
    t.loadStoredToken(); // async; lands well before the first distill
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
    res.setHeader("Access-Control-Allow-Headers", "content-type");
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
      const email = await verifyGoogleCredential(JSON.parse(body || "{}").credential);
      if (!email) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ ok: false, message: "This Google account isn't on the allowlist." }));
      }
      const secure = (req.headers["x-forwarded-proto"] || "") === "https";
      res.setHeader("set-cookie", sessionCookie(email, secure));
      await getOrCreateUser(email); // provision tenant resources on first sign-in
      console.log(`[auth] ${email} signed in`);
      return res.end(JSON.stringify({ ok: true, email }));
    } catch {
      res.statusCode = 401;
      return res.end(JSON.stringify({ ok: false, message: "Sign-in could not be verified." }));
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

  // everything below belongs to exactly one signed-in tenant
  const userId = browserUser(req);
  if (!userId) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: false, message: "sign in required" }));
  }
  const t = tenantFor(userId);

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
    const proto = (req.headers["x-forwarded-proto"] || "") === "https" ? "wss" : "ws";
    res.setHeader("content-type", "application/json");
    return res.end(
      JSON.stringify({
        email: userId,
        captureKey: user.captureKey || null,
        wsUrl: `${proto}://${req.headers.host}/ingest`,
        captureConnected: t.captureSockets.size > 0,
        claudeConnected: t.claudeConnected,
      })
    );
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
    let result;
    try {
      result = executeAction(action, bubble, t.outDir);
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
const wss = new WebSocketServer({ server });

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
    ws.on("message", (data) => {
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        return;
      }
      t.handleCaptureEvent(ev);
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
