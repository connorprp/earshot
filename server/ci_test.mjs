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
  GROQ_API_KEY: "ci-groq-key",
  EARSHOT_GROQ_URL: `http://127.0.0.1:${PORT + 1}`, // local stub below, not the real Groq
  EARSHOT_TEST_SEED: "1", // enables POST /test/seed-bubble (bubbles need no LLM in CI)
});
const env = { ...process.env };

// Groq ASR stub: the hub POSTs audio segments here in groq mode
const http = await import("node:http");
let groqCalls = 0;
const groqStub = http
  .createServer((req, res) => {
    groqCalls++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ text: "stubbed groq line" }));
  })
  .listen(PORT + 1);
groqStub.unref();

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

  // ---- asr mode (local vs groq thin capture) ----
  const meAsr = await (await fetch(`${BASE}/me`, { headers: { cookie: alice } })).json();
  check("/me exposes asr fields, groq default when key set",
    meAsr.groqConfigured === true && meAsr.asrMode === "groq" && Array.isArray(meAsr.asrModels));
  check("bad asrMode rejected", (await fetch(`${BASE}/me/asr`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ asrMode: "nope" }),
  })).status === 400);
  check("non-whitelisted model rejected", (await fetch(`${BASE}/me/asr`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ asrMode: "local", asrModel: "../evil" }),
  })).status === 400);
  const setLocal = await (await fetch(`${BASE}/me/asr`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ asrMode: "local", asrModel: "base.en" }),
  })).json();
  check("asr setting accepted and persisted", setLocal.ok === true &&
    (await (await fetch(`${BASE}/me`, { headers: { cookie: alice } })).json()).asrMode === "local");

  // capture agents hear the config: first downlink frame on connect, again on change
  const asrCap = new WebSocket(`ws://127.0.0.1:${PORT}/ingest?key=key-alice`);
  const capMsgs = [];
  asrCap.on("message", (d) => capMsgs.push(JSON.parse(d)));
  await new Promise((r) => asrCap.on("open", r));
  await sleep(500);
  check("config downlink on connect carries stored pref",
    capMsgs[0]?.type === "config" && capMsgs[0].asrMode === "local" && capMsgs[0].asrModel === "base.en");
  await fetch(`${BASE}/me/asr`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ asrMode: "groq" }),
  });
  await sleep(300);
  check("config re-pushed on settings change",
    capMsgs.some((m) => m.type === "config" && m.asrMode === "groq"));

  // audio segment -> stub Groq -> alice's ticker (and back down to the agent), never bob's
  const gotGroqLine = { alice: false, bob: false };
  const dashG = (cookie, who) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { cookie } });
      ws.on("message", (d) => {
        const m = JSON.parse(d);
        if (m.type === "transcript" && m.text === "stubbed groq line") gotGroqLine[who] = true;
      });
      ws.on("open", () => resolve(ws));
    });
  const aliceDashG = await dashG(alice, "alice");
  const bobDashG = await dashG(bob, "bob");
  await fetch(`${BASE}/record/start`, { method: "POST", headers: { cookie: alice } });
  const audioEv = JSON.stringify({
    type: "audio", source: "them", ts: Date.now() / 1000, rate: 16000, format: "wav",
    data: Buffer.alloc(16000).toString("base64"), // stub never parses the WAV
  });
  asrCap.send(audioEv);
  await sleep(800);
  check("groq stub was called for the segment", groqCalls === 1);
  check("groq transcript reached alice's dashboard", gotGroqLine.alice === true);
  check("groq transcript did NOT reach bob", gotGroqLine.bob === false);
  check("groq transcript echoed down to the capture agent",
    capMsgs.some((m) => m.type === "transcript" && m.text === "stubbed groq line"));
  await fetch(`${BASE}/record/stop`, { method: "POST", headers: { cookie: alice } });
  asrCap.send(audioEv);
  await sleep(500);
  check("audio while not recording never reaches groq (spend gate)", groqCalls === 1);
  aliceDashG.terminate(); bobDashG.terminate(); asrCap.terminate();
  // restore groq default for any later sections
  await fetch(`${BASE}/me/asr`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ asrMode: "groq" }),
  });

  // ---- device-agent tasks (agent actions run on the user's own Claude) ----
  const taskCap = new WebSocket(`ws://127.0.0.1:${PORT}/ingest?key=key-alice`);
  const capDown = [];
  taskCap.on("message", (d) => capDown.push(JSON.parse(d)));
  await new Promise((r) => taskCap.on("open", r));
  taskCap.send(JSON.stringify({ type: "caps", claude: true, connectors: ["Gmail", "Google Drive"] }));
  await sleep(300);
  const dashT = [];
  const aliceDashT = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { cookie: alice } });
    ws.on("message", (d) => dashT.push(JSON.parse(d)));
    ws.on("open", () => resolve(ws));
  });
  await sleep(300);
  check("dashboard hears agentAvailable after caps", dashT.some((m) => m.type === "status" && m.agentAvailable === true));
  check("status carries the user's connected apps",
    dashT.some((m) => m.type === "status" && m.agentConnectors?.includes("Gmail")));
  const seedBubble = (cookie, id, title = "John Smith support") =>
    fetch(`${BASE}/test/seed-bubble`, {
      method: "POST", headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        id, title, summary: "counselor referral needed",
        actions: [{ id: "a1", type: "agent", label: "Draft counselor referral", status: "idle",
          payload: { title: "Draft counselor referral", brief: "Write the referral for John." } }],
      }),
    });
  await seedBubble(alice, "b-task");
  const actRes = await (await fetch(`${BASE}/action`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ bubbleId: "b-task", actionId: "a1" }),
  })).json();
  check("agent action dispatches to the device", actRes.ok === true && actRes.status === "running");
  await sleep(300);
  const taskMsg = capDown.find((m) => m.type === "task");
  check("capture agent received task with the brief in the prompt",
    !!taskMsg && taskMsg.prompt.includes("Write the referral for John"));
  const stateRunning = await (await fetch(`${BASE}/state`, { headers: { cookie: alice } })).json();
  check("board shows the action running",
    stateRunning.bubbles.find((b) => b.id === "b-task")?.actions[0].status === "running");
  taskCap.send(JSON.stringify({ type: "task_update", id: taskMsg?.id, note: "using WebSearch" }));
  await sleep(300);
  check("dashboard sees live task progress",
    dashT.some((m) => m.type === "tasks" && m.tasks?.some((t) => t.note === "using WebSearch")));
  taskCap.send(JSON.stringify({ type: "task_done", id: taskMsg?.id, ok: true, summary: "Referral drafted.", files: ["referral.md"] }));
  await sleep(300);
  check("task completion reaches the dashboard", dashT.some((m) => m.type === "task_done" && m.ok === true));
  const stateDone = await (await fetch(`${BASE}/state`, { headers: { cookie: alice } })).json();
  check("action flips to done when the device agent finishes",
    stateDone.bubbles.find((b) => b.id === "b-task")?.actions[0].status === "done");
  // calendar/email actions also PREFER the user's own Claude (their claude.ai
  // connectors) over the hub's Google integration when a capable agent exists
  await fetch(`${BASE}/test/seed-bubble`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({
      id: "b-cal", title: "Sync meeting", summary: "s",
      actions: [{ id: "a1", type: "calendar", label: "Add to calendar", status: "idle",
        payload: { title: "Membership sync", start: "2026-08-20T14:00", durationMinutes: 30 } }],
    }),
  });
  const calRes = await (await fetch(`${BASE}/action`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ bubbleId: "b-cal", actionId: "a1" }),
  })).json();
  check("calendar action routes to the user's own Claude", calRes.ok === true && calRes.status === "running");
  await sleep(300);
  const calTask = capDown.filter((m) => m.type === "task").find((m) => m.prompt.includes("Membership sync"));
  check("calendar task prefers connectors, falls back to .ics",
    !!calTask && calTask.prompt.includes("mcp__claude_ai_Google_Calendar") && calTask.prompt.includes(".ics"));
  check("task prompt names the verified connected apps", !!calTask && calTask.prompt.includes("verified connected: Gmail, Google Drive"));
  // notes (and every other type) route through the user's Claude too
  await fetch(`${BASE}/test/seed-bubble`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({
      id: "b-note", title: "Note routing", summary: "s",
      actions: [{ id: "a1", type: "note", label: "Save as note", status: "idle",
        payload: { title: "Meeting note", markdown: "note body" } }],
    }),
  });
  const noteRes = await (await fetch(`${BASE}/action`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ bubbleId: "b-note", actionId: "a1" }),
  })).json();
  await sleep(300);
  const noteTask = capDown.filter((m) => m.type === "task").find((m) => m.prompt.includes("Meeting note"));
  check("note action routes to the user's own Claude (Notion/Drive mission)",
    noteRes.status === "running" && !!noteTask && noteTask.prompt.includes("Notion"));
  // bob has no Claude-capable agent: same clicks fall back to artifacts
  await seedBubble(bob, "b-task-bob", "Bob fallback test");
  const fb = await (await fetch(`${BASE}/action`, {
    method: "POST", headers: { cookie: bob, "content-type": "application/json" },
    body: JSON.stringify({ bubbleId: "b-task-bob", actionId: "a1" }),
  })).json();
  check("agent action without a device agent falls back to a brief", fb.ok === true && !!fb.downloadUrl);
  await fetch(`${BASE}/test/seed-bubble`, {
    method: "POST", headers: { cookie: bob, "content-type": "application/json" },
    body: JSON.stringify({
      id: "b-email-bob", title: "Email fallback", summary: "s",
      actions: [{ id: "a1", type: "email", label: "Draft email", status: "idle",
        payload: { to: "", subject: "Fallback subject", body: "hello" } }],
    }),
  });
  const fbEmail = await (await fetch(`${BASE}/action`, {
    method: "POST", headers: { cookie: bob, "content-type": "application/json" },
    body: JSON.stringify({ bubbleId: "b-email-bob", actionId: "a1" }),
  })).json();
  check("email action without a device agent falls back to .eml",
    fbEmail.ok === true && (fbEmail.downloadUrl || "").includes(".eml"));
  aliceDashT.terminate(); taskCap.terminate();

  // ---- MCP endpoint (the user's own Claude reads their Earshot data) ----
  const mcpReq = (body, headers = {}) =>
    fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    });
  const initMsg = {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "ci", version: "1" } },
  };
  check("mcp requires auth", (await mcpReq(initMsg)).status === 401);
  check("mcp rejects a bad key", (await mcpReq(initMsg, { authorization: "Bearer nope" })).status === 401);
  const mcpInit = await mcpReq(initMsg, { authorization: "Bearer key-alice" });
  const mcpInitBody = await mcpInit.json();
  check("mcp initialize with capture key", mcpInit.status === 200 && mcpInitBody.result?.serverInfo?.name === "earshot");
  const mcpTools = await (await mcpReq(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { authorization: "Bearer key-alice" }
  )).json();
  const toolNames = (mcpTools.result?.tools || []).map((t) => t.name);
  check("mcp lists the earshot tools",
    ["list_sessions", "get_session", "get_transcript", "search_transcripts", "get_live_board"].every((n) => toolNames.includes(n)));
  const mcpBoard = await (await mcpReq(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_live_board", arguments: {} } },
    { authorization: "Bearer key-alice" }
  )).json();
  check("mcp get_live_board returns alice's board (with her seeded bubble)",
    (mcpBoard.result?.content?.[0]?.text || "").includes("John Smith support"));
  const mcpBoardBob = await (await mcpReq(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_live_board", arguments: {} } },
    { authorization: "Bearer key-bob" }
  )).json();
  check("mcp is tenant-scoped (bob never sees alice's bubbles)",
    !(mcpBoardBob.result?.content?.[0]?.text || "").includes("John Smith support"));

  // ---- google integration routes ----
  check("google connect gated", (await fetch(`${BASE}/google/connect`)).status === 401);
  check("google connect 503 when unconfigured", (await fetch(`${BASE}/google/connect`, { headers: { cookie: alice } })).status === 503);
  check("google callback rejects forged state", (await fetch(`${BASE}/google/callback?code=x&state=forged`)).status === 400);
  const meG = await (await fetch(`${BASE}/me`, { headers: { cookie: alice } })).json();
  check("/me reports google availability", meG.googleConfigured === false && meG.googleConnected === false);

  // ---- device pairing ----
  await fetch(`${BASE}/pair/start`, { method: "POST", body: JSON.stringify({ code: "CITEST99", host: "ci-box" }) });
  const pending = await (await fetch(`${BASE}/pair/claim?code=CITEST99`)).json();
  check("pair pending before approval", pending.status === "pending");
  check("pair approve requires sign-in", (await fetch(`${BASE}/pair/approve`, {
    method: "POST", body: JSON.stringify({ code: "CITEST99" }),
  })).status === 401);
  const appr = await (await fetch(`${BASE}/pair/approve`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ code: "CITEST99" }),
  })).json();
  check("pair approved by signed-in user", appr.ok === true && appr.host === "ci-box");
  const claim = await (await fetch(`${BASE}/pair/claim?code=CITEST99`)).json();
  check("claim hands over key + ws url", claim.status === "approved" && !!claim.captureKey && claim.wsUrl.endsWith("/ingest"));
  check("claimed key actually authenticates", (await wsClose(`ws://127.0.0.1:${PORT}/ingest?key=${claim.captureKey}`)) === "open");
  check("pair code is single-use", (await fetch(`${BASE}/pair/claim?code=CITEST99`)).status === 404);
  check("bad pair codes rejected", (await fetch(`${BASE}/pair/start`, {
    method: "POST", body: JSON.stringify({ code: "x", host: "h" }),
  })).status === 400);

  // ---- personalized installers ----
  check("capture bundle is public", (await fetch(`${BASE}/installer/capture.tgz`)).status === 200);
  check("installer gated without cookie", (await fetch(`${BASE}/installer/windows`)).status === 401);
  const inst = await (await fetch(`${BASE}/installer/windows`, { headers: { cookie: alice } })).text();
  const meNow = await (await fetch(`${BASE}/me`, { headers: { cookie: alice } })).json();
  check("installer has user's key baked in", inst.includes(meNow.captureKey));
  check("installer has no unfilled placeholders", !inst.includes("{{"));
  const instMac = await (await fetch(`${BASE}/installer/mac`, { headers: { cookie: alice } })).text();
  check("mac installer personalized too", instMac.includes(meNow.captureKey) && !instMac.includes("{{"));

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
