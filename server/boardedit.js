// The board, edited by the USER — through their own Claude ("✦ Ask Claude" on a
// concept or on the whole board), or by hand from the notes card.
//
// It speaks the same patch vocabulary as the distiller (add / update / remove a
// concept, name a voice), but applying it on the user's behalf changes what it
// MEANS: their word is final. Every bubble they touch is flagged `userEdited`,
// every voice they name is pinned, and standing notes they leave ride in every
// later distill prompt — so the automatic pass adds to their board instead of
// arguing with it. See "Authoritative user edits" in CLAUDE.md.
import {
  getSession,
  persistBubble,
  persistRemoval,
  persistSpeakerNames,
  saveSessionReport,
} from "./db.js";
import { carryActionHistory } from "./distill.js";

// only these may be written from a tool call: `removed`, `threadId`, `status`
// and friends are the hub's bookkeeping, not the agent's to set
const FIELDS = ["kind", "title", "summary", "details", "actions"];
const KINDS = ["scheduling", "task", "data", "decision", "discussion", "contact"];
const MAX_OPS = 24;
const MAX_NOTES = 16;
const MAX_DETAILS = 8;

// Shared by the MCP tool descriptions and the "Ask Claude" mission prompt, so
// the agent is told the same thing twice in the same words.
export const EDIT_DOC = `Ops (a JSON array, applied in order):
  {"op":"update","id":"<concept id>","bubble":{"title":"...","summary":"...","details":["..."],"kind":"..."}}
      only the fields you pass are replaced — send just what changes
  {"op":"add","bubble":{"kind":"task","title":"3-6 words","summary":"1-2 sentences","details":["..."]}}
  {"op":"remove","id":"<concept id>"}          the concept was wrong, or is not worth a card
  {"op":"speakers","map":{"them-2":"Dave Ramirez"}}   name a voice; the name is then PINNED
  {"op":"note","text":"..."}                   a standing correction/context for every later pass
  {"op":"unnote","index":0}                    drop note #index
kind is one of: ${KINDS.join(", ")}.`;

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

function newId(state, title) {
  const base = slugify(title) || "concept";
  if (!state.bubbles.some((b) => b.id === base)) return base;
  for (let i = 2; i < 50; i++) if (!state.bubbles.some((b) => b.id === `${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now() % 10000}`;
}

// free text from a tool call: clamp everything, keep nothing we didn't ask for
function cleanBubble(input = {}) {
  const b = {};
  for (const f of FIELDS) if (input[f] !== undefined) b[f] = input[f];
  if (b.title !== undefined) b.title = String(b.title).trim().slice(0, 120);
  if (b.summary !== undefined) b.summary = String(b.summary).trim().slice(0, 700);
  if (b.kind !== undefined) {
    const k = String(b.kind).toLowerCase();
    b.kind = KINDS.includes(k) ? k : "discussion";
  }
  if (b.details !== undefined) {
    b.details = (Array.isArray(b.details) ? b.details : [])
      .slice(0, MAX_DETAILS)
      .map((d) => String(d).trim().slice(0, 240))
      .filter(Boolean);
  }
  if (b.actions !== undefined) {
    b.actions = (Array.isArray(b.actions) ? b.actions : []).slice(0, 4).map((a, i) => ({
      id: String(a?.id || `a${i}`).slice(0, 24),
      type: String(a?.type || "note").slice(0, 24),
      label: String(a?.label || "Do it").slice(0, 80),
      payload: a?.payload && typeof a.payload === "object" ? a.payload : {},
      status: "idle",
    }));
  }
  return b;
}

function fieldList(b) {
  return FIELDS.filter((f) => b[f] !== undefined).join(", ");
}

/**
 * Apply user edit ops to a board-shaped object
 * ({ bubbles, speakers, speakerPins, notes }) — pure except for mutating it.
 * Returns what changed, so the caller can persist exactly that and tell the
 * user in words: { changed, touched, removedIds, editedIds, speakersChanged,
 * notesChanged, summary[], errors[] }.
 */
export function applyEditOps(state, ops) {
  state.bubbles = state.bubbles || [];
  state.speakers = state.speakers || {};
  state.speakerPins = state.speakerPins || [];
  state.notes = state.notes || [];
  const res = {
    changed: false,
    touched: [],
    removedIds: [],
    editedIds: [],
    speakersChanged: false,
    notesChanged: false,
    summary: [],
    errors: [],
  };
  const touch = (b) => {
    if (!res.touched.includes(b)) res.touched.push(b);
    if (!res.editedIds.includes(b.id)) res.editedIds.push(b.id);
  };

  for (const raw of Array.isArray(ops) ? ops.slice(0, MAX_OPS) : []) {
    const op = String(raw?.op || "").toLowerCase();
    if (op === "add") {
      const b = cleanBubble(raw.bubble);
      if (!b.title) {
        res.errors.push('an "add" op needs bubble.title');
        continue;
      }
      Object.assign(b, {
        id: newId(state, b.title),
        kind: b.kind || "discussion",
        details: b.details || [],
        actions: b.actions || [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        userEdited: true,
      });
      state.bubbles.push(b);
      res.summary.push(`added “${b.title}”`);
      touch(b);
      res.changed = true;
    } else if (op === "update") {
      const b = state.bubbles.find((x) => x.id === raw.id);
      if (!b) {
        res.errors.push(`no concept with id "${raw.id}" (call get_live_board for the current ids)`);
        continue;
      }
      const patch = cleanBubble(raw.bubble);
      if (!Object.keys(patch).length) {
        res.errors.push(`nothing to change on "${raw.id}"`);
        continue;
      }
      const prior = b.actions || [];
      Object.assign(b, patch, { id: b.id, createdAt: b.createdAt, updatedAt: Date.now(), userEdited: true });
      delete b.restored; // the user looked at it: it has earned its place
      if (patch.actions) carryActionHistory(prior, b.actions);
      res.summary.push(`updated “${b.title}” (${fieldList(patch)})`);
      touch(b);
      res.changed = true;
    } else if (op === "remove") {
      const b = state.bubbles.find((x) => x.id === raw.id);
      if (!b) {
        res.errors.push(`no concept with id "${raw.id}"`);
        continue;
      }
      state.bubbles = state.bubbles.filter((x) => x !== b);
      res.removedIds.push(b.id);
      res.editedIds.push(b.id);
      res.summary.push(`removed “${b.title}”`);
      res.changed = true;
    } else if (op === "speakers") {
      const map = raw.map && typeof raw.map === "object" ? raw.map : {};
      for (const [tag, name] of Object.entries(map)) {
        // "me" is the device owner by voice election — never renamed from here
        if (!/^them-\d+$/.test(tag) || typeof name !== "string" || !name.trim()) {
          res.errors.push(`"${tag}" isn't a nameable voice tag (them-1, them-2, ...)`);
          continue;
        }
        state.speakers[tag] = name.trim().slice(0, 60);
        if (!state.speakerPins.includes(tag)) state.speakerPins.push(tag);
        res.summary.push(`${tag} is ${state.speakers[tag]} (pinned)`);
        res.speakersChanged = true;
        res.changed = true;
      }
    } else if (op === "note") {
      const text = String(raw.text || "").trim().slice(0, 600);
      if (!text) {
        res.errors.push('a "note" op needs text');
        continue;
      }
      state.notes.push({ text, at: new Date() });
      if (state.notes.length > MAX_NOTES) state.notes.splice(0, state.notes.length - MAX_NOTES);
      res.summary.push(`pinned a note: “${text.slice(0, 60)}${text.length > 60 ? "…" : ""}”`);
      res.notesChanged = true;
      res.changed = true;
    } else if (op === "unnote") {
      const i = Number(raw.index);
      if (!Number.isInteger(i) || i < 0 || i >= state.notes.length) {
        res.errors.push(`no note at index ${raw.index}`);
        continue;
      }
      const [gone] = state.notes.splice(i, 1);
      res.summary.push(`dropped the note “${gone.text.slice(0, 40)}…”`);
      res.notesChanged = true;
      res.changed = true;
    } else {
      res.errors.push(`unknown op "${op}"`);
    }
  }
  return res;
}

/**
 * Same edits against a session in the ARCHIVE (reopened in the sidebar, not on
 * the board). Mongo holds the truth there, so we read it, apply, and write back
 * exactly what changed — the live board is untouched.
 */
export async function applyArchivedEdit(userId, sessionId, ops) {
  const data = await getSession(userId, sessionId).catch(() => null);
  if (!data) return { changed: false, summary: [], errors: ["That session isn't in the archive."] };
  const state = {
    bubbles: data.bubbles
      .filter((b) => !b.removed)
      .map(({ _id, sessionId: _s, bubbleId, userId: _u, ...b }) => b),
    speakers: data.session.speakerNames || {},
    speakerPins: data.session.speakerPins || [],
    notes: data.session.boardNotes || [],
  };
  const res = applyEditOps(state, ops);
  if (res.changed) {
    for (const b of res.touched) persistBubble(userId, sessionId, b);
    for (const id of res.removedIds) persistRemoval(sessionId, id, "user-edit");
    if (res.speakersChanged) persistSpeakerNames(sessionId, state.speakers, state.speakerPins);
    if (res.notesChanged) saveSessionReport(sessionId, { boardNotes: state.notes });
  }
  res.board = boardSnapshot(state); // what the editor should see now, not the live board
  return res;
}

// The user's standing notes, as the distiller (and the closeout) sees them.
// Deliberately blunt: this block exists to stop an automatic pass from undoing
// something the user just corrected out loud.
export function notesBlock(notes = []) {
  if (!notes.length) return "";
  return [
    `THE USER'S OWN NOTES (they wrote or dictated these while looking at the board —`,
    `they are AUTHORITATIVE. Never contradict, water down, or re-litigate them; apply`,
    `them wherever they are relevant, and keep them true in every bubble you touch):`,
    ...notes.map((n, i) => `  ${i + 1}. ${n.text}`),
  ].join("\n");
}

// What an "Ask Claude" agent is shown (and what get_live_board returns): the
// board WITH ids, because an agent that can't name a concept can't edit it.
export function boardSnapshot(state) {
  return {
    concepts: (state.bubbles || []).map((b) => ({
      id: b.id,
      kind: b.kind,
      title: b.title,
      summary: b.summary,
      details: b.details || [],
      userEdited: b.userEdited || undefined,
      actions: (b.actions || []).map((a) => ({ id: a.id, type: a.type, label: a.label, status: a.status })),
    })),
    speakerNames: state.speakers || {},
    pinnedVoices: state.speakerPins || [],
    yourNotes: (state.notes || []).map((n, i) => ({ index: i, text: n.text })),
  };
}
