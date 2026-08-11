// The distill loop: turns new transcript lines + current dashboard state into
// patch ops, using the Claude Agent SDK (rides the local Claude Code auth).
import { query } from "@anthropic-ai/claude-agent-sdk";

const LLM_MODEL = process.env.EARSHOT_LLM || "sonnet";

const SYSTEM = `You are the distillation engine of "Earshot", a live ambient dashboard.
You receive the CURRENT dashboard state (concept bubbles) and NEW transcript lines
from an ongoing real-world conversation. Every line is prefixed with WHO said it,
identified by VOICE: [me] is the user; [them-1], [them-2], ... are other people.
The same tag is always the same voice (anonymous voice matching), so different
tags are different people. A tagged voice may be on a call, in a video, on a
phone's speaker, or physically in the room with the user — do not assume a
remote call. A bare [them] is a voice that could not be placed.
When 2+ distinct voices appear, maintain ONE bubble of kind "contact" titled
"Participants" mapping voices to likely identities inferred from context —
introductions, being addressed by name ("thanks, Dave"), roles, who runs the
meeting. Hedge honestly: "them-2 — likely Dave (addressed by name)" or
"them-3 — unidentified". Update it as evidence accumulates; never invent names.
The "speakers" op (below) is the ticker's name source and is independent of
this bubble — emit it whether or not a Participants bubble exists.

Your job: keep the dashboard a clean, distilled, live-morphing picture of the
conversation, and attach likely next actions to each concept.

Respond with ONLY a JSON array of patch operations, no prose:
  {"op":"add","bubble":{...}}          // a genuinely NEW concept emerged
  {"op":"update","id":"...","bubble":{...partial fields to replace...}}
  {"op":"remove","id":"..."}           // concept was abandoned or fully superseded
  {"op":"speakers","map":{"them-2":"Dave","them-3":"Sarah?"}}
      // voice-tag -> name for the live ticker. Emit whenever new lines let you
      // name a voice (or revise a name) — introductions, "thanks, Dave", roles.
      // "Name?" = tentative. Merged into known names; send only what changed.
      // Emit this even when nothing else changed (alongside an otherwise empty
      // patch). Never invent names, and never map "me" (that is the user).

Bubble shape:
{
  "id": "short-slug",
  "kind": "scheduling" | "task" | "data" | "decision" | "discussion" | "contact",
  "title": "3-6 word title",
  "summary": "1-2 sentence distilled summary of where this concept stands NOW",
  "details": ["short bullet", ...],           // max 6, only load-bearing facts
  "actions": [
    {"id":"slug","type":"calendar","label":"Add to calendar",
     "payload":{"title":"...","start":"YYYY-MM-DDTHH:MM","durationMinutes":30,"notes":"...",
                "attendees":["email@..."]}},   // only emails you're confident of
    {"id":"slug","type":"email","label":"Draft follow-up email",
     "payload":{"to":"","subject":"...","body":"..."}},
    {"id":"slug","type":"spreadsheet","label":"Make a spreadsheet",
     "payload":{"name":"...","columns":["..."],"rows":[["..."]]}},
    {"id":"slug","type":"agent","label":"Draft the counselor referral",
     "payload":{"title":"...","brief":"self-contained markdown work order: the goal, every load-bearing fact/name/date from the conversation, and the exact deliverable to produce"}},
    {"id":"slug","type":"claude_code","label":"Send to Claude Code",
     "payload":{"title":"...","brief":"full markdown task brief for a coding agent"}},
    {"id":"slug","type":"note","label":"Save as note",
     "payload":{"title":"...","markdown":"..."}}
  ]
}

Rules:
- STRONGLY prefer updating an existing bubble over adding a near-duplicate.
  A concept evolving (time agreed, decision made, more rows of data) is an update.
- Only add a bubble for a distinct concept worth acting on or remembering.
  Small talk, filler, and meta-chatter get NO bubble.
- Actions are hedged bets: 2-4 per bubble, ordered most-likely first. It's fine
  to offer several plausible paths (calendar + note + email). The UI adds an
  "ignore" affordance — never include an ignore action yourself.
- "agent" actions spawn the user's own Claude agent on their computer: it can
  research, draft documents, and produce finished files autonomously. Prefer
  "agent" over "note" when the obvious next step is a WORK PRODUCT (a referral,
  report, plan, comparison, analysis, polished draft) rather than just
  remembering something. Label it with the deliverable ("Draft counselor
  referral", "Research childcare options"). The brief must stand alone.
- Pre-fill payloads as completely as the conversation allows. Resolve relative
  dates ("next Thursday", "tomorrow at 2") to concrete datetimes using the
  current datetime provided. If a critical field is unknown, leave it "".
- When speech-to-text has obvious mis-hearings, use conversational context to
  infer the intended words.
- Speech-to-text also garbles agency and tense: "we should put up posters" can
  arrive as "I put up posters". Treat a passing first-person claim that work is
  ALREADY DONE as proposed/claimed ("posters proposed") unless other lines
  corroborate it actually happened.
- Keep the dashboard tight: distill, condense, merge. Quality over quantity.
- THE USER OUTRANKS YOU. A "THE USER'S OWN NOTES" block, and any bubble carrying
  "userEdited": true, come from the user editing this board themselves (they told
  their own Claude to fix it). Treat both as ground truth: never revert their
  wording or facts, never remove a userEdited bubble unless the conversation
  clearly resolves it, and propagate their correction everywhere else it applies
  (a name they fixed, a concept they reclassified, a detail they struck). You may
  still ADD genuinely new developments to a userEdited bubble.
- Voice names the user pinned are final — do not re-map that tag, even if the
  conversation makes another name look plausible.
- A CONTEXT block may list known company people and the calendar meeting this
  recording belongs to. Ground identities in it: prefer its real names/emails
  for participants, action payloads (attendees, to:), and the speakers op.
  People in the meeting's attendee list are the most likely voices.
- CONTEXT may also list apps connected to the user's own Claude agent (which
  executes every action button). Weight action choices toward what those apps
  make real — e.g. with Gmail connected an email action produces an actual
  draft, with Google Calendar a real event, with Notion/Drive real notes and
  sheets — and let labels say so ("Draft in Gmail"). Without such a list,
  actions still work but produce files.
- Output [] if the new lines change nothing.`;

function upcomingDays(now, n = 14) {
  const days = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getTime() + i * 86_400_000);
    const label = i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : "";
    days.push(d.toDateString() + label);
  }
  return days.join("\n");
}

function buildPrompt(state, lines, note, context) {
  const now = new Date();
  // identity, not channel: a mic line can be someone else (speakerphone, the
  // room), so the voice tag is what the model sees when there is one
  const transcript = lines
    .map((l) => `[${l.speaker || (l.source === "me" ? "me" : "them")}] ${l.text}`)
    .join("\n");
  return [
    `Current datetime: ${now.toString()}`,
    ``,
    `Calendar for resolving relative dates (use these EXACT weekday/date pairs):`,
    upcomingDays(now),
    ...(context ? [``, `CONTEXT:`, context] : []),
    ``,
    `CURRENT DASHBOARD STATE:`,
    JSON.stringify(
      {
        bubbles: state.bubbles,
        knownSpeakerNames: state.speakers || {},
        ...(state.speakerPins?.length ? { pinnedByTheUser: state.speakerPins } : {}),
      },
      null,
      1
    ),
    ...(note ? [``, note] : []),
    ``,
    `NEW TRANSCRIPT LINES:`,
    transcript,
    ``,
    `Return the JSON patch array now.`,
  ].join("\n");
}

function parseOps(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1) return [];
  return JSON.parse(body.slice(start, end + 1));
}

// env: optional full environment for the spawned Claude process — used to run
// each tenant's distills under their own CLAUDE_CODE_OAUTH_TOKEN
// context: Tier-1 session context (people directory + current calendar event)
export async function distill(state, lines, note = "", env = null, context = "") {
  const prompt = buildPrompt(state, lines, note, context);
  let text = "";
  const q = query({
    prompt,
    options: {
      model: LLM_MODEL,
      systemPrompt: SYSTEM,
      allowedTools: [],
      maxTurns: 1,
      ...(env ? { env } : {}),
    },
  });
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype !== "success") throw new Error(`distill failed: ${msg.subtype}`);
      text = msg.result;
    }
  }
  return parseOps(text);
}

let idCounter = 0;

export function applyOps(state, ops) {
  let changed = false;
  for (const op of ops) {
    if (op.op === "add" && op.bubble) {
      const b = op.bubble;
      b.id = b.id && !state.bubbles.some((x) => x.id === b.id) ? b.id : `b${++idCounter}-${Date.now() % 10000}`;
      b.createdAt = Date.now();
      b.updatedAt = Date.now();
      normalizeActions(b);
      state.bubbles.push(b);
      changed = true;
    } else if (op.op === "update" && op.id) {
      const b = state.bubbles.find((x) => x.id === op.id);
      if (b) {
        const prior = b.actions || [];
        Object.assign(b, op.bubble || {}, { id: b.id, createdAt: b.createdAt, updatedAt: Date.now() });
        delete b.restored; // an update confirms a provisionally-restored bubble
        normalizeActions(b);
        carryActionHistory(prior, b.actions);
        changed = true;
      }
    } else if (op.op === "remove" && op.id) {
      const before = state.bubbles.length;
      state.bubbles = state.bubbles.filter((x) => x.id !== op.id);
      changed = changed || state.bubbles.length !== before;
    } else if (op.op === "speakers" && op.map && typeof op.map === "object") {
      state.speakers = state.speakers || {};
      for (const [tag, name] of Object.entries(op.map)) {
        // a name the user pinned (through their own Claude) is not up for review
        if (state.speakerPins?.includes(tag)) continue;
        if (/^them-\d+$/.test(tag) && typeof name === "string" && name.trim()) {
          state.speakers[tag] = name.trim();
          changed = true;
        }
      }
    }
  }
  return changed;
}

// An update op rewrites the whole actions array, so what the USER did with a
// button (ran it, typed instructions for it) would be erased by the next
// distill. Carry that across — but only onto an action that is still the same
// action: ids are positional (a0, a1…), so label+type must match too.
export function carryActionHistory(prior, next) {
  for (const a of next) {
    const p = prior.find((x) => x.id === a.id && x.label === a.label && x.type === a.type);
    if (!p) continue;
    if (p.status && p.status !== "idle") a.status = p.status;
    if (p.userNotes) a.userNotes = p.userNotes;
    if (p.threadId) a.threadId = p.threadId; // the Claude session behind the button

  }
}

function normalizeActions(bubble) {
  bubble.actions = (bubble.actions || []).slice(0, 4).map((a, i) => ({
    ...a,
    id: a.id || `a${i}`,
    status: a.status || "idle",
  }));
}
