// Earshot hub: websocket fan-in (capture) / fan-out (dashboards), the distill
// scheduler, the action API, and (hosted mode) the dashboard itself + auth.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
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
  browserAuthed,
  captureAuthed,
} from "./auth.js";
import {
  initDb,
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
// echo suppression backstop: on open speakers the mic re-hears loopback audio,
// producing "me" lines that are garbled fragments of "them" lines. The primary
// defense is capture's timing gate (echo_gate.py); these constants were tuned
// against a real captured echo set (2026-08-04: exact-match 0.8/8s caught 19%,
// fuzzy 0.62/15s caught 59% — mic-path ASR garbles echoes, hence fuzzy tokens)
const ECHO_WINDOW_MS = 15_000;   // a "them" line this recent can claim a "me" line as its echo
const ECHO_HOLD_MS = 6_000;      // "me" lines wait this long in case their "them" twin arrives late
const ECHO_OVERLAP = 0.62;       // fraction of "me" tokens fuzzy-found in one "them" line = echo

const state = { bubbles: [], speakers: {}, rev: 0 }; // speakers: voice tag -> inferred name
const transcript = [];      // full log (kept in memory for the PoC)
let pending = [];           // lines not yet distilled
let distilling = false;
let lastDistill = 0;
let recording = false;      // capture lines are dropped unless recording
let speakerProfiles = [];   // latest voice-cluster snapshot from capture
let activeSpeakers = new Set(); // speaker ids heard in the current session
let sessionStartedAt = null;
let distillNote = "";       // context prepended to distills while restored bubbles are unconfirmed
let restoreState = null;    // { distills } while provisionally-restored bubbles await confirmation
let recentThem = [];        // [{ tokens:Set, at }] for echo matching
const heldMe = new Set();   // { ev, tokens, timer } "me" lines waiting out ECHO_HOLD_MS

// ---------- static dashboard + artifact downloads ----------
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(ROOT, "..", "dashboard", "dist");
const OUT_DIR = path.join(ROOT, "..", "out");
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
      console.log(`[auth] ${email} signed in`);
      return res.end(JSON.stringify({ ok: true, email }));
    } catch {
      res.statusCode = 401;
      return res.end(JSON.stringify({ ok: false, message: "Sign-in could not be verified." }));
    }
  }
  if (req.method === "GET" && /^\/(assets\/[\w.-]+|[\w.-]*)$/.test(urlPath)) {
    const file = path.join(DIST_DIR, urlPath === "/" ? "index.html" : urlPath);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file, false);
    if (urlPath === "/") {
      res.statusCode = 404;
      return res.end("dashboard not built — run: cd dashboard && npx vite build");
    }
  }

  // everything below requires a signed-in browser (hosted mode)
  if (!browserAuthed(req)) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: false, message: "sign in required" }));
  }

  if (req.method === "GET" && urlPath.startsWith("/files/")) {
    const name = path.basename(decodeURIComponent(urlPath.slice("/files/".length)));
    const file = path.join(OUT_DIR, name);
    if (!name || !fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end("not found");
    }
    return serveFile(res, file, true);
  }

  if (req.method === "GET" && req.url === "/state") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ...state, recording }));
  }

  if (req.method === "POST" && req.url === "/record/start") {
    res.setHeader("content-type", "application/json");
    if (!recording) {
      state.bubbles = [];
      state.speakers = {}; // voice tags persist per capture process, but names re-earn their place
      transcript.length = 0;
      pending = [];
      activeSpeakers = new Set();
      sessionStartedAt = Date.now();
      distillNote = "";
      restoreState = null;
      recentThem = [];
      for (const h of [...heldMe]) clearTimeout(h.timer);
      heldMe.clear();
      await startSession();
      // provisional restore: recording again shortly after a stop is often the
      // same conversation resuming — bring the board back and let the distiller
      // keep or drop the bubbles once it sees what's actually being said
      const prev = await getPreviousSession().catch(() => null);
      const gapMs = prev?.session.endedAt ? Date.now() - new Date(prev.session.endedAt).getTime() : Infinity;
      if (gapMs < RESTORE_WINDOW_MS && prev.bubbles.length) {
        const agoMin = Math.max(1, Math.round(gapMs / 60000));
        state.bubbles = prev.bubbles;
        for (const b of state.bubbles) {
          b.restored = true; // cleared the moment a distill updates the bubble
          persistBubble(b);
        }
        restoreState = { distills: 0 };
        distillNote =
          `NOTE: bubbles marked "restored": true were provisionally carried over from the previous ` +
          `session ("${prev.session.report?.title || "untitled"}", ended ${agoMin} min ago) in case ` +
          `this is the same conversation resuming after a recording pause. If the new lines continue ` +
          `that conversation, UPDATE those bubbles (even a small update confirms them). If this is a ` +
          `different conversation, REMOVE the ones that don't apply — do not leave stale bubbles. ` +
          `Restored bubbles you never touch will be auto-archived shortly.`;
        console.log(`[hub] provisionally restored ${state.bubbles.length} bubbles (previous session ended ${agoMin} min ago)`);
      }
      recording = true;
      broadcast({ type: "recording", value: true });
      bumpAndBroadcast();
      console.log("[hub] recording started");
    }
    return res.end(JSON.stringify({ ok: true, recording: true }));
  }

  if (req.method === "POST" && req.url === "/record/stop") {
    res.setHeader("content-type", "application/json");
    if (recording) {
      recording = false;
      broadcast({ type: "recording", value: false });
      // release "me" lines still waiting out the echo hold — they're real speech
      for (const h of [...heldMe]) {
        clearTimeout(h.timer);
        heldMe.delete(h);
        acceptLine(h.ev);
      }
      // flush: distill whatever arrived since the last pass so the session's
      // final lines still land on the board and in Mongo before it closes
      while (distilling) await new Promise((r) => setTimeout(r, 200));
      if (pending.length) await runDistill();
      pending = []; // lines are persisted verbatim regardless; don't leak into the next session
      if (speakerProfiles.length) await persistSpeakers(speakerProfiles, [...activeSpeakers]);
      const endedId = await endSession();
      console.log("[hub] recording stopped");
      if (transcript.length || state.bubbles.length) runCloseout(endedId); // after the response; don't hold up the Stop button
    }
    return res.end(JSON.stringify({ ok: true, recording: false }));
  }

  if (req.method === "GET" && req.url === "/sessions") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(await listSessions()));
  }

  if (req.method === "GET" && req.url?.startsWith("/sessions/")) {
    const data = await getSession(req.url.split("/")[2]).catch(() => null);
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
    const bubble = state.bubbles.find((b) => b.id === bubbleId);
    res.setHeader("content-type", "application/json");

    if (req.url === "/dismiss") {
      state.bubbles = state.bubbles.filter((b) => b.id !== bubbleId);
      persistRemoval(bubbleId, "dismissed");
      bumpAndBroadcast();
      return res.end(JSON.stringify({ ok: true }));
    }

    const action = bubble?.actions?.find((a) => a.id === actionId);
    if (!bubble || !action) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ ok: false, message: "not found" }));
    }
    let result;
    try {
      result = executeAction(action, bubble);
    } catch (e) {
      result = { ok: false, message: String(e.message || e) };
    }
    action.status = result.ok ? "done" : "error";
    persistBubble(bubble);
    bumpAndBroadcast();
    return res.end(JSON.stringify(result));
  }

  res.statusCode = 404;
  res.end("not found");
});

// ---------- websockets ----------
const wss = new WebSocketServer({ server });
const dashboards = new Set();

wss.on("connection", (ws, req) => {
  if (req.url?.startsWith("/ingest")) {
    if (!captureAuthed(req.url)) {
      console.log("[hub] capture REJECTED (bad or missing key)");
      return ws.close(4401, "capture key required");
    }
    console.log("[hub] capture connected");
    ws.on("message", (data) => {
      let ev;
      try {
        ev = JSON.parse(data);
      } catch {
        return;
      }
      if (!recording) return; // not recording: nothing is shown or saved
      if (ev.type === "speakers" && Array.isArray(ev.speakers)) {
        speakerProfiles = ev.speakers;
        persistSpeakers(speakerProfiles, [...activeSpeakers]);
        return;
      }
      if (ev.type !== "transcript" || !ev.text) return;
      if (ev.source === "them") {
        if (ev.speaker) activeSpeakers.add(ev.speaker);
        const now = Date.now();
        const tok = tokenize(ev.text);
        const entry = { set: new Set(tok), list: tok, at: now };
        recentThem = recentThem.filter((t) => now - t.at < ECHO_WINDOW_MS).concat(entry);
        // a mic echo can flush BEFORE its loopback twin: reclaim held "me" lines
        for (const h of [...heldMe]) {
          if (echoOverlap(h.tokens, entry) >= ECHO_OVERLAP) {
            clearTimeout(h.timer);
            heldMe.delete(h);
            console.log(`[hub] echo dropped: "${h.ev.text}"`);
          }
        }
        acceptLine(ev);
      } else {
        const mt = tokenize(ev.text);
        const now = Date.now();
        if (recentThem.some((t) => now - t.at < ECHO_WINDOW_MS && echoOverlap(mt, t) >= ECHO_OVERLAP)) {
          console.log(`[hub] echo dropped: "${ev.text}"`);
          return;
        }
        const h = { ev, tokens: mt };
        h.timer = setTimeout(() => {
          heldMe.delete(h);
          if (recording) acceptLine(ev);
        }, ECHO_HOLD_MS);
        heldMe.add(h);
      }
    });
  } else {
    if (!browserAuthed(req)) return ws.close(4401, "sign in required");
    console.log("[hub] dashboard connected");
    dashboards.add(ws);
    ws.send(JSON.stringify({ type: "state", state }));
    ws.send(JSON.stringify({ type: "recording", value: recording }));
    for (const line of transcript.slice(-30)) ws.send(JSON.stringify(line));
    ws.on("close", () => dashboards.delete(ws));
  }
});

function acceptLine(ev) {
  transcript.push(ev);
  pending.push(ev);
  persistTranscript(ev);
  broadcast(ev); // live ticker, before any distill
}

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

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of dashboards) if (ws.readyState === 1) ws.send(msg);
}

function bumpAndBroadcast() {
  state.rev++;
  broadcast({ type: "state", state });
}

// ---------- closeout (runs in the background after Stop) ----------
async function runCloseout(endedSessionId) {
  broadcast({ type: "closeout", value: true });
  try {
    const { report } = await closeoutSession(endedSessionId, {
      bubbles: state.bubbles,
      speakerNames: state.speakers,
      tailLines: transcript.slice(-60),
      startedAt: sessionStartedAt || Date.now(),
      lineCount: transcript.length,
      speakers: speakerProfiles,
      activeSpeakers: [...activeSpeakers],
    });
    broadcast({ type: "report", report });
  } catch (e) {
    console.error("[closeout] error:", e.message);
  } finally {
    broadcast({ type: "closeout", value: false });
  }
}

// ---------- distill scheduler ----------
async function runDistill() {
  if (distilling || pending.length === 0) return;
  const lines = pending;
  pending = [];
  distilling = true;
  broadcast({ type: "distilling", value: true });
  try {
    const ops = await distill(state, lines, distillNote);
    console.log(`[distill] ${lines.length} lines -> ${ops.length} ops`);
    let changed = applyOps(state, ops);
    if (changed) {
      persistOps(ops);
      for (const b of state.bubbles) persistBubble(b);
      for (const op of ops) if (op.op === "remove" && op.id) persistRemoval(op.id, "distill");
    }
    if (ops.some((o) => o.op === "speakers")) persistSpeakerNames(state.speakers);
    // restored bubbles must earn their place: an update clears the flag (in
    // applyOps); whatever is still flagged after a few distills gets dropped
    if (restoreState) {
      restoreState.distills++;
      const unconfirmed = state.bubbles.filter((b) => b.restored);
      if (!unconfirmed.length) {
        restoreState = null;
        distillNote = "";
      } else if (restoreState.distills >= RESTORE_MAX_DISTILLS) {
        state.bubbles = state.bubbles.filter((b) => !b.restored);
        for (const b of unconfirmed) persistRemoval(b.id, "stale-restore");
        console.log(`[hub] archived ${unconfirmed.length} unconfirmed restored bubble(s)`);
        restoreState = null;
        distillNote = "";
        changed = true;
      }
    }
    if (changed) bumpAndBroadcast();
  } catch (e) {
    console.error("[distill] error:", e.message);
    pending = lines.concat(pending); // retry these lines next round
  } finally {
    lastDistill = Date.now();
    distilling = false;
    broadcast({ type: "distilling", value: false });
  }
}

setInterval(() => {
  const due =
    recording &&
    (pending.length >= DISTILL_EAGER_LINES ||
      (pending.length >= DISTILL_MIN_LINES && Date.now() - lastDistill >= DISTILL_EVERY_MS));
  if (due) runDistill();
}, 3_000);

const restored = await initDb();
if (restored.sessionId) {
  // hub died mid-recording (< 30 min ago): pick up where it left off
  recording = true;
  sessionStartedAt = restored.startedAt ? new Date(restored.startedAt).getTime() : Date.now();
  state.bubbles = restored.bubbles;
  state.speakers = restored.speakerNames || {};
  state.rev++;
}

server.listen(PORT, () => console.log(`[hub] listening on :${PORT} (ws /ingest for capture, ws for dashboards)`));
