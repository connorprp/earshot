// Hosted-mode auth. Two principals:
//   browsers    Google Sign-In: the dashboard posts a Google ID token, we
//               verify it (signature + audience) via google-auth-library,
//               check the email allowlist, and mint a signed session cookie.
//               Google handles identity; we only sign a cookie.
//   capture     a headless agent can't do OAuth: it authenticates with a
//               per-user static key (?key=...) on the /ingest websocket, and
//               the key determines WHOSE tenant the audio feeds.
// Local mode (EARSHOT_GOOGLE_CLIENT_ID unset) disables all of this — everyone
// is the single "local" tenant, exactly the old single-user behavior.
//
// Env: EARSHOT_GOOGLE_CLIENT_ID  Google OAuth web client id (console.cloud.google.com)
//      EARSHOT_ALLOWED_EMAILS    comma-separated allowlist; empty = any Google account (don't)
//      EARSHOT_CAPTURE_KEYS      per-user keys: "alice@x.com:key1,bob@x.com:key2"
//      EARSHOT_SECRET            cookie-signing secret; random per boot if unset
import crypto from "node:crypto";
import { OAuth2Client } from "google-auth-library";

const CLIENT_ID = process.env.EARSHOT_GOOGLE_CLIENT_ID || "";
const ALLOWED = (process.env.EARSHOT_ALLOWED_EMAILS || "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const SECRET = process.env.EARSHOT_SECRET || crypto.randomBytes(32).toString("hex");
// "email:key,email:key" -> Map<key, email>
const CAPTURE_KEYS = new Map(
  (process.env.EARSHOT_CAPTURE_KEYS || "")
    .split(",")
    .map((pair) => pair.trim().split(":"))
    .filter(([email, key]) => email && key)
    .map(([email, key]) => [key, email.toLowerCase()])
);
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const COOKIE = "earshot_session";

export const authEnabled = Boolean(CLIENT_ID);
const oauth = authEnabled ? new OAuth2Client(CLIENT_ID) : null;

export function publicConfig() {
  return { enabled: authEnabled, clientId: CLIENT_ID };
}

// the tenant roster in hosted mode (union of allowlist + capture-key owners)
export function allowedEmails() {
  return [...new Set([...ALLOWED, ...CAPTURE_KEYS.values()])];
}

// Google ID token -> allowlisted email, or null
export async function verifyGoogleCredential(credential) {
  const ticket = await oauth.verifyIdToken({ idToken: credential, audience: CLIENT_ID });
  const payload = ticket.getPayload() || {};
  const email = (payload.email || "").toLowerCase();
  if (!email || !payload.email_verified) return null;
  if (ALLOWED.length && !ALLOWED.includes(email)) return null;
  return email;
}

function sign(v) {
  return crypto.createHmac("sha256", SECRET).update(v).digest("base64url");
}

export function sessionCookie(email, secure) {
  const body = `${Buffer.from(email).toString("base64url")}.${Date.now() + SESSION_TTL_MS}`;
  const value = `${body}.${sign(body)}`;
  return (
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? "; Secure" : ""}`
  );
}

// cookie header -> authenticated email, or null
export function sessionEmail(cookieHeader) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(cookieHeader || "");
  if (!m) return null;
  const [b64, exp, mac] = m[1].split(".");
  if (!b64 || !exp || !mac) return null;
  const expect = sign(`${b64}.${exp}`);
  const a = Buffer.from(expect);
  const b = Buffer.from(mac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() > Number(exp)) return null;
  return Buffer.from(b64, "base64url").toString();
}

// request -> tenant userId (email), "local" when auth is off, null when denied
export function browserUser(req) {
  if (!authEnabled) return "local";
  return sessionEmail(req.headers.cookie);
}

// /ingest upgrade -> tenant userId owning this capture key, or null
export function captureUser(reqUrl) {
  if (!authEnabled) return "local";
  const key = new URL(reqUrl, "http://x").searchParams.get("key") || "";
  for (const [k, email] of CAPTURE_KEYS) {
    const a = Buffer.from(k);
    const b = Buffer.from(key);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return email;
  }
  return null;
}
