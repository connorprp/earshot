<script setup>
import { ref, computed, onMounted, nextTick } from "vue";
import Bubble from "./components/Bubble.vue";

// vite dev (:5173) talks to a local hub; a built dashboard is served BY the
// hub, so everything is same-origin (and wss behind https)
const DEV = location.port === "5173";
const HTTP_BASE = DEV ? "http://127.0.0.1:7071" : "";
const WS_URL = DEV
  ? "ws://127.0.0.1:7071"
  : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

const needSignIn = ref(false);
const signInError = ref("");
const gsiButton = ref(null);

const showSettings = ref(false);
const pairCode = ref(new URLSearchParams(location.search).get("pair") || "");
const pairHost = ref("");
const pairDone = ref(false);
const pairError = ref("");

async function loadPairInfo() {
  if (!pairCode.value) return;
  const r = await fetch(`${HTTP_BASE}/pair/info?code=${encodeURIComponent(pairCode.value)}`);
  if (r.ok) {
    const info = await r.json();
    pairHost.value = info.host;
    if (info.approved) pairDone.value = true;
  } else {
    pairError.value = "This pairing code has expired — reopen the Earshot app to get a new one.";
  }
}

async function approvePair() {
  const r = await fetch(`${HTTP_BASE}/pair/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pairCode.value }),
  });
  const result = await r.json();
  if (result.ok) {
    pairDone.value = true;
    history.replaceState(null, "", location.pathname); // drop ?pair from the URL
  } else {
    pairError.value = result.message || "Approval failed.";
  }
}

function dismissPair() {
  pairCode.value = "";
  history.replaceState(null, "", location.pathname);
}
const me = ref(null);            // /me payload when the settings panel is open
const captureConnected = ref(true); // optimistic until a status message says otherwise
const claudeConnected = ref(true);
const googleConnected = ref(false);
const asrOk = ref(true); // false = groq mode selected but the server has no GROQ_API_KEY

async function saveAsr(asrMode, asrModel) {
  const body = { asrMode, asrModel: asrModel === undefined ? me.value.asrModel : asrModel };
  const r = await (
    await fetch(`${HTTP_BASE}/me/asr`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();
  if (r.ok) {
    me.value.asrMode = r.asrMode;
    me.value.asrModel = r.asrModel;
    showToast(r.asrMode === "groq" ? "Transcription now runs in the cloud." : "Transcription now runs on your computer.");
  } else {
    showToast(r.message || "Couldn't update transcription settings.");
  }
}

async function openSettings() {
  showSettings.value = true;
  me.value = await (await fetch(`${HTTP_BASE}/me`)).json();
}

async function copyKey() {
  await navigator.clipboard.writeText(me.value.captureKey);
  showToast("Capture key copied.");
}

// one-liner that registers this Earshot account as an MCP server in the
// user's own Claude Code — their Claude can then search their conversations
const mcpCommand = computed(() =>
  me.value
    ? `claude mcp add --transport http earshot ${me.value.mcpUrl}` +
      (me.value.captureKey ? ` --header "Authorization: Bearer ${me.value.captureKey}"` : "")
    : ""
);

async function copyMcp() {
  await navigator.clipboard.writeText(mcpCommand.value);
  showToast("MCP command copied — paste it in any terminal.");
}

async function rotateKey() {
  const r = await (await fetch(`${HTTP_BASE}/me/capture-key/rotate`, { method: "POST" })).json();
  me.value.captureKey = r.captureKey;
  showToast("New capture key generated — update your capture agent.");
}

const connected = ref(false);
const distilling = ref(false);
const closingOut = ref(false);
const recording = ref(false);
const recPending = ref(false);
const tasks = ref([]);           // device-agent tasks (hub "tasks" broadcasts)
const agentAvailable = ref(false); // a capture agent with Claude Code is connected
const bubbles = ref([]);
const stateSpeakers = ref({});
const lines = ref([]);
const toast = ref("");
const flashIds = ref(new Set());
const tickerEl = ref(null);

// voice tag -> display name: primarily state.speakers (distill "speakers" ops),
// plus any Participants-bubble map as fallback. Computed off live state, so
// past ticker lines re-caption the moment the distiller figures out a voice.
const speakerNames = computed(() => {
  const names = {};
  for (const b of bubbles.value) if (b.speakers) Object.assign(names, b.speakers);
  return { ...names, ...stateSpeakers.value };
});

const runningTasks = computed(() => tasks.value.filter((t) => t.status === "running"));

function whoLabel(line) {
  if (line.source === "me") return "You";
  if (!line.speaker) return "Them";
  return speakerNames.value[line.speaker] || `Them ${line.speaker.replace("them-", "")}`;
}

let toastTimer;
function showToast(msg) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 5000);
}

function applyState(state) {
  const prev = new Map(bubbles.value.map((b) => [b.id, b.updatedAt]));
  const flashed = new Set();
  for (const b of state.bubbles) {
    if (!prev.has(b.id) || prev.get(b.id) !== b.updatedAt) flashed.add(b.id);
  }
  flashIds.value = flashed;
  bubbles.value = state.bubbles;
  stateSpeakers.value = state.speakers || {};
  setTimeout(() => (flashIds.value = new Set()), 1300);
}

// ---- Google sign-in (hosted mode; Google handles identity, hub sets a cookie) ----
async function ensureSignedIn() {
  const cfg = await (await fetch(`${HTTP_BASE}/auth/config`)).json();
  if (!cfg.enabled) return true;
  const probe = await fetch(`${HTTP_BASE}/state`);
  if (probe.ok) return true;

  needSignIn.value = true;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  await nextTick();
  window.google.accounts.id.initialize({
    client_id: cfg.clientId,
    callback: async ({ credential }) => {
      const res = await fetch(`${HTTP_BASE}/auth/google`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential }),
      });
      const result = await res.json();
      if (result.ok) {
        needSignIn.value = false;
        connect();
      } else {
        signInError.value = result.message || "Sign-in failed.";
      }
    },
  });
  window.google.accounts.id.renderButton(gsiButton.value, { theme: "filled_black", size: "large" });
  return false;
}

function connect() {
  const ws = new WebSocket(WS_URL);
  ws.onopen = () => (connected.value = true);
  ws.onclose = (e) => {
    connected.value = false;
    if (e.code === 4401) {
      needSignIn.value = true;
      ensureSignedIn();
      return; // no reconnect loop while signed out
    }
    setTimeout(connect, 2000);
  };
  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "state") applyState(msg.state);
    else if (msg.type === "distilling") distilling.value = msg.value;
    else if (msg.type === "recording") recording.value = msg.value;
    else if (msg.type === "status") {
      const hadAgent = captureConnected.value;
      captureConnected.value = msg.captureConnected;
      claudeConnected.value = msg.claudeConnected;
      googleConnected.value = msg.googleConnected;
      agentAvailable.value = Boolean(msg.agentAvailable);
      if (typeof msg.asrOk === "boolean") asrOk.value = msg.asrOk;
      // agent we were waiting on just connected -> begin recording seamlessly
      if (!hadAgent && msg.captureConnected && showStartAgent.value) {
        closeStartAgent();
        showToast("Capture agent connected — recording started.");
        setRecording("start");
      }
    } else if (msg.type === "closeout") closingOut.value = msg.value;
    else if (msg.type === "tasks") tasks.value = msg.tasks;
    else if (msg.type === "task_done")
      showToast(
        msg.ok
          ? `✓ Your Claude finished: ${msg.title}${msg.files?.length ? ` (${msg.files.length} file${msg.files.length > 1 ? "s" : ""} on your device)` : ""}`
          : `Your Claude couldn't finish "${msg.title}": ${(msg.summary || "").slice(0, 140)}`
      );
    else if (msg.type === "report") showToast(`Session report saved: ${msg.report?.title || "untitled"}`);
    else if (msg.type === "transcript") {
      lines.value.push(msg);
      if (lines.value.length > 200) lines.value.shift();
      await nextTick();
      tickerEl.value?.scrollTo({ top: tickerEl.value.scrollHeight });
    }
  };
}

async function setRecording(target) {
  recPending.value = true;
  try {
    if (target === "start") lines.value = []; // fresh ticker for a fresh session
    const res = await fetch(`${HTTP_BASE}/record/${target}`, { method: "POST" });
    const result = await res.json();
    recording.value = result.recording;
  } catch (e) {
    showToast(`Couldn't ${target} recording: ${e.message}`);
  } finally {
    recPending.value = false;
  }
}

async function toggleRecording() {
  const target = recording.value ? "stop" : "start";
  // a recording with no capture agent stays empty — offer to start the app first
  if (target === "start" && !captureConnected.value) {
    showStartAgent.value = true;
    return;
  }
  await setRecording(target);
}

// ---- "start the capture agent" modal (Record pressed with no agent) ----
const showStartAgent = ref(false);
const agentWait = ref(false);
let agentWaitTimer;

function launchAgent() {
  // earshot:// is registered (HKCU) by the app on first run; if it has never
  // run on this computer the navigation is a silent no-op and the modal's
  // download links take over after the wait message.
  agentWait.value = true;
  location.href = "earshot://record";
  clearTimeout(agentWaitTimer);
  agentWaitTimer = setTimeout(() => (agentWait.value = false), 45000);
}

function recordAnyway() {
  showStartAgent.value = false;
  setRecording("start");
}

function closeStartAgent() {
  showStartAgent.value = false;
  agentWait.value = false;
  clearTimeout(agentWaitTimer);
}

async function runAction(bubble, action) {
  action.status = "busy";
  try {
    const res = await fetch(`${HTTP_BASE}/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bubbleId: bubble.id, actionId: action.id }),
    });
    const result = await res.json();
    // agent actions come back "running": the device agent will flip them to
    // done/error via a later state broadcast
    action.status = result.ok ? result.status || "done" : "error";
    showToast(result.message);
    // hosted mode: the artifact downloads and this machine's default app opens it
    if (result.downloadUrl) window.open(`${HTTP_BASE}${result.downloadUrl}`, "_blank");
    // real Google action: open the created event
    if (result.link) window.open(result.link, "_blank");
  } catch (e) {
    action.status = "error";
    showToast(`Action failed: ${e.message}`);
  }
}

async function dismiss(bubble) {
  await fetch(`${HTTP_BASE}/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bubbleId: bubble.id }),
  });
}

onMounted(async () => {
  if (await ensureSignedIn()) {
    connect();
    loadPairInfo();
    if (new URLSearchParams(location.search).get("google") === "connected") {
      showToast("Google connected — calendar context and real actions are live.");
      history.replaceState(null, "", location.pathname);
    }
  }
});
</script>

<template>
  <div class="topbar">
    <div class="status-dot" :class="{ live: connected }"></div>
    <h1>EARSHOT</h1>
    <div class="pulse">
      <div v-if="distilling || closingOut" class="thinking"></div>
      <span>{{
        !connected
          ? "connecting…"
          : distilling
            ? "distilling…"
            : closingOut
              ? "writing session report…"
              : recording
                ? "recording"
                : "idle"
      }}</span>
    </div>
    <div
      v-if="runningTasks.length"
      class="agent-chip"
      :title="runningTasks.map((t) => t.title).join('\n')"
    >
      <span class="agent-spinner"></span>
      <span class="agent-title">your Claude · {{ runningTasks[0].title }}</span>
      <span class="agent-note">{{ runningTasks[0].note }}</span>
      <span v-if="runningTasks.length > 1" class="agent-more">+{{ runningTasks.length - 1 }}</span>
    </div>
    <button
      v-if="connected && !claudeConnected"
      class="warn-chip"
      title="Distilling is offline — the server's EARSHOT_ANTHROPIC_KEY is not set (admin)"
    >
      ⚠ distilling offline
    </button>
    <button
      v-if="connected && !captureConnected"
      class="warn-chip"
      @click="openSettings"
      title="No capture agent is streaming audio for your account"
    >
      ⚠ no capture agent
    </button>
    <button
      v-if="connected && !asrOk"
      class="warn-chip"
      @click="openSettings"
      title="Cloud transcription is selected but the server's GROQ_API_KEY is not set (admin)"
    >
      ⚠ transcription offline
    </button>
    <button
      class="rec-btn"
      :class="{ on: recording }"
      :disabled="!connected || recPending"
      @click="toggleRecording"
    >
      <span class="rec-icon"></span>{{ recording ? "Stop" : "Record" }}
    </button>
    <button class="gear" @click="openSettings" title="Settings">⚙</button>
  </div>

  <TransitionGroup tag="div" name="bubbles" class="grid">
    <Bubble
      v-for="b in bubbles"
      :key="b.id"
      :bubble="b"
      :flash="flashIds.has(b.id)"
      @action="runAction(b, $event)"
      @dismiss="dismiss(b)"
    />
    <div v-if="bubbles.length === 0" key="__empty" class="empty">
      {{
        recording
          ? "Nothing distilled yet — start talking (or play something) and concepts will appear here."
          : "Not recording — press Record to start a session."
      }}
    </div>
  </TransitionGroup>

  <div class="ticker" ref="tickerEl">
    <div v-for="(l, i) in lines" :key="i" class="line">
      <span class="who" :class="l.source">{{ whoLabel(l) }}</span>{{ l.text }}
    </div>
  </div>

  <Transition name="bubbles">
    <div v-if="toast" class="toast">{{ toast }}</div>
  </Transition>

  <div v-if="needSignIn" class="signin-overlay">
    <div class="signin-card">
      <h2>EARSHOT</h2>
      <p>Sign in with your Google account to open your dashboard.</p>
      <div ref="gsiButton"></div>
      <p v-if="signInError" class="signin-error">{{ signInError }}</p>
    </div>
  </div>

  <div v-if="pairCode && !needSignIn" class="signin-overlay">
    <div class="signin-card">
      <h2>Pair this computer?</h2>
      <template v-if="pairDone">
        <p>✅ Done — <b>{{ pairHost }}</b> is connected. You can close this message; the Earshot app on that computer is now capturing for your account.</p>
        <button class="mini" @click="dismissPair">close</button>
      </template>
      <template v-else-if="pairError">
        <p class="signin-error">{{ pairError }}</p>
        <button class="mini" @click="dismissPair">close</button>
      </template>
      <template v-else>
        <p>The Earshot app on <b>{{ pairHost || "a computer" }}</b> wants to capture audio for your account. Only approve if you just opened the app yourself.</p>
        <div class="keyrow">
          <button class="mini dl" @click="approvePair">Allow this computer</button>
          <button class="mini" @click="dismissPair">cancel</button>
        </div>
      </template>
    </div>
  </div>

  <div v-if="showStartAgent" class="signin-overlay" @click.self="closeStartAgent">
    <div class="signin-card">
      <h2>No capture agent</h2>
      <template v-if="agentWait">
        <p>⏳ Starting the Earshot app — recording will begin automatically once it connects…</p>
        <p>Nothing happening after a few seconds? It may not be installed on this computer yet:</p>
        <div class="keyrow">
          <a class="mini dl" :href="`${HTTP_BASE}/installer/app/windows`">⬇ Earshot for Windows</a>
          <a class="mini dl" :href="`${HTTP_BASE}/installer/app/mac`">⬇ Earshot for Mac</a>
        </div>
        <button class="mini" @click="closeStartAgent">cancel</button>
      </template>
      <template v-else>
        <p>
          Nothing is listening on this computer, so a recording would stay empty.
          Start the Earshot app and recording will begin on its own.
        </p>
        <div class="keyrow">
          <button class="mini dl" @click="launchAgent">▶ Start the Earshot app</button>
          <button class="mini" @click="recordAnyway">record anyway</button>
          <button class="mini" @click="closeStartAgent">cancel</button>
        </div>
        <p>
          "Start" works once the app has run on this computer before (Windows).
          On a Mac, open <b>Earshot Capture</b> from Applications.
        </p>
      </template>
    </div>
  </div>

  <div v-if="showSettings" class="signin-overlay" @click.self="showSettings = false">
    <div class="signin-card settings-card">
      <h2>Settings</h2>
      <p v-if="me" class="settings-email">{{ me.email }}</p>

      <div v-if="me" class="settings-block">
        <h3>1 · Capture agent <span :class="captureConnected ? 'ok' : 'bad'">{{ captureConnected ? "connected" : "not connected" }}</span></h3>
        <p>
          Audio is captured by the Earshot app on your computer. Download it, open it,
          and click <b>Allow this computer</b> when this page asks — that's the whole setup.
        </p>
        <div class="keyrow">
          <a class="mini dl" :href="`${HTTP_BASE}/installer/app/windows`">⬇ Earshot for Windows</a>
          <a class="mini dl" :href="`${HTTP_BASE}/installer/app/mac`">⬇ Earshot for Mac</a>
        </div>
        <p>
          Mac only: also install the
          <a href="https://existential.audio/blackhole/" target="_blank">BlackHole 2ch</a> audio
          driver and route sound through it (the app walks you through it).
        </p>
        <details class="advanced">
          <summary>advanced: script installers + manual setup values</summary>
          <div class="keyrow">
            <a class="mini" :href="`${HTTP_BASE}/installer/windows`">script installer (Win)</a>
            <a class="mini" :href="`${HTTP_BASE}/installer/mac`">script installer (Mac)</a>
          </div>
          <label>Server address</label>
          <code>{{ me.wsUrl.replace("/ingest", "").replace(/^wss?:\/\//, "") }}</code>
          <label>Your capture key</label>
          <div class="keyrow">
            <code>{{ me.captureKey }}</code>
            <button class="mini" @click="copyKey">copy</button>
            <button class="mini" @click="rotateKey">new key</button>
          </div>
        </details>
      </div>

      <div v-if="me" class="settings-block">
        <h3>2 · Transcription</h3>
        <p>Where your audio becomes text.</p>
        <div class="keyrow">
          <button
            class="mini"
            :class="{ sel: me.asrMode === 'groq' }"
            :disabled="!me.groqConfigured"
            :title="me.groqConfigured ? 'Segments are transcribed on the server — nothing to download, works on any machine' : 'Not available: the server has no GROQ_API_KEY'"
            @click="saveAsr('groq')"
          >
            In the cloud
          </button>
          <button
            class="mini"
            :class="{ sel: me.asrMode === 'local' }"
            title="Whisper runs on your computer — audio never leaves your machine"
            @click="saveAsr('local')"
          >
            On this computer
          </button>
        </div>
        <p v-if="me.asrMode === 'groq'">
          Nothing to download — the capture app stays tiny and transcription is
          the same quality on every machine.
        </p>
        <template v-else>
          <label>Whisper model (bigger = better quality, larger first-time download)</label>
          <div class="keyrow">
            <select :value="me.asrModel || ''" @change="saveAsr('local', $event.target.value || null)">
              <option value="">device default</option>
              <option v-for="m in me.asrModels" :key="m" :value="m">{{ m }}</option>
            </select>
          </div>
        </template>
      </div>

      <div v-if="me" class="settings-block">
        <h3>3 · Your Claude <span :class="(me.agentAvailable || agentAvailable) ? 'ok' : 'bad'">{{ (me.agentAvailable || agentAvailable) ? "agent ready" : "no agent" }}</span></h3>
        <p>
          Bubble buttons marked as agent tasks (drafting a document, doing research)
          run on <b>your own Claude</b>, on your computer — install
          <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>, sign in
          once, and the Earshot app does the rest. Watch the topbar while a task runs.
        </p>
        <label>Let any Claude of yours search your Earshot conversations (paste in a terminal):</label>
        <div class="keyrow">
          <code>{{ mcpCommand }}</code>
          <button class="mini" @click="copyMcp">copy</button>
        </div>
      </div>

      <div v-if="me?.googleConfigured" class="settings-block">
        <h3>4 · Google <span :class="(me.googleConnected || googleConnected) ? 'ok' : 'bad'">{{ (me.googleConnected || googleConnected) ? "connected" : "not connected" }}</span></h3>
        <p>
          Connect your Google account so Earshot knows which meeting you're in
          (names, attendees, agenda). Calendar and email buttons prefer your own
          Claude agent (using the apps already connected to your Claude); this is
          the fallback when it isn't running:
        </p>
        <div class="keyrow">
          <a class="mini dl" :href="`${HTTP_BASE}/google/connect`">Connect Google</a>
        </div>
      </div>

      <button class="mini close" @click="showSettings = false">close</button>
    </div>
  </div>
</template>
