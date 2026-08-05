// MongoDB persistence, multi-tenant. Every document carries a userId (the
// signed-in Google email, or "local" when auth is off) so tenants never see
// each other's data:
//   sessions    one doc per recording session (Record starts, Stop sets endedAt;
//               an unfinished session with activity < 30 min ago is resumed)
//   transcripts every transcript line, verbatim
//   bubbles     every concept bubble, upserted on each change; removed/dismissed
//               bubbles stay as docs with a flag (nothing is ever deleted)
//   ops         audit trail of every distill patch batch
// If Mongo is unreachable at startup the hub still runs; writes become no-ops.
// Callers (Tenant instances) pass their userId and sessionId explicitly —
// this module keeps no per-session state.
import { MongoClient, ObjectId } from "mongodb";

const URI = process.env.EARSHOT_MONGO || "mongodb://127.0.0.1:27017";
const DB_NAME = process.env.EARSHOT_DB || "earshot";
const RESUME_WINDOW_MS = 30 * 60 * 1000;

let db = null;

function guarded(promise) {
  return promise.catch((e) => console.error("[db] write failed:", e.message));
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
  if (!db || !sessionId) return;
  guarded(
    db.collection("bubbles").updateOne(
      { sessionId, bubbleId: bubble.id },
      { $set: { ...bubble, userId, sessionId, bubbleId: bubble.id, removed: false } },
      { upsert: true }
    )
  );
}

export function persistRemoval(sessionId, bubbleId, reason) {
  if (!db || !sessionId) return;
  guarded(
    db.collection("bubbles").updateOne(
      { sessionId, bubbleId },
      { $set: { removed: true, removedReason: reason, removedAt: new Date() } }
    )
  );
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
export async function listSessions(userId, limit = 20) {
  if (!db) return [];
  return db.collection("sessions").find({ userId }, { sort: { startedAt: -1 }, limit }).toArray();
}

export async function getSession(userId, id) {
  if (!db) return null;
  const _id = new ObjectId(id);
  const [session, transcript, bubbles] = await Promise.all([
    db.collection("sessions").findOne({ _id, userId }),
    db.collection("transcripts").find({ sessionId: _id }, { sort: { ts: 1 } }).toArray(),
    db.collection("bubbles").find({ sessionId: _id }).toArray(),
  ]);
  return session ? { session, transcript, bubbles } : null;
}
