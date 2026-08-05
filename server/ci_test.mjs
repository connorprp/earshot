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
  EARSHOT_CAPTURE_KEY: "ci-capture-key",
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
  const cookie = sessionCookie("ci@example.com", false).split(";")[0];
  check("valid cookie accepted", (await fetch(`${BASE}/state`, { headers: { cookie } })).status === 200);

  check("dashboard ws rejected without cookie", (await wsClose(`ws://127.0.0.1:${PORT}`)) === 4401);
  check("capture ws rejected without key", (await wsClose(`ws://127.0.0.1:${PORT}/ingest`)) === 4401);
  check("capture ws accepted with key", (await wsClose(`ws://127.0.0.1:${PORT}/ingest?key=ci-capture-key`)) === "open");
} finally {
  hub.kill();
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nALL HUB AUTH CHECKS PASSED");
