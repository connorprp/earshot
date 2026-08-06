<script setup>
import { ref, computed, onMounted, nextTick, watch } from "vue";
import Bubble from "./components/Bubble.vue";
import ActionSheet from "./components/ActionSheet.vue";

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
const captureAgents = ref(0);       // >1 = duplicate agents on the account (extras muted by the hub)
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
const agentConnectors = ref([]);   // apps connected to the user's own Claude
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

// ---- session archive: searchable sidebar + export ----
// viewing === null means the live board; otherwise it holds a loaded past
// session ({session, transcript, bubbles}) and the board renders THAT, while
// live ws updates keep flowing into the live refs behind it.
const NARROW = 720; // below this the sidebar overlays the board instead of splitting it
const sidebarOpen = ref(window.innerWidth > NARROW);
const sessions = ref([]);
const sessionSearch = ref("");
const sessionsLoading = ref(false);
const boardSessionId = ref(null); // the session the live board belongs to
const viewing = ref(null);
const viewLoading = ref(false);
const showDismissed = ref(false);
const showExport = ref(false);
const tickerTall = ref(false); // a past session is read, not glanced at — its transcript gets room

async function loadSessions() {
  sessionsLoading.value = true;
  try {
    const q = sessionSearch.value.trim();
    const res = await fetch(`${HTTP_BASE}/sessions?limit=60${q ? `&q=${encodeURIComponent(q)}` : ""}`);
    if (!res.ok) return;
    const data = await res.json();
    sessions.value = data.sessions || [];
    boardSessionId.value = data.boardSessionId || null;
  } catch {
    /* hub unreachable: keep the list we already have */
  } finally {
    sessionsLoading.value = false;
  }
}

let searchTimer;
watch(sessionSearch, () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadSessions, 250);
});

function sessionTitle(s) {
  if (!s) return "Session";
  return (
    s.report?.title ||
    s.calendarEvent?.title ||
    (s.startedAt ? `${new Date(s.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} session` : "Untitled session")
  );
}

function timeLabel(iso) {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
}

function fullStamp(iso) {
  return iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
}

function dayLabel(iso) {
  if (!iso) return "Undated";
  const d = new Date(iso);
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(new Date()) - midnight(d)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

function durationLabel(s) {
  const end = s.endedAt || s.lastActivityAt;
  if (!s.startedAt || !end) return "";
  const min = Math.max(1, Math.round((new Date(end) - new Date(s.startedAt)) / 60000));
  return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
}

const groupedSessions = computed(() => {
  const groups = [];
  for (const s of sessions.value) {
    const label = dayLabel(s.startedAt);
    if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(s);
  }
  return groups;
});

async function openSession(s) {
  if (s.id && s.id === boardSessionId.value) return backToLive(); // that session IS the board
  viewLoading.value = true;
  try {
    const res = await fetch(`${HTTP_BASE}/sessions/${s.id}`);
    if (!res.ok) return showToast("Couldn't open that session.");
    const data = await res.json();
    viewing.value = { id: s.id, meta: s, ...data };
    showDismissed.value = false;
    tickerTall.value = true;
    if (window.innerWidth <= NARROW) sidebarOpen.value = false; // get out of the board's way
    await nextTick();
    tickerEl.value?.scrollTo({ top: 0 });
  } catch (e) {
    showToast(`Couldn't open that session: ${e.message}`);
  } finally {
    viewLoading.value = false;
  }
}

function backToLive() {
  viewing.value = null;
  tickerTall.value = false;
  if (window.innerWidth <= NARROW) sidebarOpen.value = false;
  nextTick(() => tickerEl.value?.scrollTo({ top: tickerEl.value.scrollHeight }));
}

function exportSession(format) {
  showExport.value = false;
  // cookie-authed same-origin download; "live" = whatever is on the board now
  window.open(`${HTTP_BASE}/sessions/${viewing.value?.id || "live"}/export?format=${format}`, "_blank");
}

// what the board + ticker actually render (live state, or the opened session)
const viewBubbles = computed(() => {
  if (!viewing.value) return bubbles.value;
  const all = viewing.value.bubbles || [];
  return showDismissed.value ? all : all.filter((b) => !b.removed);
});
const dismissedCount = computed(() =>
  viewing.value ? (viewing.value.bubbles || []).filter((b) => b.removed).length : 0
);
const viewLines = computed(() => (viewing.value ? viewing.value.transcript || [] : lines.value));
const viewSpeakerNames = computed(() =>
  viewing.value ? viewing.value.session?.speakerNames || {} : speakerNames.value
);
const viewReport = computed(() => (viewing.value ? viewing.value.session?.report || null : null));

function whoLabel(line) {
  if (line.source === "me") return "You";
  if (!line.speaker) return "Them";
  return viewSpeakerNames.value[line.speaker] || `Them ${line.speaker.replace("them-", "")}`;
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
    else if (msg.type === "recording") {
      recording.value = msg.value;
      loadSessions(); // a session just opened (or closed) — refresh the sidebar
    }
    else if (msg.type === "status") {
      const hadAgent = captureConnected.value;
      captureConnected.value = msg.captureConnected;
      if (typeof msg.captureAgents === "number") captureAgents.value = msg.captureAgents;
      claudeConnected.value = msg.claudeConnected;
      googleConnected.value = msg.googleConnected;
      agentAvailable.value = Boolean(msg.agentAvailable);
      if (Array.isArray(msg.agentConnectors)) agentConnectors.value = msg.agentConnectors;
      if (typeof msg.asrOk === "boolean") asrOk.value = msg.asrOk;
      // agent we were waiting on just connected -> begin recording seamlessly
      if (!hadAgent && msg.captureConnected && showStartAgent.value) {
        closeStartAgent();
        showToast("Capture agent connected — recording started.");
        setRecording("start");
      }
    } else if (msg.type === "closeout") closingOut.value = msg.value;
    else if (msg.type === "tasks") tasks.value = msg.tasks;
    // the user's Claude, talking: streamed into the open action sheet
    else if (msg.type === "thread") threadFeed.value = msg;
    else if (msg.type === "task_done") {
      // an archived bubble isn't in the broadcast state — patch the open
      // session's copy so its button flips to done/error like a live one
      if (msg.sessionId && msg.sessionId === viewing.value?.id) {
        const b = (viewing.value.bubbles || []).find((x) => x.id === msg.bubbleId);
        const a = b?.actions?.find((x) => x.id === msg.actionId);
        if (a) a.status = msg.status || (msg.ok ? "done" : "error");
      }
      if (msg.cancelled) showToast(`Stopped: ${msg.title}`);
      else
        showToast(
          msg.ok
            ? `✓ Your Claude finished: ${msg.title}${msg.links?.length ? " — click the action to open what it made" : ""}`
            : `Your Claude couldn't finish "${msg.title}": ${(msg.summary || "").slice(0, 140)}`
        );
    }
    else if (msg.type === "report") {
      showToast(`Session report saved: ${msg.report?.title || "untitled"}`);
      loadSessions(); // the closeout just gave the session its title
    } else if (msg.type === "transcript") {
      lines.value.push(msg);
      if (lines.value.length > 200) lines.value.shift();
      if (viewing.value) return; // reading a past session — don't yank the ticker
      await nextTick();
      tickerEl.value?.scrollTo({ top: tickerEl.value.scrollHeight });
    }
  };
}

async function setRecording(target) {
  recPending.value = true;
  try {
    if (target === "start") {
      lines.value = []; // fresh ticker for a fresh session
      viewing.value = null; // recording means attention is on the live board
    }
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

// Clicking an action opens its Claude session: instructions first, then the
// live stream of your own Claude working, then as many follow-up turns as you
// want. The sheet owns the POSTs (it knows the thread); we own the board.
const pendingAction = ref(null); // { bubble, action, sessionId }
const threadFeed = ref(null);    // latest {type:"thread"} ws message

function openActionSheet(bubble, action) {
  pendingAction.value = { bubble, action, sessionId: viewing.value?.id };
}

// the sheet ran something: reflect it on the button and handle the non-agent
// outcomes (artifact download, real Google event link)
function onActionRan(result) {
  const p = pendingAction.value;
  if (p) p.action.status = result.ok ? result.status || "done" : "error";
  if (result.message) showToast(result.message);
  if (result.downloadUrl) window.open(`${HTTP_BASE}${result.downloadUrl}`, "_blank");
  if (result.link) window.open(result.link, "_blank");
}

async function dismiss(bubble) {
  await fetch(`${HTTP_BASE}/dismiss`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bubbleId: bubble.id }),
  });
}

onMounted(async () => {
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.(".export-wrap")) showExport.value = false;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") showExport.value = false;
  });
  if (await ensureSignedIn()) {
    connect();
    loadPairInfo();
    loadSessions();
    if (new URLSearchParams(location.search).get("google") === "connected") {
      showToast("Google connected — calendar context and real actions are live.");
      history.replaceState(null, "", location.pathname);
    }
  }
});
</script>

<template>
  <div class="topbar">
    <button
      class="gear"
      :class="{ on: sidebarOpen }"
      :title="sidebarOpen ? 'Hide sessions' : 'Show sessions'"
      @click="sidebarOpen = !sidebarOpen"
    >
      ☰
    </button>
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
      v-if="connected && captureAgents > 1"
      class="warn-chip"
      @click="openSettings"
      title="More than one Earshot app is capturing for your account. They all hear the same microphone, so only one is used — quit the extras from the tray."
    >
      ⚠ {{ captureAgents }} capture agents
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

  <div class="body">
    <aside v-if="sidebarOpen" class="sidebar">
      <div class="side-head">
        <input
          class="side-search"
          v-model="sessionSearch"
          type="search"
          placeholder="Search sessions + transcripts"
        />
        <button class="mini" :disabled="sessionsLoading" title="Refresh" @click="loadSessions">⟳</button>
      </div>

      <button class="side-item board-item" :class="{ sel: !viewing }" @click="backToLive">
        <span class="side-title">
          <span class="side-dot" :class="{ rec: recording }"></span> Live board
        </span>
        <span class="side-meta">
          {{ recording ? "recording now" : "current board" }} · {{ bubbles.length }} concept{{ bubbles.length === 1 ? "" : "s" }}
        </span>
      </button>

      <div class="side-list">
        <div v-if="!sessions.length" class="side-empty">
          {{
            sessionsLoading
              ? "loading…"
              : sessionSearch
                ? "Nothing matches that."
                : "No recorded sessions yet."
          }}
        </div>
        <template v-for="g in groupedSessions" :key="g.label">
          <div class="side-day">{{ g.label }}</div>
          <button
            v-for="s in g.items"
            :key="s.id"
            class="side-item"
            :class="{ sel: viewing?.id === s.id, current: s.id === boardSessionId }"
            @click="openSession(s)"
          >
            <span class="side-title">{{ sessionTitle(s) }}</span>
            <span class="side-meta">
              {{ timeLabel(s.startedAt) }}<template v-if="durationLabel(s)"> · {{ durationLabel(s) }}</template>
              · {{ s.lineCount }} lines · {{ s.bubbleCount }} concepts
            </span>
            <span v-if="s.snippet" class="side-snip"
              >“{{ s.snippet }}”<template v-if="s.matches > 1"> · {{ s.matches }} hits</template></span
            >
            <span v-if="!s.endedAt" class="side-flag open">open</span>
            <span v-else-if="s.continuesSession" class="side-flag" title="Continues the previous session"
              >continues</span
            >
          </button>
        </template>
      </div>
    </aside>

    <div class="main">
      <div class="viewbar">
        <template v-if="viewing">
          <span class="vb-title">{{ sessionTitle(viewing.meta || viewing.session) }}</span>
          <span class="vb-meta">
            {{ fullStamp(viewing.session?.startedAt) }} · {{ (viewing.transcript || []).length }} lines
            <template v-if="!viewing.session?.endedAt"> · still open</template>
          </span>
          <button v-if="dismissedCount" class="mini" @click="showDismissed = !showDismissed">
            {{ showDismissed ? "hide" : "show" }} {{ dismissedCount }} dismissed
          </button>
          <button class="mini" @click="tickerTall = !tickerTall">
            {{ tickerTall ? "shrink transcript" : "expand transcript" }}
          </button>
          <button class="mini" @click="backToLive">← live board</button>
        </template>
        <template v-else>
          <span class="vb-title">Live board</span>
          <span class="vb-meta">{{ recording ? "recording" : "not recording" }}</span>
          <button v-if="lines.length" class="mini" @click="tickerTall = !tickerTall">
            {{ tickerTall ? "shrink transcript" : "expand transcript" }}
          </button>
        </template>
        <div class="export-wrap">
          <button class="mini" @click="showExport = !showExport">⬇ Export</button>
          <div v-if="showExport" class="export-menu">
            <button class="mini" @click="exportSession('md')">Markdown — report + transcript</button>
            <button class="mini" @click="exportSession('txt')">Transcript only (.txt)</button>
            <button class="mini" @click="exportSession('json')">JSON — everything</button>
          </div>
        </div>
      </div>

      <div class="board" :class="{ dim: viewLoading }">
        <div v-if="viewReport" class="report-card">
          <p v-if="viewReport.summary" class="summary">{{ viewReport.summary }}</p>
          <div class="report-cols">
            <div v-if="viewReport.participants?.length">
              <h4>Participants</h4>
              <ul class="details">
                <li v-for="(p, i) in viewReport.participants" :key="i">{{ p }}</li>
              </ul>
            </div>
            <div v-if="viewReport.decisions?.length">
              <h4>Decisions</h4>
              <ul class="details">
                <li v-for="(d, i) in viewReport.decisions" :key="i">{{ d }}</li>
              </ul>
            </div>
            <div v-if="viewReport.openItems?.length">
              <h4>Open items</h4>
              <ul class="details">
                <li v-for="(o, i) in viewReport.openItems" :key="i">{{ o }}</li>
              </ul>
            </div>
          </div>
        </div>

        <TransitionGroup tag="div" name="bubbles" class="grid">
          <Bubble
            v-for="b in viewBubbles"
            :key="`${viewing?.id || 'live'}:${b.id}`"
            :bubble="b"
            :flash="!viewing && flashIds.has(b.id)"
            :archived="Boolean(viewing)"
            @action="openActionSheet(b, $event)"
            @dismiss="dismiss(b)"
          />
          <div v-if="viewBubbles.length === 0" key="__empty" class="empty">
            {{
              viewing
                ? "This session has no saved concepts — its transcript is below."
                : recording
                  ? "Nothing distilled yet — start talking (or play something) and concepts will appear here."
                  : "Not recording — press Record to start a session."
            }}
          </div>
        </TransitionGroup>
      </div>

      <div class="ticker" :class="{ tall: tickerTall }" ref="tickerEl">
        <div v-for="(l, i) in viewLines" :key="i" class="line">
          <span class="who" :class="l.source">{{ whoLabel(l) }}</span>{{ l.text }}
        </div>
        <div v-if="!viewLines.length" class="line">(no transcript)</div>
      </div>
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

  <ActionSheet
    v-if="pendingAction"
    :key="`${pendingAction.bubble.id}:${pendingAction.action.id}`"
    :http-base="HTTP_BASE"
    :bubble="pendingAction.bubble"
    :action="pendingAction.action"
    :session-id="pendingAction.sessionId"
    :feed="threadFeed"
    @sending="pendingAction.action.status = 'busy'"
    @ran="onActionRan"
    @toast="showToast"
    @close="pendingAction = null"
  />

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
        <p v-if="captureAgents > 1" class="signin-error">
          ⚠ <b>{{ captureAgents }} copies of the app</b> are capturing for your account. They all hear
          the same microphone, so Earshot uses one and ignores the rest — quit the extras
          (tray icon → Quit) so nothing competes.
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
          Every bubble button runs on <b>your own Claude</b>, on your computer, using the
          apps you've already connected to it — install
          <a href="https://claude.com/claude-code" target="_blank">Claude Code</a>, sign in
          once, and the Earshot app does the rest. Watch the topbar while a task runs.
        </p>
        <p v-if="agentConnectors.length || me.agentConnectors?.length">
          Working through your Claude:
          <b>{{ (agentConnectors.length ? agentConnectors : me.agentConnectors).join(", ") }}</b>
        </p>
        <label>Let any Claude of yours search your Earshot conversations (paste in a terminal):</label>
        <div class="keyrow">
          <code class="code-wrap">{{ mcpCommand }}</code>
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
