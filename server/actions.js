// Action execution: every action produces a local artifact and opens it with
// the default app. No external auth needed for the PoC.
//   calendar    -> .ics  (opens in Outlook/Calendar, one click to save)
//   email       -> .eml with X-Unsent (opens as an editable draft)
//   spreadsheet -> .csv  (opens in Excel)
//   claude_code -> task brief .md + suggested claude command
//   note        -> appended to notes.md
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "out");
fs.mkdirSync(OUT_DIR, { recursive: true });

// hosted mode (EARSHOT_HOSTED=1): the hub runs on a server, so "open the file"
// becomes "hand the browser a download link" — the user's own machine then
// opens the .ics/.eml/.csv with its default app, same local-artifact philosophy
const HOSTED = process.env.EARSHOT_HOSTED === "1";

function openFile(p) {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", p]] :
    process.platform === "darwin" ? ["open", [p]] :
    ["xdg-open", [p]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}

// every action funnels through this: local -> open with default app,
// hosted -> return a /files download link for the dashboard to open
function deliver(file, message) {
  if (HOSTED) {
    return { ok: true, message, downloadUrl: `/files/${encodeURIComponent(path.basename(file))}` };
  }
  openFile(file);
  return { ok: true, message };
}

export function safeName(s) {
  return (s || "untitled").replace(/[^a-z0-9-_ ]/gi, "").trim().slice(0, 60) || "untitled";
}

function icsDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}

// The artifact path has no model to read instructions, so instructions the
// user typed in the send sheet are folded into the payload field that ends up
// in the file (notes/body/brief/markdown). Returns a COPY — the stored bubble
// must keep the model's original payload.
export function withUserNotes(action, notes) {
  const n = String(notes || "").trim();
  if (!n) return action;
  const p = { ...(action.payload || {}) };
  const field =
    action.type === "email" ? "body"
    : action.type === "note" ? "markdown"
    : action.type === "claude_code" || action.type === "agent" ? "brief"
    : "notes"; // calendar description; spreadsheet has no prose field, so it
               // rides along on the payload for the record
  p[field] = `${p[field] ? `${p[field]}\n\n` : ""}From you: ${n}`;
  return { ...action, payload: p };
}

// googleUser: the tenant's user doc when their Google account is connected —
// calendar/email actions then do the REAL thing (event with invites, Gmail
// draft) instead of producing an artifact. Everything else, and any Google
// failure, falls back to the local-artifact path.
export async function executeAction(action, bubble, outDir = OUT_DIR, googleUser = null) {
  fs.mkdirSync(outDir, { recursive: true });
  const p = action.payload || {};
  switch (action.type) {
    case "calendar": {
      if (!p.start) return { ok: false, message: "No start time captured — edit the bubble first." };
      if (googleUser) {
        try {
          const { createCalendarEvent } = await import("./google.js");
          const link = await createCalendarEvent(googleUser, p);
          if (link) {
            return {
              ok: true,
              message: `Event created on your Google Calendar${p.attendees?.length ? ` — invites sent to ${p.attendees.join(", ")}` : ""}.`,
              link,
            };
          }
        } catch (e) {
          console.error("[actions] calendar API failed, falling back to .ics:", e.message);
        }
      }
      const start = new Date(p.start);
      const end = new Date(start.getTime() + (p.durationMinutes || 30) * 60000);
      const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Earshot//EN",
        "BEGIN:VEVENT",
        `UID:${Date.now()}@earshot`,
        `DTSTAMP:${icsDate(new Date().toISOString())}`,
        `DTSTART:${icsDate(start.toISOString())}`,
        `DTEND:${icsDate(end.toISOString())}`,
        `SUMMARY:${p.title || bubble.title}`,
        `DESCRIPTION:${(p.notes || "").replace(/\n/g, "\\n")}`,
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");
      const file = path.join(outDir, `${safeName(p.title || bubble.title)}.ics`);
      fs.writeFileSync(file, ics);
      return deliver(file, `Calendar event ready: ${p.title || bubble.title}`);
    }
    case "email": {
      if (googleUser) {
        try {
          const { createGmailDraft } = await import("./google.js");
          const id = await createGmailDraft(googleUser, p);
          if (id) return { ok: true, message: "Draft created in your Gmail — review and send from there." };
        } catch (e) {
          console.error("[actions] gmail API failed, falling back to .eml:", e.message);
        }
      }
      const eml = [
        "X-Unsent: 1",
        `To: ${p.to || ""}`,
        `Subject: ${p.subject || bubble.title}`,
        "Content-Type: text/plain; charset=utf-8",
        "",
        p.body || "",
      ].join("\r\n");
      const file = path.join(outDir, `${safeName(p.subject || bubble.title)}.eml`);
      fs.writeFileSync(file, eml);
      return deliver(file, "Email draft ready.");
    }
    case "spreadsheet": {
      const esc = (v) => {
        const s = String(v ?? "");
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const rows = [p.columns || [], ...(p.rows || [])];
      const csv = rows.map((r) => r.map(esc).join(",")).join("\r\n");
      const file = path.join(outDir, `${safeName(p.name || bubble.title)}.csv`);
      fs.writeFileSync(file, csv);
      return deliver(file, `Spreadsheet ready: ${path.basename(file)}`);
    }
    case "claude_code": {
      const file = path.join(outDir, `${safeName(p.title || bubble.title)}-brief.md`);
      fs.writeFileSync(file, `# ${p.title || bubble.title}\n\n${p.brief || bubble.summary}\n`);
      return deliver(file, `Brief written. Run: claude "Read '${file}' and do what it describes"`);
    }
    case "agent": {
      // fallback only: with a Claude-capable capture agent connected, the hub
      // dispatches this as a device task instead of ever reaching here
      const file = path.join(outDir, `${safeName(p.title || bubble.title)}-brief.md`);
      fs.writeFileSync(file, `# ${p.title || bubble.title}\n\n${p.brief || bubble.summary}\n`);
      return deliver(
        file,
        "No Claude agent reachable on your computer — saved the work order as a brief instead. Open the Earshot app (and install Claude Code) to run these on your device."
      );
    }
    case "note": {
      const file = path.join(outDir, "notes.md");
      const stamp = new Date().toLocaleString();
      fs.appendFileSync(file, `\n## ${p.title || bubble.title} — ${stamp}\n\n${p.markdown || bubble.summary}\n`);
      return deliver(file, "Saved to notes.md.");
    }
    default:
      return { ok: false, message: `Unknown action type: ${action.type}` };
  }
}
