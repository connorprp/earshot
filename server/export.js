// Session export: one renderer for both the archive (Mongo-backed sessions)
// and the live board (in-memory), so a download looks the same whether or not
// the session has been closed out yet. Input shape matches db.getSession():
// { session, transcript, bubbles }.
import { safeName } from "./actions.js";

export function sessionTitle(session = {}) {
  return (
    session.report?.title ||
    session.calendarEvent?.title ||
    `Earshot session ${new Date(session.startedAt || Date.now()).toLocaleString()}`
  );
}

export function exportFileName(session, ext) {
  return `${safeName(sessionTitle(session))}.${ext}`;
}

function who(line, names = {}) {
  if (line.source === "me") return "Me";
  return names[line.speaker] || line.speaker || "Them";
}

function stamp(v) {
  return v ? new Date(v).toLocaleString() : "";
}

export function renderTranscript({ session = {}, transcript = [] }) {
  const names = session.speakerNames || {};
  const head = [`${sessionTitle(session)}`, `${stamp(session.startedAt)} — ${transcript.length} lines`, ""];
  return head.concat(transcript.map((l) => `[${who(l, names)}] ${l.text}`)).join("\n") + "\n";
}

export function renderSessionMarkdown({ session = {}, transcript = [], bubbles = [] }) {
  const names = session.speakerNames || {};
  const report = session.report || null;
  const live = bubbles.filter((b) => !b.removed);
  const out = [`# ${sessionTitle(session)}`, ``];

  const meta = [`Started: ${stamp(session.startedAt)}`];
  if (session.endedAt) meta.push(`Ended: ${stamp(session.endedAt)}`);
  else meta.push(`Ended: (still open)`);
  meta.push(`Transcript lines: ${transcript.length}`);
  meta.push(`Concepts: ${live.length}`);
  out.push(`_${meta.join(" · ")}_`, ``);

  if (session.calendarEvent?.title) {
    const ev = session.calendarEvent;
    out.push(
      `> Calendar: **${ev.title}**${ev.start ? ` (${ev.start})` : ""}` +
        (ev.attendees?.length ? ` — ${ev.attendees.map((a) => a.name || a.email).join(", ")}` : ""),
      ``
    );
  }

  const section = (name, items) => {
    if (items?.length) out.push(`## ${name}`, ``, ...items.map((i) => `- ${i}`), ``);
  };
  if (report) {
    if (report.summary) out.push(`## Summary`, ``, report.summary, ``);
    section("Participants", report.participants);
    section("Decisions", report.decisions);
    section("Open items", report.openItems);
  } else {
    out.push(`_No session report yet — the closeout pass runs when the recording stops._`, ``);
  }

  out.push(`## Concepts`, ``);
  if (!live.length) out.push(`_None._`, ``);
  for (const b of live) {
    out.push(`### ${b.title}${b.kind ? ` — _${b.kind}_` : ""}`, ``);
    if (b.summary) out.push(b.summary, ``);
    if (b.details?.length) out.push(...b.details.map((d) => `- ${d}`), ``);
    if (b.actions?.length) {
      out.push(
        `Suggested actions: ` +
          b.actions.map((a) => `${a.label}${a.status && a.status !== "idle" ? ` (${a.status})` : ""}`).join(" · "),
        ``
      );
    }
  }

  const speakerList = Object.entries(names);
  if (speakerList.length) {
    out.push(`## Voices`, ``, ...speakerList.map(([tag, name]) => `- ${tag} → ${name}`), ``);
  }

  out.push(`## Transcript`, ``);
  if (!transcript.length) out.push(`_Empty._`);
  for (const l of transcript) out.push(`**${who(l, names)}** ${l.text}`, ``);
  return out.join("\n") + "\n";
}

// { body, contentType, filename } for a download response
export function renderExport(data, format) {
  const session = data.session || {};
  if (format === "json") {
    return {
      body: JSON.stringify(
        {
          title: sessionTitle(session),
          startedAt: session.startedAt || null,
          endedAt: session.endedAt || null,
          report: session.report || null,
          calendarEvent: session.calendarEvent || null,
          speakerNames: session.speakerNames || {},
          bubbles: data.bubbles || [],
          transcript: (data.transcript || []).map(({ _id, userId, sessionId, ...l }) => l),
        },
        null,
        1
      ),
      contentType: "application/json",
      filename: exportFileName(session, "json"),
    };
  }
  if (format === "txt") {
    return {
      body: renderTranscript(data),
      contentType: "text/plain; charset=utf-8",
      filename: exportFileName(session, "txt"),
    };
  }
  return {
    body: renderSessionMarkdown(data),
    contentType: "text/markdown; charset=utf-8",
    filename: exportFileName(session, "md"),
  };
}
