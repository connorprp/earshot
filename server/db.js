// MongoDB persistence, multi-tenant. Every document carries a userId (the
// signed-in Google email, or "local" when auth is off) so tenants never see
// each other's data:
//   sessions    one doc per recording session (Record starts, Stop sets endedAt;
//               an unfinished session with activity < 30 min ago is resumed)
//   transcripts every transcript line, verbatim
//   bubbles     every concept bubble, upserted on each change; removed/dismissed
//               bubbles stay as docs with a flag (nothing is ever deleted)
//   ops         audit trail of every distill patch batch
//   threads     one Claude conversation per concept+action: the messages the
//               user's own Claude streamed back, and the claude session id a
//               follow-up resumes
// If Mongo is unreachable at startup the hub still runs; writes become no-ops.
// Callers (Tenant instances) pass their userId and sessionId explicitly —
// this module keeps no per-session state.
import crypto from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";
import { keysEqual } from "./auth.js";

const URI = process.env.EARSHOT_MONGO || "mongodb://127.0.0.1:27017";
const DB_NAME = process.env.EARSHOT_DB || "earshot";
const RESUME_WINDOW_MS = 30 * 60 * 1000;

let db = null;

function guarded(promise) {
  return promise.catch((e) => console.error("[db] write failed:", e.message));
}

// session ids arrive as ObjectIds from the live tenant and as strings from the
// archive routes (an action clicked on a past session)
function oid(v) {
  if (!v) return null;
  if (v instanceof ObjectId) return v;
  try {
    return new ObjectId(String(v));
  } catch {
    return null;
  }
}

export async function initDb() {
  try {
    const client = new MongoClient(URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    db = client.db(DB_NAME);
    await Promise.all([
      db.collection("transcripts").createIndex({ userId: 1, sessionId: 1, ts: 1 }),
      db.collection("bubbles").createIndex({ sessionId: 1, bubbleId: 1 }, { unique: true }),
      db.collection("sessions").createIndex({ userId: 1, lastActivityAt: -1 }),
      db.collection("ops").createIndex({ sessionId: 1, at: 1 }),
      db.collection("threads").createIndex({ userId: 1, sessionId: 1, bubbleId: 1, actionId: 1 }),
    ]);
    // one-time migration: docs written before multi-tenancy belong to "local"
    for (const c of ["sessions", "transcripts", "bubbles", "ops"]) {
      const r = await db.collection(c).updateMany({ userId: { $exists: false } }, { $set: { userId: "local" } });
      if (r.modifiedCount) console.log(`[db] migrated ${r.modifiedCount} ${c} docs -> userId "local"`);
    }
    console.log(`[db] connected (${DB_NAME})`);
    return true;
  } catch (e) {
    console.error(`[db] UNAVAILABLE (${e.message}) — running memory-only, nothing will persist`);
    db = null;
    return false;
  }
}

// ---- users (self-serve provisioning) ----
// users collection: { _id: email, captureKey, claudeTokenEnc, createdAt }.
// keyCache maps captureKey -> email for the /ingest websocket; env-configured
// keys are seeded in too. Memory-only mode gets ephemeral in-memory users.
const keyCache = new Map();
const memUsers = new Map();

export function seedCaptureKeys(pairs) {
  for (const [key, email] of pairs) keyCache.set(key, email);
}

export async function loadUsers() {
  if (!db) return;
  for (const u of await db.collection("users").find().toArray()) {
    if (u.captureKey) keyCache.set(u.captureKey, u._id);
  }
}

export async function getOrCreateUser(email) {
  if (!db) {
    if (!memUsers.has(email)) {
      const captureKey = crypto.randomBytes(24).toString("hex");
      memUsers.set(email, { _id: email, captureKey, claudeTokenEnc: null });
      keyCache.set(captureKey, email);
    }
    return memUsers.get(email);
  }
  let user = await db.collection("users").findOne({ _id: email });
  if (!user) {
    user = { _id: email, captureKey: crypto.randomBytes(24).toString("hex"), claudeTokenEnc: null, createdAt: new Date() };
    await db.collection("users").insertOne(user).catch(() => {});
    user = (await db.collection("users").findOne({ _id: email })) || user;
    console.log(`[db] provisioned user ${email}`);
  }
  if (user.captureKey) keyCache.set(user.captureKey, email);
  return user;
}

export async function rotateCaptureKey(email) {
  const captureKey = crypto.randomBytes(24).toString("hex");
  const user = await getOrCreateUser(email);
  if (user.captureKey) keyCache.delete(user.captureKey);
  user.captureKey = captureKey;
  keyCache.set(captureKey, email);
  if (db) await db.collection("users").updateOne({ _id: email }, { $set: { captureKey } }).catch(() => {});
  return captureKey;
}

export async function setClaudeToken(email, claudeTokenEnc) {
  const user = await getOrCreateUser(email);
  user.claudeTokenEnc = claudeTokenEnc;
  if (db) await db.collection("users").updateOne({ _id: email }, { $set: { claudeTokenEnc } }).catch(() => {});
}

export async function setUserField(email, fields) {
  const user = await getOrCreateUser(email);
  Object.assign(user, fields);
  if (db) await db.collection("users").updateOne({ _id: email }, { $set: fields }).catch(() => {});
}

// Tier-1 context: everyone who has signed in, as "Name <email>" — tiny and
// always in the distill prompt so voices/actions ground to real people
export async function directory() {
  if (!db) return [...memUsers.values()].map((u) => ({ email: u._id, name: u.name || "" }));
  const rows = await db
    .collection("users")
    .find({}, { projection: { _id: 1, name: 1 } })
    .toArray()
    .catch(() => []);
  return rows.map((u) => ({ email: u._id, name: u.name || "" }));
}

export function userByCaptureKey(key) {
  if (!key) return null;
  for (const [k, email] of keyCache) if (keysEqual(k, key)) return email;
  return null;
}

// users whose last session never ended (hub restart mid-recording): the hub
// resumes their tenants at boot without needing a static roster
export async function usersWithOpenSessions() {
  if (!db) return [];
  const rows = await db
    .collection("sessions")
    .find({ endedAt: null, lastActivityAt: { $gt: new Date(Date.now() - RESUME_WINDOW_MS) } })
    .toArray();
  return [...new Set(rows.map((r) => r.userId))];
}

// resume a recent unfinished session for this user (hub died mid-recording)
export async function resumeSession(userId) {
  if (!db) return null;
  const recent = await db.collection("sessions").findOne(
    { userId, lastActivityAt: { $gt: new Date(Date.now() - RESUME_WINDOW_MS) }, endedAt: null },
    { sort: { lastActivityAt: -1 } }
  );
  if (!recent) return null;
  const bubbles = await liveBubbles(recent._id);
  console.log(`[db] ${userId}: resumed session ${recent._id} (${bubbles.length} live bubbles restored)`);
  return {
    sessionId: recent._id,
    bubbles,
    startedAt: recent.startedAt,
    speakerNames: recent.speakerNames || {},
  };
}

async function liveBubbles(sessionId) {
  return db
    .collection("bubbles")
    .find(
      { sessionId, removed: { $ne: true } },
      { projection: { _id: 0, sessionId: 0, bubbleId: 0, removed: 0, restored: 0, userId: 0 } }
    )
    .toArray();
}

export async function startSession(userId) {
  if (!db) return null;
  try {
    const res = await db.collection("sessions").insertOne({
      userId,
      startedAt: new Date(),
      lastActivityAt: new Date(),
      endedAt: null,
    });
    console.log(`[db] ${userId}: new session ${res.insertedId}`);
    return res.insertedId;
  } catch (e) {
    console.error("[db] startSession failed:", e.message);
    return null;
  }
}

export async function endSession(sessionId) {
  if (!db || !sessionId) return null;
  try {
    await db
      .collection("sessions")
      .updateOne({ _id: sessionId }, { $set: { endedAt: new Date(), lastActivityAt: new Date() } });
    console.log(`[db] ended session ${sessionId}`);
  } catch (e) {
    console.error("[db] endSession failed:", e.message);
  }
  return sessionId;
}

export function persistTranscript(userId, sessionId, ev) {
  if (!db || !sessionId) return;
  guarded(db.collection("transcripts").insertOne({ userId, sessionId, ...ev, at: new Date() }));
  guarded(db.collection("sessions").updateOne({ _id: sessionId }, { $set: { lastActivityAt: new Date() } }));
}

export function persistOps(userId, sessionId, ops) {
  if (!db || !sessionId) return;
  guarded(db.collection("ops").insertOne({ userId, sessionId, at: new Date(), ops }));
}

export function persistBubble(userId, sessionId, bubble) {
  const _id = oid(sessionId);
  if (!db || !_id) return;
  guarded(
    db.collection("bubbles").updateOne(
      { sessionId: _id, bubbleId: bubble.id },
      { $set: { ...bubble, userId, sessionId: _id, bubbleId: bubble.id, removed: false } },
      { upsert: true }
    )
  );
}

export function persistRemoval(sessionId, bubbleId, reason) {
  const _id = oid(sessionId);
  if (!db || !_id) return;
  guarded(
    db.collection("bubbles").updateOne(
      { sessionId: _id, bubbleId },
      { $set: { removed: true, removedReason: reason, removedAt: new Date() } }
    )
  );
}

// ---- agent threads (a Claude conversation, anchored to a concept) ----
// One doc per (session, bubble, action): the messages the user's own Claude
// streamed back, plus the claude session id that lets a follow-up RESUME that
// same conversation on their machine. sessionId is a plain string here (the
// board's session, or "live" when nothing is recording) — a thread outlives
// the session it was started from.
export function saveThread(thread) {
  if (!db) return;
  const { messages, ...head } = thread;
  guarded(
    db.collection("threads").updateOne(
      { _id: thread.id },
      { $set: head, $setOnInsert: { messages: [] } },
      { upsert: true }
    )
  );
}

export function appendThreadMessages(threadId, messages, head = {}) {
  if (!db || !messages.length) return;
  guarded(
    db.collection("threads").updateOne(
      { _id: threadId },
      { $push: { messages: { $each: messages } }, $set: { ...head, updatedAt: new Date() } }
    )
  );
}

export async function getThread(userId, threadId) {
  if (!db) return null;
  return db.collection("threads").findOne({ _id: threadId, userId });
}

// newest first; the sheet asks for one bubble+action, the archive for a session
export async function findThreads(userId, filter = {}, limit = 50) {
  if (!db) return [];
  const q = { userId };
  for (const k of ["sessionId", "bubbleId", "actionId"]) if (filter[k]) q[k] = filter[k];
  return db.collection("threads").find(q, { sort: { updatedAt: -1 }, limit }).toArray();
}

// voice profiles: capture-process cluster snapshot + which ids spoke this session
export function persistSpeakers(sessionId, speakers, activeIds) {
  if (!db || !sessionId) return;
  guarded(
    db.collection("sessions").updateOne({ _id: sessionId }, { $set: { speakers, activeSpeakers: activeIds } })
  );
}

// voice tag -> inferred display name (distill "speakers" ops), for the ticker
export function persistSpeakerNames(sessionId, speakerNames) {
  if (!db || !sessionId) return;
  guarded(db.collection("sessions").updateOne({ _id: sessionId }, { $set: { speakerNames } }));
}

// most recent ENDED session for this user other than excludeId, with its live
// bubbles — feeds the closeout relatedness check and provisional restore
export async function getPreviousSession(userId, excludeId) {
  if (!db) return null;
  const query = { userId, endedAt: { $ne: null } };
  if (excludeId) query._id = { $ne: excludeId };
  const session = await db.collection("sessions").findOne(query, { sort: { endedAt: -1 } });
  if (!session) return null;
  return { session, bubbles: await liveBubbles(session._id) };
}

export async function saveSessionReport(sessionId, fields) {
  if (!db || !sessionId) return;
  await db
    .collection("sessions")
    .updateOne({ _id: sessionId }, { $set: fields })
    .catch((e) => console.error("[db] saveSessionReport failed:", e.message));
}

// ---- read side (session browsing/export), always scoped to one user ----
// Voice centroids (session.speakers) are big and useless to readers, so every
// read path here projects them out.
const NO_CENTROIDS = { speakers: 0 };

function escRx(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Session list for the sidebar / MCP list_sessions, newest first.
 * opts: { q, limit } — q searches the closeout report (title, summary,
 * decisions, open items, participants), the linked calendar event, AND every
 * transcript line; sessions matched through their transcript carry
 * { matches, snippet } so the UI can show why they hit.
 */
export async function listSessions(userId, opts = {}) {
  if (!db) return [];
  const { q = "", limit = 30 } = typeof opts === "number" ? { limit: opts } : opts;
  const match = { userId };
  let hits = new Map();

  const query = String(q || "").trim();
  if (query) {
    const rx = { $regex: escRx(query), $options: "i" };
    const rows = await db
      .collection("transcripts")
      .aggregate([
        { $match: { userId, text: rx } },
        { $sort: { ts: 1 } },
        { $group: { _id: "$sessionId", matches: { $sum: 1 }, snippet: { $first: "$text" } } },
        { $limit: 300 },
      ])
      .toArray()
      .catch(() => []);
    hits = new Map(rows.map((r) => [String(r._id), { matches: r.matches, snippet: r.snippet }]));
    match.$or = [
      { "report.title": rx },
      { "report.summary": rx },
      { "report.decisions": rx },
      { "report.openItems": rx },
      { "report.participants": rx },
      { "calendarEvent.title": rx },
      ...(hits.size ? [{ _id: { $in: rows.map((r) => r._id) } }] : []),
    ];
  }

  const rows = await db
    .collection("sessions")
    .aggregate([
      { $match: match },
      { $sort: { startedAt: -1 } },
      { $limit: Math.min(Number(limit) || 30, 200) },
      // counts by lookup rather than a stored counter, so sessions recorded
      // before this feature existed still show accurate numbers
      { $lookup: { from: "transcripts", localField: "_id", foreignField: "sessionId", as: "lc", pipeline: [{ $count: "n" }] } },
      { $lookup: { from: "bubbles", localField: "_id", foreignField: "sessionId", as: "bc", pipeline: [{ $match: { removed: { $ne: true } } }, { $count: "n" }] } },
      {
        $addFields: {
          lineCount: { $ifNull: [{ $first: "$lc.n" }, 0] },
          bubbleCount: { $ifNull: [{ $first: "$bc.n" }, 0] },
        },
      },
      { $project: { ...NO_CENTROIDS, lc: 0, bc: 0 } },
    ])
    .toArray()
    .catch((e) => {
      console.error("[db] listSessions failed:", e.message);
      return [];
    });

  return rows.map((r) => ({ ...r, ...(hits.get(String(r._id)) || {}) }));
}

export async function getSession(userId, id) {
  if (!db) return null;
  const _id = new ObjectId(id);
  const [session, transcript, bubbles] = await Promise.all([
    db.collection("sessions").findOne({ _id, userId }, { projection: NO_CENTROIDS }),
    db.collection("transcripts").find({ sessionId: _id, userId }, { sort: { ts: 1 } }).toArray(),
    db.collection("bubbles").find({ sessionId: _id, userId }).toArray(),
  ]);
  return session ? { session, transcript, bubbles } : null;
}

// ---- archived-bubble actions (clicking a button on a past session) ----
// One bubble out of a past session, shaped like a live board bubble.
export async function getSessionBubble(userId, sessionId, bubbleId) {
  if (!db) return null;
  const _id = oid(sessionId);
  if (!_id) return null;
  return db
    .collection("bubbles")
    .findOne(
      { sessionId: _id, bubbleId, userId },
      { projection: { _id: 0, sessionId: 0, bubbleId: 0, userId: 0 } }
    )
    .catch(() => null);
}

// that session's own context for the task prompt: its last N lines + the names
// its distiller inferred, so the agent never reads the LIVE conversation
export async function getSessionTail(userId, sessionId, limit = 150) {
  if (!db) return null;
  const _id = oid(sessionId);
  if (!_id) return null;
  const session = await db
    .collection("sessions")
    .findOne(
      { _id, userId },
      { projection: { speakerNames: 1, startedAt: 1, endedAt: 1, report: 1, calendarEvent: 1 } }
    )
    .catch(() => null);
  if (!session) return null;
  const rows = await db
    .collection("transcripts")
    .find(
      { sessionId: _id, userId },
      { sort: { ts: -1 }, limit, projection: { _id: 0, text: 1, source: 1, speaker: 1, ts: 1 } }
    )
    .toArray()
    .catch(() => []);
  return { session, lines: rows.reverse() };
}

// targeted status write so a click on an archived bubble never rewrites (or
// un-removes) the rest of the stored doc
// extra.notes: the instructions the user typed when they clicked (omitted on
// the completion write, so finishing a task never erases what was asked; ""
// is a real value — a later click with an empty box clears the old note).
// extra.threadId: the agent conversation this click opened.
export function setBubbleActionStatus(userId, sessionId, bubbleId, actionId, status, extra = {}) {
  if (!db) return;
  const _id = oid(sessionId);
  if (!_id) return;
  const set = { "actions.$[a].status": status, actionRunAt: new Date() };
  if (extra.notes !== undefined) set["actions.$[a].userNotes"] = extra.notes;
  if (extra.threadId) set["actions.$[a].threadId"] = extra.threadId;
  guarded(
    db.collection("bubbles").updateOne(
      { sessionId: _id, bubbleId, userId },
      { $set: set },
      { arrayFilters: [{ "a.id": actionId }] }
    )
  );
}

// full-history text search for the MCP read side (regex, newest first)
export async function searchTranscripts(userId, query, limit = 30) {
  if (!db) return [];
  const esc = escRx(query);
  return db
    .collection("transcripts")
    .find(
      { userId, text: { $regex: esc, $options: "i" } },
      { projection: { _id: 0, userId: 0 }, sort: { at: -1 }, limit }
    )
    .toArray();
}
