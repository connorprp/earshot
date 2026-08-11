// Closeout pass: when a recording stops, distill the whole session into a
// report (saved on the session doc + a markdown file in out/) and decide
// whether this session CONTINUES the previous one — same conversation picked
// back up after a pause. Sessions are never merged; related ones share a
// conversationId (chained: each continuation joins the previous session's
// conversation).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { getPreviousSession, saveSessionReport } from "./db.js";
import { safeName } from "./actions.js";

const LLM_MODEL = process.env.EARSHOT_LLM || "sonnet";
const VOICE_MATCH_THRESHOLD = 0.5;

const SYSTEM = `You are the closeout engine of "Earshot", an ambient conversation dashboard.
A recording session just ended. You get the session's final concept bubbles, the
tail of its transcript, and a summary of the PREVIOUS session (if any).

Produce a session report, and judge whether this session is a CONTINUATION of the
previous one — the same conversation resumed after a recording pause (same
participants and/or the same threads picked back up), not merely a similar topic.
A voice-match signal is provided when available: it compares actual voice
embeddings between the two sessions and is strong evidence either way.

Respond with ONLY a JSON object, no prose:
{
  "report": {
    "title": "3-8 word session title",
    "summary": "one tight paragraph: what the conversation was and where it landed",
    "participants": ["me (the user)", "them-1 — likely Dave (addressed by name)", ...],
    "decisions": ["decision reached", ...],
    "openItems": ["unresolved question / promised follow-up", ...]
  },
  "continuesPrevious": true|false,
  "continuesReason": "one line of evidence"
}
Keep every list short and load-bearing; empty arrays are fine. Base participants
on voice tags and context only — never invent names.`;

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// how many of this session's active voices also spoke in the previous session
function voiceMatch(cur, prev) {
  // "me" (the device owner) is in every session by definition — counting it
  // would make every pair of sessions look related, so it is never a signal
  const active = (s) =>
    (s.speakers || []).filter((sp) => sp.id !== "me" && (s.activeSpeakers || []).includes(sp.id));
  const curV = active(cur);
  const prevV = active(prev);
  if (!curV.length || !prevV.length) return null;
  const matches = curV.filter((c) =>
    prevV.some((p) => cosine(c.centroid, p.centroid) >= VOICE_MATCH_THRESHOLD)
  ).length;
  return { matches, of: curV.length };
}

function buildPrompt({ bubbles, tailLines, startedAt, lineCount, speakerNames, context }, prev, voices) {
  const parts = [
    `Session started: ${new Date(startedAt).toString()}`,
    `Transcript lines this session: ${lineCount}`,
    ...(context ? [``, `CONTEXT:`, context] : []),
    ``,
    `FINAL DASHBOARD BUBBLES:`,
    JSON.stringify(bubbles.map(({ actions, ...b }) => b), null, 1),
    ``,
    `KNOWN SPEAKER NAMES (voice tag -> inferred name):`,
    JSON.stringify(speakerNames || {}),
    ``,
    `TRANSCRIPT TAIL (up to last 60 lines):`,
    // voice identity, not audio channel ("me" = the user; them-N may be remote
    // OR in the room, since the mic carries speakerphone calls and the room too)
    tailLines.map((l) => `[${l.speaker || (l.source === "me" ? "me" : "them")}] ${l.text}`).join("\n") || "(none)",
  ];
  if (prev) {
    const gapMin = Math.round((new Date(startedAt) - new Date(prev.session.endedAt)) / 60000);
    parts.push(
      ``,
      `PREVIOUS SESSION (ended ${gapMin} minutes before this one started):`,
      prev.session.report
        ? JSON.stringify(prev.session.report, null, 1)
        : JSON.stringify(prev.bubbles.map((b) => ({ title: b.title, summary: b.summary })), null, 1),
      voices
        ? `Voice match: ${voices.matches} of ${voices.of} voices in this session also spoke in the previous session.`
        : `Voice match: unavailable.`
    );
  } else {
    parts.push(``, `PREVIOUS SESSION: none.`);
  }
  parts.push(``, `Return the JSON object now.`);
  return parts.join("\n");
}

function parseObject(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in closeout response");
  return JSON.parse(body.slice(start, end + 1));
}

function writeReportFile(outDir, report, meta) {
  const lines = [
    `# ${report.title}`,
    ``,
    `_Earshot session report — ${new Date(meta.startedAt).toLocaleString()} (${meta.lineCount} transcript lines)_`,
  ];
  if (meta.continuesTitle) lines.push(`_Continues: **${meta.continuesTitle}**_`);
  lines.push(``, `## Summary`, ``, report.summary || "");
  const section = (name, items) => {
    if (items?.length) lines.push(``, `## ${name}`, ``, ...items.map((i) => `- ${i}`));
  };
  section("Participants", report.participants);
  section("Decisions", report.decisions);
  section("Open items", report.openItems);
  const file = path.join(outDir, `${safeName(report.title)}-session.md`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

/**
 * sessionData: { userId, outDir, env?, bubbles, speakerNames, tailLines,
 *                startedAt, lineCount, speakers, activeSpeakers }
 * Returns { report, continuesPrevious, file } — persists to Mongo when available.
 */
export async function closeoutSession(sessionDocId, sessionData) {
  const prev = await getPreviousSession(sessionData.userId, sessionDocId).catch(() => null);
  const voices = prev ? voiceMatch(sessionData, prev.session) : null;
  const prompt = buildPrompt(sessionData, prev, voices);

  let text = "";
  const q = query({
    prompt,
    options: {
      model: LLM_MODEL,
      systemPrompt: SYSTEM,
      allowedTools: [],
      maxTurns: 1,
      ...(sessionData.env ? { env: sessionData.env } : {}),
    },
  });
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype !== "success") throw new Error(`closeout failed: ${msg.subtype}`);
      text = msg.result;
    }
  }
  const parsed = parseObject(text);
  const report = parsed.report || {};
  const continues = Boolean(prev && parsed.continuesPrevious);

  const fields = { report, closedOutAt: new Date() };
  if (continues) {
    fields.conversationId = prev.session.conversationId || prev.session._id;
    fields.continuesSession = prev.session._id;
    fields.continuesReason = parsed.continuesReason || "";
  } else if (sessionDocId) {
    fields.conversationId = sessionDocId;
  }
  await saveSessionReport(sessionDocId, fields);

  const file = writeReportFile(sessionData.outDir, report, {
    startedAt: sessionData.startedAt,
    lineCount: sessionData.lineCount,
    continuesTitle: continues ? prev.session.report?.title || `session ${prev.session._id}` : null,
  });
  console.log(
    `[closeout] "${report.title}" -> ${path.basename(file)}` +
      (continues ? ` (continues previous: ${parsed.continuesReason})` : "")
  );
  return { report, continuesPrevious: continues, file };
}
