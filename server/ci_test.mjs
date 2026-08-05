// Hub auth-gating test for CI (no Mongo available: hub runs memory-only).
// Spawns the hub in hosted mode and verifies the full auth matrix.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const PORT = 7123;
const BASE = `http://127.0.0.1:${PORT}`;
// into process.env FIRST so our own auth.js import (cookie minting) sees the
// same secret as the spawned hub
Object.assign(process.env, {
  EARSHOT_PORT: String(PORT),
  EARSHOT_HOSTED: "1",
  EARSHOT_SECRET: "ci-secret",
  EARSHOT_GOOGLE_CLIENT_ID: "ci-fake.apps.googleusercontent.com",
  EARSHOT_ALLOWED_EMAILS: "alice@example.com,bob@example.com",
  EARSHOT_CAPTURE_KEYS: "alice@example.com:key-alice,bob@example.com:key-bob",
  EARSHOT_MONGO: "mongodb://127.0.0.1:1/?serverSelectionTimeoutMS=500&connectTimeoutMS=500",
});
const env = { ...process.env };

const hub = spawn("node", ["index.js"], { cwd: import.meta.dirname, env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
hub.stdout.on("data", (d) => (log += d));
hub.stderr.on("data", (d) => (log += d));

let failures = 0;
function check(label, cond) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

function wsClose(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    const t = setTimeout(() => { ws.terminate(); resolve("open"); }, 1500);
    ws.on("close", (code) => { clearTimeout(t); resolve(code); });
    ws.on("error", () => {});
  });
}

try {
  for (let i = 0; i < 40 && !log.includes("listening on"); i++) await sleep(500);
  if (!log.includes("listening on")) throw new Error("hub never started:\n" + log);

  check("auth config exposed", (await (await fetch(`${BASE}/auth/config`)).json()).enabled === true);
  check("/state 401 without cookie", (await fetch(`${BASE}/state`)).status === 401);
  check("/record/start 401", (await fetch(`${BASE}/record/start`, { method: "POST" })).status === 401);
  check("/files 401", (await fetch(`${BASE}/files/x.md`)).status === 401);
  check("garbage credential rejected", (await fetch(`${BASE}/auth/google`, {
    method: "POST", body: JSON.stringify({ credential: "junk" }),
  })).status >= 400);
  check("forged cookie rejected", (await fetch(`${BASE}/state`, {
    headers: { cookie: "earshot_session=YWJj.9999999999999.forged" },
  })).status === 401);

  const { sessionCookie } = await import("./auth.js"); // same EARSHOT_SECRET via env
  const alice = sessionCookie("alice@example.com", false).split(";")[0];
  const bob = sessionCookie("bob@example.com", false).split(";")[0];
  check("valid cookie accepted", (await fetch(`${BASE}/state`, { headers: { cookie: alice } })).status === 200);

  check("dashboard ws rejected without cookie", (await wsClose(`ws://127.0.0.1:${PORT}`)) === 4401);
  check("capture ws rejected without key", (await wsClose(`ws://127.0.0.1:${PORT}/ingest`)) === 4401);
  check("capture ws rejected with wrong key", (await wsClose(`ws://127.0.0.1:${PORT}/ingest?key=nope`)) === 4401);
  check("capture ws accepted with alice's key", (await wsClose(`ws://127.0.0.1:${PORT}/ingest?key=key-alice`)) === "open");

  // ---- tenant isolation ----
  await fetch(`${BASE}/record/start`, { method: "POST", headers: { cookie: alice } });
  const aliceState = await (await fetch(`${BASE}/state`, { headers: { cookie: alice } })).json();
  const bobState = await (await fetch(`${BASE}/state`, { headers: { cookie: bob } })).json();
  check("alice records", aliceState.recording === true);
  check("bob unaffected by alice's recording", bobState.recording === false);

  // alice's capture feed must reach only alice's dashboard
  const gotLine = { alice: false, bob: false };
  const dash = (cookie, who) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { cookie } });
      ws.on("message", (d) => {
        const m = JSON.parse(d);
        if (m.type === "transcript") gotLine[who] = true;
      });
      ws.on("open", () => resolve(ws));
    });
  const aliceDash = await dash(alice, "alice");
  const bobDash = await dash(bob, "bob");
  const cap = new WebSocket(`ws://127.0.0.1:${PORT}/ingest?key=key-alice`);
  await new Promise((r) => cap.on("open", r));
  cap.send(JSON.stringify({ type: "transcript", source: "them", speaker: "them-1", text: "isolation test line", ts: Date.now() / 1000 }));
  await sleep(800);
  check("alice's dashboard received her line", gotLine.alice === true);
  check("bob's dashboard did NOT receive alice's line", gotLine.bob === false);
  aliceDash.terminate(); bobDash.terminate(); cap.terminate();
  await fetch(`${BASE}/record/stop`, { method: "POST", headers: { cookie: alice } });

  // ---- self-serve settings ----
  const meRes = await fetch(`${BASE}/me`, { headers: { cookie: alice } });
  const meData = await meRes.json();
  check("/me returns identity + capture key", meRes.status === 200 && meData.email === "alice@example.com" && !!meData.captureKey);
  check("/me wsUrl points at ingest", meData.wsUrl.endsWith("/ingest"));
  check("provisioned capture key works", (await wsClose(`ws://127.0.0.1:${PORT}/ingest?key=${meData.captureKey}`)) === "open");
  check("bad claude token rejected", (await fetch(`${BASE}/me/claude-token`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ token: "not-a-token" }),
  })).status === 400);
  const tok = await (await fetch(`${BASE}/me/claude-token`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ token: "sk-ant-oat-ci-test" }),
  })).json();
  check("claude token accepted and connects", tok.ok === true && tok.claudeConnected === true);
  const rot = await (await fetch(`${BASE}/me/capture-key/rotate`, { method: "POST", headers: { cookie: alice } })).json();
  check("rotated key connects", (await wsClose(`ws://127.0.0.1:${PORT}/ingest?key=${rot.captureKey}`)) === "open");
  check("settings are cookie-gated", (await fetch(`${BASE}/me`)).status === 401);

  // files are per-tenant: a file in alice's out dir is invisible to bob
  const fs = await import("node:fs");
  const path = await import("node:path");
  const aliceOut = path.join(import.meta.dirname, "..", "out", "alice-example-com");
  fs.mkdirSync(aliceOut, { recursive: true });
  fs.writeFileSync(path.join(aliceOut, "ci-secret.md"), "alice's eyes only");
  check("alice can download her file", (await fetch(`${BASE}/files/ci-secret.md`, { headers: { cookie: alice } })).status === 200);
  check("bob cannot see alice's file", (await fetch(`${BASE}/files/ci-secret.md`, { headers: { cookie: bob } })).status === 404);
} finally {
  hub.kill();
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nALL HUB AUTH CHECKS PASSED");
