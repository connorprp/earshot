// MongoDB persistence. Everything is written as it happens:
//   sessions    one doc per recording session (Record starts, Stop sets endedAt;
//               an unfinished session with activity < 30 min ago is resumed)
//   transcripts every transcript line, verbatim
//   bubbles     every concept bubble, upserted on each change; removed/dismissed
//               bubbles stay as docs with a flag (nothing is ever deleted)
//   ops         audit trail of every distill patch batch
// If Mongo is unreachable at startup the hub still runs; writes become no-ops.
import { MongoClient } from "mongodb";

const URI = process.env.EARSHOT_MONGO || "mongodb://127.0.0.1:27017";
const DB_NAME = process.env.EARSHOT_DB || "earshot";
const RESUME_WINDOW_MS = 30 * 60 * 1000;

let db = null;
let sessionId = null;

function guard(fn) {
  return (...args) => {
    if (!db || !sessionId) return Promise.resolve();
    return fn(...args).catch((e) => console.error("[db] write failed:", e.message));
  };
}

export async function initDb() {
  try {
    const client = new MongoClient(URI, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    db = client.db(DB_NAME);
    await Promise.all([
      db.collection("transcripts").createIndex({ sessionId: 1, ts: 1 }),
      db.collection("bubbles").createIndex({ sessionId: 1, bubbleId: 1 }, { unique: true }),
      db.collection("sessions").createIndex({ lastActivityAt: -1 }),
      db.collection("ops").createIndex({ sessionId: 1, at: 1 }),
    ]);
  } catch (e) {
    console.error(`[db] UNAVAILABLE (${e.message}) — running memory-only, nothing will persist`);
    db = null;
    return { sessionId: null, bubbles: [] };
  }

  // resume a recent unfinished session (crash/restart mid-recording); otherwise
  // stay idle — sessions now start only via startSession() (the Record button)
  const recent = await db.collection("sessions").findOne(
    { lastActivityAt: { $gt: new Date(Date.now() - RESUME_WINDOW_MS) }, endedAt: null },
    { sort: { lastActivityAt: -1 } }
  );
  let bubbles = [];
  if (recent) {
    sessionId = recent._id;
    bubbles = await db
      .collection("bubbles")
      .find({ sessionId, removed: { $ne: true } }, { projection: { _id: 0, sessionId: 0, bubbleId: 0, removed: 0, restored: 0 } })
      .toArray();
    console.log(`[db] resumed session ${sessionId} (${bubbles.length} live bubbles restored)`);
  } else {
    console.log("[db] idle — press Record to start a session");
  }
  return {
    sessionId,
    bubbles,
    startedAt: recent?.startedAt || null,
    speakerNames: recent?.speakerNames || {},
  };
}

export async function startSession() {
  if (!db) return null;
  try {
    const res = await db.collection("sessions").insertOne({
      startedAt: new Date(),
      lastActivityAt: new Date(),
      endedAt: null,
    });
    sessionId = res.insertedId;
    console.log(`[db] new session ${sessionId}`);
  } catch (e) {
    console.error("[db] startSession failed:", e.message);
    sessionId = null;
  }
  return sessionId;
}

export async function endSession() {
  if (!db || !sessionId) return null;
  const id = sessionId;
  sessionId = null; // stop further writes attributing to this session
  try {
    await db
      .collection("sessions")
      .updateOne({ _id: id }, { $set: { endedAt: new Date(), lastActivityAt: new Date() } });
    console.log(`[db] ended session ${id}`);
  } catch (e) {
    console.error("[db] endSession failed:", e.message);
  }
  return id;
}

// most recent ENDED session other than excludeId, with its live bubbles —
// feeds the closeout relatedness check and the provisional restore on Record
export async function getPreviousSession(excludeId) {
  if (!db) return null;
  const query = { endedAt: { $ne: null } };
  if (excludeId) query._id = { $ne: excludeId };
  const session = await db.collection("sessions").findOne(query, { sort: { endedAt: -1 } });
  if (!session) return null;
  const bubbles = await db
    .collection("bubbles")
    .find(
      { sessionId: session._id, removed: { $ne: true } },
      { projection: { _id: 0, sessionId: 0, bubbleId: 0, removed: 0, restored: 0 } }
    )
    .toArray();
  return { session, bubbles };
}

export async function saveSessionReport(id, fields) {
  if (!db || !id) return;
  await db
    .collection("sessions")
    .updateOne({ _id: id }, { $set: fields })
    .catch((e) => console.error("[db] saveSessionReport failed:", e.message));
}

export const persistTranscript = guard(async (ev) => {
  await db.collection("transcripts").insertOne({ sessionId, ...ev, at: new Date() });
  await db.collection("sessions").updateOne({ _id: sessionId }, { $set: { lastActivityAt: new Date() } });
});

export const persistOps = guard((ops) =>
  db.collection("ops").insertOne({ sessionId, at: new Date(), ops })
);

// voice profiles: full capture-process cluster snapshot + which ids actually
// spoke in THIS session (closeout uses these for cross-session voice matching)
export const persistSpeakers = guard((speakers, activeIds) =>
  db.collection("sessions").updateOne(
    { _id: sessionId },
    { $set: { speakers, activeSpeakers: activeIds } }
  )
);

// voice tag -> inferred display name (distill "speakers" ops), for the ticker
export const persistSpeakerNames = guard((speakerNames) =>
  db.collection("sessions").updateOne({ _id: sessionId }, { $set: { speakerNames } })
);

export const persistBubble = guard((bubble) =>
  db.collection("bubbles").updateOne(
    { sessionId, bubbleId: bubble.id },
    { $set: { ...bubble, sessionId, bubbleId: bubble.id, removed: false } },
    { upsert: true }
  )
);

export const persistRemoval = guard((bubbleId, reason) =>
  db.collection("bubbles").updateOne(
    { sessionId, bubbleId },
    { $set: { removed: true, removedReason: reason, removedAt: new Date() } }
  )
);

// ---- read side (session browsing/export) ----
export async function listSessions(limit = 20) {
  if (!db) return [];
  return db.collection("sessions").find({}, { sort: { startedAt: -1 }, limit }).toArray();
}

export async function getSession(id) {
  if (!db) return null;
  const { ObjectId } = await import("mongodb");
  const _id = new ObjectId(id);
  const [session, transcript, bubbles] = await Promise.all([
    db.collection("sessions").findOne({ _id }),
    db.collection("transcripts").find({ sessionId: _id }, { sort: { ts: 1 } }).toArray(),
    db.collection("bubbles").find({ sessionId: _id }).toArray(),
  ]);
  return session ? { session, transcript, bubbles } : null;
}
