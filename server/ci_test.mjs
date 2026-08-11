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
function check(label, cond, detail = "") {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        got: ${detail}`);
  }
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

  // ---- mic-side diarization: two people arriving on ONE channel ----
  // A mic line carrying a voice tag is that PERSON (speakerphone call, someone
  // in the room), not the owner; only an untagged mic line falls back to "Me".
  await fetch(`${BASE}/record/start`, { method: "POST", headers: { cookie: alice } });
  const cap2 = new WebSocket(`ws://127.0.0.1:${PORT}/ingest?key=key-alice`);
  await new Promise((r) => cap2.on("open", r));
  const t0 = Date.now() / 1000;
  cap2.send(JSON.stringify({ type: "transcript", source: "me", speaker: "me", text: "owner talking here", ts: t0 }));
  cap2.send(JSON.stringify({ type: "transcript", source: "me", speaker: "them-1", text: "coworker on speakerphone", ts: t0 + 1 }));
  cap2.send(JSON.stringify({ type: "transcript", source: "me", text: "untagged mic line", ts: t0 + 2 }));
  await sleep(7500); // "me" lines wait out the 6s layer-2 echo hold before landing
  const dia = await (await fetch(`${BASE}/sessions/live/export?format=txt`, { headers: { cookie: alice } })).text();
  check("mic line with a voice tag is that person, not the owner", dia.includes("[them-1] coworker on speakerphone"), dia);
  check("owner's own mic line still reads as Me", dia.includes("[Me] owner talking here"), dia);
  check("untagged mic line falls back to the channel (Me)", dia.includes("[Me] untagged mic line"), dia);
  cap2.terminate();
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
  // the send sheet: preview the exact prompt, then send with the user's own
  // instructions folded into it
  const prev = await (await fetch(`${BASE}/action/preview`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ bubbleId: "b-note", actionId: "a1", notes: "keep it to three bullets" }),
  })).json();
  check("action preview returns the agent-bound prompt",
    prev.ok === true && prev.route === "agent" && prev.prompt.includes("Meeting note"));
  check("preview shows the user's instructions in the prompt",
    prev.prompt.includes("keep it to three bullets") && prev.prompt.includes("The user's own instructions"));
  check("preview 404s for an unknown action",
    (await fetch(`${BASE}/action/preview`, {
      method: "POST", headers: { cookie: alice, "content-type": "application/json" },
      body: JSON.stringify({ bubbleId: "b-note", actionId: "nope" }),
    })).status === 404);
  await fetch(`${BASE}/action`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ bubbleId: "b-note", actionId: "a1", notes: "keep it to three bullets" }),
  });
  await sleep(300);
  const notesTask = capDown.filter((m) => m.type === "task").reverse()
    .find((m) => m.prompt.includes("Meeting note"));
  check("typed instructions reach the device agent's prompt",
    !!notesTask && notesTask.prompt.includes("keep it to three bullets"));
  const noted = await (await fetch(`${BASE}/state`, { headers: { cookie: alice } })).json();
  check("instructions are recorded on the action",
    noted.bubbles.find((b) => b.id === "b-note")?.actions[0].userNotes === "keep it to three bullets");
  const notedMd = await (await fetch(`${BASE}/sessions/live/export?format=md`, { headers: { cookie: alice } })).text();
  check("recorded instructions land in the export",
    notedMd.includes("You asked (Save as note): keep it to three bullets"));
  // the sheet pre-fills with the last note, so re-running with a cleared box
  // has to mean "no instructions this time"
  await fetch(`${BASE}/action`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ bubbleId: "b-note", actionId: "a1", notes: "" }),
  });
  const cleared = await (await fetch(`${BASE}/state`, { headers: { cookie: alice } })).json();
  check("re-running with an empty box clears the recorded instructions",
    cleared.bubbles.find((b) => b.id === "b-note")?.actions[0].userNotes === "");
  // ---- the action's Claude session (thread): stream, resume, stop ----
  // its own bubble: clicking an action twice starts two runs, and this block
  // needs to know exactly which conversation it is talking about
  await fetch(`${BASE}/test/seed-bubble`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({
      id: "b-thread", title: "Thread test", summary: "s",
      actions: [{ id: "a1", type: "agent", label: "Do the thing", status: "idle",
        payload: { title: "Threaded work order", brief: "Do the thing." } }],
    }),
  });
  await fetch(`${BASE}/action`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ bubbleId: "b-thread", actionId: "a1", notes: "keep it to three bullets" }),
  });
  await sleep(300);
  const threadTask = capDown.filter((m) => m.type === "task").at(-1);
  check("a dispatched task carries the thread it belongs to",
    !!threadTask?.threadId && threadTask.resume === null &&
    threadTask.prompt.includes("Threaded work order"));
  const tid = threadTask.id, thId = threadTask.threadId;
  taskCap.send(JSON.stringify({ type: "task_session", id: tid, threadId: thId, sessionId: "claude-sess-1" }));
  taskCap.send(JSON.stringify({ type: "task_stream", id: tid, threadId: thId, items: [
    { kind: "text", text: "Looking at the concept now." },
    { kind: "tool", name: "mcp__claude_ai_Notion__create_page", text: "Meeting note" },
    { kind: "tool_result", text: "page created", ok: true },
  ] }));
  await sleep(300);
  check("the session streams to open dashboards",
    dashT.some((m) => m.type === "thread" && m.threadId === thId &&
      m.messages.some((x) => x.role === "assistant" && x.text.includes("Looking at the concept"))));
  const th1 = await (await fetch(
    `${BASE}/thread?bubbleId=b-thread&actionId=a1`, { headers: { cookie: alice } })).json();
  check("the thread holds the whole conversation, in order",
    th1.thread?.messages.map((m) => m.role).join(",") === "user,assistant,tool,tool_result" &&
    th1.thread.messages[0].text === "keep it to three bullets",
    JSON.stringify(th1.thread?.messages?.map((m) => [m.role, (m.text || "").slice(0, 30)])));
  check("the thread is anchored to its concept",
    th1.thread.bubbleId === "b-thread" && th1.thread.actionId === "a1" && th1.running === true,
    `${th1.thread.bubbleId}/${th1.thread.actionId} running=${th1.running}`);
  check("a reply is refused while the agent is still working",
    (await (await fetch(`${BASE}/thread/reply`, {
      method: "POST", headers: { cookie: alice, "content-type": "application/json" },
      body: JSON.stringify({ threadId: thId, text: "hi" }),
    })).json()).ok === false);
  taskCap.send(JSON.stringify({
    type: "task_done", id: tid, ok: true, summary: "Note saved.", files: ["note.md", "brief.docx"],
    links: [
      { label: "Open the brief", file: "brief.docx" },
      { label: "Open the Gmail draft", url: "https://mail.google.com/mail/u/0/#drafts?compose=abc" },
      { label: "Nonsense", url: "javascript:alert(1)" }, // neither url nor file survives
      { label: "Empty" },
    ],
  }));
  await sleep(300);
  const th2 = await (await fetch(
    `${BASE}/thread?bubbleId=b-thread&actionId=a1`, { headers: { cookie: alice } })).json();
  check("the result lands in the thread and the session becomes resumable",
    th2.thread.messages.at(-1).role === "result" && th2.thread.claudeSessionId === "claude-sess-1" &&
    th2.running === false);
  // what the agent made comes back as things the user can open
  const done = th2.thread.messages.at(-1);
  check("the result carries openable deliverables",
    done.links?.length === 2 && done.links[0].file === "brief.docx" &&
    done.links[1].url.startsWith("https://mail.google.com"),
    JSON.stringify(done.links));
  check("a link with no usable target is dropped",
    !done.links.some((l) => l.label === "Nonsense" || l.label === "Empty"));
  check("the dashboard hears the deliverables on task_done",
    dashT.some((m) => m.type === "task_done" && m.links?.some((l) => l.file === "brief.docx")));
  const openRes = await (await fetch(`${BASE}/thread/open`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ threadId: thId, file: "brief.docx" }),
  })).json();
  await sleep(200);
  check("opening a deliverable asks the device that holds it",
    openRes.ok === true && capDown.some((m) => m.type === "open" && m.file === "brief.docx" && m.threadId === thId));
  await fetch(`${BASE}/thread/open`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ threadId: thId, file: "../../etc/passwd" }),
  });
  await sleep(200);
  check("a path never reaches the device — only a bare name",
    capDown.filter((m) => m.type === "open").every((m) => !m.file.includes("/") && !m.file.includes("\\")));
  check("opening an unknown thread 404s",
    (await fetch(`${BASE}/thread/open`, {
      method: "POST", headers: { cookie: alice, "content-type": "application/json" },
      body: JSON.stringify({ threadId: "th-nope", file: "x.docx" }),
    })).status === 404);
  check("bob cannot open alice's deliverables",
    (await fetch(`${BASE}/thread/open`, {
      method: "POST", headers: { cookie: bob, "content-type": "application/json" },
      body: JSON.stringify({ threadId: thId, file: "brief.docx" }),
    })).status === 404);
  check("an empty reply is refused",
    (await (await fetch(`${BASE}/thread/reply`, {
      method: "POST", headers: { cookie: alice, "content-type": "application/json" },
      body: JSON.stringify({ threadId: thId, text: "   " }),
    })).json()).ok === false);
  const replyRes = await (await fetch(`${BASE}/thread/reply`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ threadId: thId, text: "also mention the deadline" }),
  })).json();
  await sleep(300);
  const followUp = capDown.filter((m) => m.type === "task").at(-1);
  check("a follow-up resumes the same Claude session, carrying only the new turn",
    replyRes.ok === true && followUp.resume === "claude-sess-1" &&
    followUp.prompt === "also mention the deadline" && followUp.threadId === thId);
  // stopping: the kill request goes to the device, the button frees up again
  const cancelRes = await (await fetch(`${BASE}/thread/cancel`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ threadId: thId }),
  })).json();
  await sleep(300);
  check("stop asks the device agent to kill the task",
    cancelRes.ok === true && capDown.some((m) => m.type === "task_cancel" && m.id === followUp.id));
  const afterCancel = await (await fetch(`${BASE}/state`, { headers: { cookie: alice } })).json();
  check("a stopped action goes back to clickable, not done",
    afterCancel.bubbles.find((b) => b.id === "b-thread")?.actions[0].status === "idle");
  const th3 = await (await fetch(
    `${BASE}/thread?bubbleId=b-thread&actionId=a1`, { headers: { cookie: alice } })).json();
  check("the stop is recorded in the conversation",
    th3.thread.messages.at(-1).role === "system" && th3.running === false);
  check("a late task_done from the killed process is ignored",
    (() => {
      taskCap.send(JSON.stringify({ type: "task_done", id: followUp.id, ok: true, summary: "too late" }));
      return true;
    })());
  await sleep(200);
  const th4 = await (await fetch(
    `${BASE}/thread?bubbleId=b-thread&actionId=a1`, { headers: { cookie: alice } })).json();
  check("...so the stopped conversation keeps its ending",
    th4.thread.messages.at(-1).role === "system");
  check("threads are tenant-scoped",
    (await (await fetch(`${BASE}/thread?bubbleId=b-thread&actionId=a1`,
      { headers: { cookie: bob } })).json()).thread === null);
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
    body: JSON.stringify({ bubbleId: "b-email-bob", actionId: "a1", notes: "mention the Tuesday deadline" }),
  })).json();
  check("email action without a device agent falls back to .eml",
    fbEmail.ok === true && (fbEmail.downloadUrl || "").includes(".eml"));
  // no agent = no model to read instructions, so they ride into the artifact
  const eml = await (await fetch(`${BASE}${fbEmail.downloadUrl}`, { headers: { cookie: bob } })).text();
  check("instructions land in the artifact when there's no agent",
    eml.includes("mention the Tuesday deadline"));
  const bobBoard = await (await fetch(`${BASE}/state`, { headers: { cookie: bob } })).json();
  check("the stored bubble keeps the model's original payload",
    bobBoard.bubbles.find((b) => b.id === "b-email-bob")?.actions[0].payload.body === "hello");
  // ---- "✦ Ask Claude": free-form direction, and live edits to the notes ----
  // The general-purpose channel: not one of the model's buttons, and able to
  // rewrite the board through the earshot MCP write tools.
  // (the previous section's agent goes first: whichever capable socket connected
  // earliest receives the tasks, and this block needs to read them)
  aliceDashT.terminate(); taskCap.terminate();
  await sleep(300);
  const mcpCall = (name, args, headers = {}) =>
    fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer key-alice",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 90, method: "tools/call", params: { name, arguments: args } }),
    })
      .then((r) => r.json())
      .then((r) => r.result?.content?.[0]?.text || "");

  await fetch(`${BASE}/test/seed-bubble`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({
      id: "b-ask", kind: "discussion", title: "Vendor pricing", summary: "they quoted something",
      details: ["quote unclear"],
      actions: [{ id: "a1", type: "note", label: "Save as note", status: "done", userNotes: "cc dana",
        payload: { title: "n", markdown: "m" } }],
    }),
  });
  check("ask is refused with nothing typed",
    (await (await fetch(`${BASE}/ask`, {
      method: "POST", headers: { cookie: alice, "content-type": "application/json" },
      body: JSON.stringify({ text: "  " }),
    })).json()).ok === false);
  const askCap = new WebSocket(`ws://127.0.0.1:${PORT}/ingest?key=key-alice`);
  const askDown = [];
  askCap.on("message", (d) => askDown.push(JSON.parse(d)));
  await new Promise((r) => askCap.on("open", r));
  askCap.send(JSON.stringify({ type: "caps", claude: true, connectors: ["Gmail"] }));
  await sleep(300);
  const askDash = [];
  const askDashWs = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { cookie: alice } });
    ws.on("message", (d) => askDash.push(JSON.parse(d)));
    ws.on("open", () => resolve(ws));
  });
  const askRes = await (await fetch(`${BASE}/ask`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ bubbleId: "b-ask", text: "them-2 is Dave Ramirez, and retitle this to Dave's quote" }),
  })).json();
  await sleep(300);
  const askTask = askDown.filter((m) => m.type === "task").at(-1);
  check("ask dispatches a conversation to the user's own Claude",
    askRes.ok === true && askRes.status === "running" && !!askRes.threadId && askTask?.threadId === askRes.threadId);
  check("the ask prompt carries the user's words, the concept, and the board with ids",
    askTask.prompt.includes("them-2 is Dave Ramirez") &&
    askTask.prompt.includes('id "b-ask"') && askTask.prompt.includes('"id": "b-ask"'),
    askTask.prompt.slice(0, 400));
  check("the ask prompt tells the agent how to edit the notes, and that edits stick",
    askTask.prompt.includes("edit_notes") && askTask.prompt.includes("name_speakers") &&
    askTask.prompt.includes("AUTHORITATIVE"));
  check("an ask thread is anchored to its concept and reopens",
    (await (await fetch(`${BASE}/thread?bubbleId=b-ask&actionId=__ask`,
      { headers: { cookie: alice } })).json()).thread?.messages?.[0]?.text.includes("Dave Ramirez"));
  const askedBoard = await (await fetch(`${BASE}/state`, { headers: { cookie: alice } })).json();
  check("the concept remembers its conversation (💬 on the button)",
    !!askedBoard.bubbles.find((b) => b.id === "b-ask")?.askThreadId);
  // board-wide ask: same machinery, no concept
  await fetch(`${BASE}/ask`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ text: "nobody named Sarah was here" }),
  });
  await sleep(300);
  const boardAsk = askDown.filter((m) => m.type === "task").at(-1);
  check("a board-wide ask carries the whole board and no single concept",
    boardAsk.prompt.includes("nobody named Sarah") && !boardAsk.prompt.includes("They asked it from this concept"));
  check("ask 404s for a concept that isn't on the board",
    (await fetch(`${BASE}/ask`, {
      method: "POST", headers: { cookie: alice, "content-type": "application/json" },
      body: JSON.stringify({ bubbleId: "nope", text: "fix this" }),
    })).status === 404);

  // the write tools: what the agent calls, attributed to its thread
  const askThread = askRes.threadId;
  const edited = await mcpCall(
    "edit_notes",
    { ops: [{ op: "update", id: "b-ask", bubble: { title: "Dave's quote", summary: "Dave quoted $4k for the rebuild.", details: ["$4k", "two weeks"] } }] },
    { "x-earshot-thread": askThread }
  );
  await sleep(300);
  const afterEdit = await (await fetch(`${BASE}/state`, { headers: { cookie: alice } })).json();
  const edb = afterEdit.bubbles.find((b) => b.id === "b-ask");
  check("edit_notes rewrites the live card", edb?.title === "Dave's quote" && edb.details.length === 2, JSON.stringify(edb));
  check("an edited card is flagged as the user's own", edb?.userEdited === true);
  check("the edit keeps what the user did with the buttons",
    edb?.actions[0].status === "done" && edb.actions[0].userNotes === "cc dana");
  check("the tool tells the agent what changed and hands back the board",
    edited.includes("updated “Dave's quote”") && edited.includes('"concepts"'), edited.slice(0, 200));
  check("every open dashboard sees the edit immediately",
    askDash.some((m) => m.type === "state" && m.state.bubbles.some((b) => b.title === "Dave's quote")));
  check("the edit is narrated inside the conversation the user asked from",
    askDash.some((m) => m.type === "thread" && m.threadId === askThread &&
      m.messages.some((x) => x.role === "system" && x.text.startsWith("✎"))));
  const named = await mcpCall("name_speakers", { map: { "them-2": "Dave Ramirez", me: "nope" } }, { "x-earshot-thread": askThread });
  const afterName = await (await fetch(`${BASE}/state`, { headers: { cookie: alice } })).json();
  check("name_speakers names and pins the voice",
    afterName.speakers["them-2"] === "Dave Ramirez" && afterName.speakerPins.includes("them-2"));
  check("naming refuses 'me' (the owner is elected by voice, not typed)",
    !afterName.speakers.me && named.includes("isn't a nameable voice tag"));
  const noted2 = await mcpCall("add_note", { text: "Dave is the vendor, not staff" }, { "x-earshot-thread": askThread });
  const afterNote = await (await fetch(`${BASE}/state`, { headers: { cookie: alice } })).json();
  check("add_note pins a standing correction",
    afterNote.notes?.[0]?.text === "Dave is the vendor, not staff" && noted2.includes("pinned a note"));
  check("pinned notes are part of the export",
    (await (await fetch(`${BASE}/sessions/live/export?format=md`, { headers: { cookie: alice } })).text())
      .includes("Dave is the vendor, not staff"));
  const badEdit = await mcpCall("edit_notes", { ops: [{ op: "update", id: "ghost", bubble: { title: "x" } }] });
  check("editing a concept that doesn't exist explains itself instead of failing",
    badEdit.includes('no concept with id "ghost"'));
  const addRes = await mcpCall("edit_notes", { ops: [{ op: "add", bubble: { kind: "task", title: "Chase the quote", summary: "Ask Dave for it in writing." } }] });
  const afterAdd = await (await fetch(`${BASE}/state`, { headers: { cookie: alice } })).json();
  check("edit_notes can add a card the distiller never made",
    afterAdd.bubbles.some((b) => b.id === "chase-the-quote" && b.kind === "task"), addRes.slice(0, 120));
  await mcpCall("edit_notes", { ops: [{ op: "remove", id: "chase-the-quote" }] });
  check("...and remove one",
    !(await (await fetch(`${BASE}/state`, { headers: { cookie: alice } })).json()).bubbles.some((b) => b.id === "chase-the-quote"));
  // by hand, with no agent involved
  const handNote = await (await fetch(`${BASE}/board/note`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ text: "the Q4 launch is off" }),
  })).json();
  check("a note can be pinned by hand too", handNote.ok === true && handNote.notes.length === 2);
  const unpinned = await (await fetch(`${BASE}/board/note`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ index: 0 }),
  })).json();
  check("and unpinned", unpinned.ok === true && unpinned.notes.length === 1 &&
    unpinned.notes[0].text === "the Q4 launch is off");
  check("the write tools are tenant-scoped (bob's Claude can't touch alice's board)",
    !(await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer key-bob" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 91, method: "tools/call", params: { name: "edit_notes", arguments: { ops: [{ op: "remove", id: "b-ask" }] } } }),
    }).then((r) => r.json()).then((r) => r.result?.content?.[0]?.text || "")).includes("removed") &&
    (await (await fetch(`${BASE}/state`, { headers: { cookie: alice } })).json()).bubbles.some((b) => b.id === "b-ask"));
  askDashWs.terminate(); askCap.terminate();

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
  check("mcp lists the earshot read tools",
    ["list_sessions", "get_session", "get_transcript", "search_transcripts", "get_live_board"].every((n) => toolNames.includes(n)));
  check("mcp lists the write tools that let a Claude edit the notes",
    ["edit_notes", "name_speakers", "add_note", "remove_note"].every((n) => toolNames.includes(n)));
  const mcpBoard = await (await mcpReq(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_live_board", arguments: {} } },
    { authorization: "Bearer key-alice" }
  )).json();
  const boardText = mcpBoard.result?.content?.[0]?.text || "";
  check("mcp get_live_board returns alice's board (with her seeded bubble)",
    boardText.includes("John Smith support"));
  // an agent that can't name a concept can't edit one
  check("get_live_board reports concept ids and the user's pinned notes",
    boardText.includes('"id": "b-task"') && boardText.includes("yourNotes"), boardText.slice(0, 160));
  const mcpBoardBob = await (await mcpReq(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_live_board", arguments: {} } },
    { authorization: "Bearer key-bob" }
  )).json();
  check("mcp is tenant-scoped (bob never sees alice's bubbles)",
    !(mcpBoardBob.result?.content?.[0]?.text || "").includes("John Smith support"));

  // ---- session archive: searchable list + export ----
  // Mongo is down in CI, so the archive itself is empty; what must still work
  // is the envelope, the LIVE board view, and every export format.
  check("sessions list gated", (await fetch(`${BASE}/sessions`)).status === 401);
  const sessList = await (await fetch(`${BASE}/sessions?q=pricing&limit=5`, { headers: { cookie: alice } })).json();
  check("sessions list returns the archive envelope",
    Array.isArray(sessList.sessions) && "boardSessionId" in sessList && "recording" in sessList);
  check("session export gated", (await fetch(`${BASE}/sessions/live/export`)).status === 401);
  const liveView = await (await fetch(`${BASE}/sessions/live`, { headers: { cookie: alice } })).json();
  check("live session view returns board + transcript",
    liveView.bubbles?.some((b) => b.id === "b-task") && Array.isArray(liveView.transcript));
  const expRes = await fetch(`${BASE}/sessions/live/export?format=md`, { headers: { cookie: alice } });
  const expMd = await expRes.text();
  check("export comes back as a markdown download",
    expRes.status === 200 && /attachment; filename=".+\.md"/.test(expRes.headers.get("content-disposition") || ""));
  check("markdown export carries concepts + transcript",
    expMd.includes("John Smith support") && expMd.includes("## Transcript"));
  const expJson = await (await fetch(`${BASE}/sessions/live/export?format=json`, { headers: { cookie: alice } })).json();
  check("json export carries bubbles + transcript arrays",
    Array.isArray(expJson.transcript) && expJson.bubbles?.some((b) => b.title === "John Smith support"));
  const expTxt = await (await fetch(`${BASE}/sessions/live/export?format=txt`, { headers: { cookie: alice } })).text();
  check("txt export is the speaker-labeled transcript", /\[(Me|Them|them-\d+)\]/.test(expTxt));
  const expBob = await (await fetch(`${BASE}/sessions/live/export?format=md`, { headers: { cookie: bob } })).text();
  check("export is tenant-scoped (bob's export has no alice concepts)",
    expBob.includes("Bob fallback test") && !expBob.includes("John Smith support"));
  // archived-session actions: the bubble is looked up in Mongo, so with Mongo
  // down the click must 404 cleanly (the real path is verified against a live
  // cluster — see HANDOFF). sessionId "live" must behave like no sessionId.
  check("action on a nonexistent archived session 404s",
    (await fetch(`${BASE}/action`, {
      method: "POST", headers: { cookie: alice, "content-type": "application/json" },
      body: JSON.stringify({ bubbleId: "b-task", actionId: "a1", sessionId: "64b7f0000000000000000000" }),
    })).status === 404);
  check("action with a garbage sessionId 404s rather than 500s",
    (await fetch(`${BASE}/action`, {
      method: "POST", headers: { cookie: alice, "content-type": "application/json" },
      body: JSON.stringify({ bubbleId: "b-task", actionId: "a1", sessionId: "not-an-id" }),
    })).status === 404);
  const liveIdAct = await (await fetch(`${BASE}/action`, {
    method: "POST", headers: { cookie: alice, "content-type": "application/json" },
    body: JSON.stringify({ bubbleId: "b-task", actionId: "a1", sessionId: "live" }),
  })).json();
  check("sessionId 'live' routes to the board's bubble", liveIdAct.ok === true);
  check("unknown session id 404s",
    (await fetch(`${BASE}/sessions/64b7f0000000000000000000`, { headers: { cookie: alice } })).status === 404);
  check("garbage session id 404s rather than 500s",
    (await fetch(`${BASE}/sessions/not-an-id`, { headers: { cookie: alice } })).status === 404);

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

  // ---- duplicate capture agents (the 4x-transcript bug) ----
  // Two agents on one account hear the same mic; only the first to speak owns
  // the stream, so a line must be ingested ONCE no matter how many are running.
  await fetch(`${BASE}/record/start`, { method: "POST", headers: { cookie: alice } }); // lines are gated on recording
  const dupA = new WebSocket(`ws://127.0.0.1:${PORT}/ingest?key=key-alice`);
  const dupB = new WebSocket(`ws://127.0.0.1:${PORT}/ingest?key=key-alice`);
  await Promise.all([dupA, dupB].map((w) => new Promise((r) => w.on("open", r))));
  const dupDash = [];
  const dupWs = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, { headers: { cookie: alice } });
    ws.on("message", (d) => dupDash.push(JSON.parse(d)));
    ws.on("open", () => resolve(ws));
  });
  await sleep(200);
  check("status reports how many capture agents are connected",
    dupDash.some((m) => m.type === "status" && m.captureAgents >= 2));
  const dupLine = (ws, text) =>
    ws.send(JSON.stringify({ type: "transcript", source: "them", text, ts: Date.now() / 1000 }));
  dupLine(dupA, "the quarterly numbers land on friday");
  await sleep(120);
  dupLine(dupB, "the quarterly numbers land on friday"); // same speech, second agent
  dupLine(dupB, "the quarterly numbers land on friday.");
  await sleep(400);
  const dupSeen = dupDash.filter((m) => m.type === "transcript" && m.text.startsWith("the quarterly numbers"));
  check("a line from two agents is ingested once", dupSeen.length === 1, `got ${dupSeen.length}`);
  check("the hub logged the duplicate agent", log.includes("duplicate capture agent streaming"));
  // ownership must survive the owner going quiet mid-conversation, then pass on close
  dupA.close();
  await sleep(300);
  dupLine(dupB, "and the board meeting moves to tuesday");
  await sleep(400);
  check("the remaining agent takes over when the owner disconnects",
    dupDash.some((m) => m.type === "transcript" && m.text.startsWith("and the board meeting")));
  dupB.close(); dupWs.terminate();
  await sleep(200);
  // deliberately left recording: Stop would flush a distill against the fake CI
  // Claude token and sit in SDK retries for minutes
} finally {
  hub.kill();
}

// pure-function check: a distill update rewrites a bubble's whole actions
// array, and must not erase what the USER did with those buttons
{
  const { applyOps } = await import("./distill.js");
  const state = {
    bubbles: [
      {
        id: "b1", title: "t", createdAt: 1,
        actions: [
          { id: "a0", type: "email", label: "Draft email", status: "done", userNotes: "cc dana" },
          { id: "a1", type: "note", label: "Save a note", status: "idle" },
        ],
      },
    ],
  };
  applyOps(state, [
    { op: "update", id: "b1", bubble: { summary: "new", actions: [
      { id: "a0", type: "email", label: "Draft email" },
      { id: "a1", type: "calendar", label: "Book the follow-up" }, // a DIFFERENT action reusing a1
    ] } },
  ]);
  const [a0, a1] = state.bubbles[0].actions;
  check("a distill update keeps the user's instructions on the same action",
    a0.userNotes === "cc dana" && a0.status === "done");
  check("history is not carried onto a replaced action", !a1.userNotes && a1.status === "idle");
}

// pure-function checks: the user's own edits outrank the distiller
{
  const { applyOps } = await import("./distill.js");
  const { applyEditOps, notesBlock } = await import("./boardedit.js");

  // a voice the user named cannot be renamed by a later automatic pass
  const pinned = { bubbles: [], speakers: {}, speakerPins: [], notes: [] };
  applyEditOps(pinned, [{ op: "speakers", map: { "them-2": "Dave Ramirez" } }]);
  applyOps(pinned, [{ op: "speakers", map: { "them-2": "Doug?", "them-3": "Sarah" } }]);
  check("a distill cannot rename a voice the user pinned",
    pinned.speakers["them-2"] === "Dave Ramirez" && pinned.speakers["them-3"] === "Sarah");

  // an edit only writes the fields it was given, and only writable ones
  const state = {
    bubbles: [{ id: "b1", kind: "task", title: "old", summary: "s", details: ["a"], createdAt: 1, actions: [] }],
    speakers: {}, speakerPins: [], notes: [],
  };
  const res = applyEditOps(state, [
    { op: "update", id: "b1", bubble: { title: "new title", removed: true, id: "hijacked", kind: "nonsense" } },
  ]);
  const b = state.bubbles[0];
  check("an edit replaces only the fields it was handed",
    b.title === "new title" && b.summary === "s" && b.details[0] === "a");
  check("an edit cannot write the hub's own bookkeeping",
    b.id === "b1" && b.removed === undefined && b.kind === "discussion" && b.userEdited === true);
  check("the edit reports itself in words the user can read",
    res.summary[0] === "updated “new title” (kind, title)", res.summary.join("|"));

  // an unknown op is reported, not silently swallowed
  const bad = applyEditOps({ bubbles: [], speakers: {}, speakerPins: [], notes: [] }, [{ op: "drop-table" }]);
  check("an unknown op comes back as an error", bad.changed === false && bad.errors.length === 1);

  check("the notes block tells the distiller who is in charge",
    notesBlock([{ text: "Dave is the vendor" }]).includes("AUTHORITATIVE"));
  check("no notes = no block (nothing wasted in the prompt)", notesBlock([]) === "");
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nALL HUB AUTH CHECKS PASSED");
