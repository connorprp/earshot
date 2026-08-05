// Per-user Google integration, server-side OAuth code flow.
//   - calendar context: what meeting is happening right now (Tier-1 prompt context)
//   - real actions: calendar events with attendees, Gmail drafts
// Refresh tokens are stored AES-encrypted on the user doc (same EARSHOT_SECRET
// scheme as Claude tokens). Requires GOOGLE_CLIENT_SECRET alongside the shared
// EARSHOT_GOOGLE_CLIENT_ID, and {origin}/google/callback as an authorized
// redirect URI on that OAuth client. Without the secret the feature is dormant
// (Settings hides the button, everything falls back to .ics/.eml artifacts).
import { OAuth2Client } from "google-auth-library";
import { encryptSecret, decryptSecret } from "./auth.js";
import { setUserField } from "./db.js";

const CLIENT_ID = process.env.EARSHOT_GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
export const googleConfigured = Boolean(CLIENT_ID && CLIENT_SECRET);

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.compose",
];

function client(redirectUri) {
  return new OAuth2Client(CLIENT_ID, CLIENT_SECRET, redirectUri);
}

// signed, expiring state so the public callback can't be forged
export function buildAuthUrl(userId, redirectUri) {
  const state = encryptSecret(JSON.stringify({ u: userId, exp: Date.now() + 10 * 60_000 }));
  return client(redirectUri).generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // always mint a refresh token
    scope: SCOPES,
    state,
  });
}

export async function handleCallback(code, state, redirectUri) {
  const parsed = JSON.parse(decryptSecret(state) || "null");
  if (!parsed || Date.now() > parsed.exp) throw new Error("state expired");
  const { tokens } = await client(redirectUri).getToken(code);
  if (!tokens.refresh_token) throw new Error("no refresh token granted");
  await setUserField(parsed.u, { googleTokenEnc: encryptSecret(tokens.refresh_token) });
  console.log(`[google] ${parsed.u} connected Google (calendar + gmail drafts)`);
  return parsed.u;
}

const accessCache = new Map(); // email -> { token, exp }

async function accessToken(user) {
  if (!user.googleTokenEnc) return null;
  const hit = accessCache.get(user._id);
  if (hit && Date.now() < hit.exp) return hit.token;
  const refresh = decryptSecret(user.googleTokenEnc);
  if (!refresh) return null;
  const c = client();
  c.setCredentials({ refresh_token: refresh });
  try {
    const { token } = await c.getAccessToken();
    accessCache.set(user._id, { token, exp: Date.now() + 45 * 60_000 });
    return token;
  } catch (e) {
    console.error(`[google] token refresh failed for ${user._id}: ${e.message}`);
    return null;
  }
}

async function api(user, method, url, body) {
  const token = await accessToken(user);
  if (!token) return null;
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`google api ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// the meeting happening around now (±20 min), for session context
export async function currentCalendarEvent(user) {
  const timeMin = new Date(Date.now() - 20 * 60_000).toISOString();
  const timeMax = new Date(Date.now() + 20 * 60_000).toISOString();
  const data = await api(
    user, "GET",
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=3`
  );
  const ev = data?.items?.find((e) => e.status !== "cancelled" && (e.attendees?.length || e.summary));
  if (!ev) return null;
  return {
    title: ev.summary || "(untitled)",
    description: (ev.description || "").slice(0, 400),
    start: ev.start?.dateTime || ev.start?.date,
    attendees: (ev.attendees || []).map((a) => ({ email: a.email, name: a.displayName || "" })),
  };
}

let tzCache = new Map();
async function userTimezone(user) {
  if (!tzCache.has(user._id)) {
    const s = await api(user, "GET", "https://www.googleapis.com/calendar/v3/users/me/settings/timezone").catch(() => null);
    tzCache.set(user._id, s?.value || "America/New_York");
  }
  return tzCache.get(user._id);
}

// real calendar event; attendees get Google's invite email automatically
export async function createCalendarEvent(user, { title, start, durationMinutes, notes, attendees }) {
  const tz = await userTimezone(user);
  const startDate = new Date(start);
  const end = new Date(startDate.getTime() + (durationMinutes || 30) * 60_000);
  const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, "");
  const ev = await api(
    user, "POST",
    "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all",
    {
      summary: title,
      description: notes || "",
      start: { dateTime: fmt(startDate), timeZone: tz },
      end: { dateTime: fmt(end), timeZone: tz },
      attendees: (attendees || []).map((email) => ({ email })),
    }
  );
  if (!ev?.htmlLink) return null;
  // htmlLink carries no authuser, so a multi-account browser opens it under
  // whatever Google account is default and shows "Could not find the requested
  // event". Pin it to the account that owns the event (the connected account).
  const owner = ev.organizer?.email || ev.creator?.email;
  return owner ? `${ev.htmlLink}&authuser=${encodeURIComponent(owner)}` : ev.htmlLink;
}

// a real Gmail draft (never auto-sent — hedged, reviewable)
export async function createGmailDraft(user, { to, subject, body }) {
  const mime = [`To: ${to || ""}`, `Subject: ${subject || ""}`, "Content-Type: text/plain; charset=utf-8", "", body || ""].join("\r\n");
  const raw = Buffer.from(mime).toString("base64url");
  const d = await api(user, "POST", "https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    message: { raw },
  });
  return d?.id || null;
}
