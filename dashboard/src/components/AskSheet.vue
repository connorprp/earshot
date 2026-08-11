<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import ThreadLog from "./ThreadLog.vue";

// "✦ Ask Claude" — the general-purpose channel to the user's own Claude, opened
// either from one concept ("this decision was reversed", "who is them-2?") or
// from the whole board (the topbar button). It is NOT one of the model's hedged
// action buttons: the user types whatever they want, and the agent can both DO
// the work and rewrite the notes live through the earshot MCP write tools —
// which is why any change made here shows up on every concept at once.
const props = defineProps({
  httpBase: { type: String, default: "" },
  // the concept this was opened from; null = the whole board
  bubble: { type: Object, default: null },
  // archive view: the session being read (its own board is what gets edited)
  sessionId: { type: String, default: undefined },
  // latest {type:"thread"} ws message; we take the ones addressed to us
  feed: { type: Object, default: null },
  agentAvailable: { type: Boolean, default: true },
  // WHICH computer this browser belongs to (learned at pairing) and its name —
  // without this the hub runs the work on whichever agent connected first
  deviceId: { type: String, default: "" },
  deviceName: { type: String, default: "" },
  claudeMissing: { type: Boolean, default: false },
});
const emit = defineEmits(["toast", "close"]);

const BOARD_BUBBLE = "__board"; // must match server/index.js
const ASK_ACTION = "__ask";

const draft = ref("");
const box = ref(null);
const thread = ref(null);
const messages = ref([]);
const running = ref(false);
const busy = ref(false);

const bubbleKey = computed(() => props.bubble?.id || BOARD_BUBBLE);
const canResume = computed(() => Boolean(thread.value?.claudeSessionId));
const started = computed(() => messages.value.length > 0);

const EXAMPLES = [
  "them-2 is Dave Ramirez from the vendor — name him everywhere",
  "split this card: the budget part is its own thing",
  "we decided against this — say so and drop the action buttons",
  "find three alternatives to what they mentioned and write it up",
];

async function loadThread() {
  const q = new URLSearchParams({ bubbleId: bubbleKey.value, actionId: ASK_ACTION });
  if (props.sessionId) q.set("sessionId", props.sessionId);
  try {
    const r = await fetch(`${props.httpBase}/thread?${q}`);
    const data = await r.json();
    if (!data.ok || !data.thread) return;
    thread.value = data.thread;
    messages.value = data.thread.messages || [];
    running.value = data.running;
  } catch {
    /* no conversation on this concept yet is the normal case */
  }
}

watch(
  () => props.feed,
  (msg) => {
    if (!msg) return;
    const mine =
      (thread.value && msg.threadId === thread.value.id) ||
      (!thread.value && msg.bubbleId === bubbleKey.value && msg.actionId === ASK_ACTION);
    if (!mine) return;
    if (!thread.value) thread.value = { id: msg.threadId, claudeSessionId: null };
    messages.value = messages.value.concat(msg.messages || []);
    running.value = msg.status === "running";
    if (!running.value) loadThread(); // picks up claudeSessionId so replies resume
  }
);

async function send() {
  const text = draft.value.trim();
  if (!text || busy.value || running.value) return;
  busy.value = true;
  draft.value = "";
  try {
    // a live conversation continues on the user's machine; the first turn (or a
    // deliberately fresh one) carries the whole board as context
    const resuming = canResume.value;
    const r = await (
      await fetch(`${props.httpBase}${resuming ? "/thread/reply" : "/ask"}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          resuming
            ? { threadId: thread.value.id, text }
            : { text, bubbleId: props.bubble?.id, sessionId: props.sessionId, deviceId: props.deviceId }
        ),
      })
    ).json();
    if (r.ok) {
      running.value = true;
      if (r.threadId && !thread.value) thread.value = { id: r.threadId, claudeSessionId: null };
      if (!resuming) messages.value = messages.value.concat([{ role: "user", text }]);
    } else {
      draft.value = text; // give it back rather than swallowing what they wrote
      emit("toast", r.message || "Couldn't reach your Claude.");
    }
  } finally {
    busy.value = false;
  }
}

// a new run: the next send starts a fresh Claude session with the board as it
// stands now (the old conversation stays in Mongo)
function startOver() {
  thread.value = null;
  messages.value = [];
  running.value = false;
  box.value?.focus();
}

async function openFile(file) {
  const r = await (
    await fetch(`${props.httpBase}/thread/open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: thread.value?.id, file: file || "" }),
    })
  ).json();
  emit("toast", r.message);
}

async function stop() {
  const r = await (
    await fetch(`${props.httpBase}/thread/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ threadId: thread.value?.id }),
    })
  ).json();
  if (r.ok) running.value = false;
  else emit("toast", r.message);
}

function onKey(e) {
  if (e.key === "Escape") emit("close");
  else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
}

onMounted(async () => {
  await loadThread();
  box.value?.focus();
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="sheet-overlay" @click.self="emit('close')">
    <div class="sheet">
      <div class="sheet-head">
        <span class="kind ask">✦ ask</span>
        <h3>{{ bubble ? `Ask about “${bubble.title}”` : "Ask your Claude" }}</h3>
        <button v-if="started && !running" class="mini" title="Start a fresh conversation" @click="startOver">
          new
        </button>
        <button class="mini" @click="emit('close')">close</button>
      </div>
      <p class="concept">
        {{
          bubble
            ? "Anything you want done with this concept — or a correction to it."
            : "Anything you want done, or fixed, across the whole board."
        }}
      </p>

      <ThreadLog v-if="started" :messages="messages" :running="running" @open="openFile" />

      <template v-else>
        <p class="route">
          Your own Claude reads the board and this conversation, then
          <b>edits your notes directly</b> — a name, a wrong fact, a card that should be
          split or dropped — and shows up on every screen at once. It can also just do the
          work: research, drafts, files, and anything your connected apps make real.
        </p>
        <p v-if="claudeMissing" class="signin-error small">
          Earshot is running on your computer, but <b>Claude Code isn't installed there</b> —
          <a href="https://claude.com/claude-code" target="_blank" rel="noopener">get it here</a>,
          then reopen this.
        </p>
        <p v-else-if="!agentAvailable" class="signin-error small">
          No Earshot agent is connected, so there's nothing to ask yet — open Earshot on your
          computer (Settings ⚙ has the one-line installer).
        </p>
        <p v-else-if="deviceName" class="route">Runs on <b>{{ deviceName }}</b>.</p>
        <div class="examples">
          <button v-for="e in EXAMPLES" :key="e" class="mini ex" @click="draft = e">{{ e }}</button>
        </div>
      </template>

      <textarea
        ref="box"
        v-model="draft"
        :rows="started ? 2 : 3"
        :disabled="running"
        :placeholder="
          started
            ? 'Reply to your Claude — it still has the whole conversation in context…'
            : bubble
              ? 'e.g. them-2 is Dave from the vendor; retitle this to Vendor pricing…'
              : 'e.g. nobody named Sarah was here, that was Julia — fix it everywhere'
        "
      ></textarea>

      <div class="sheet-buttons">
        <button v-if="running" class="mini stop" @click="stop">■ stop</button>
        <button v-else class="mini dl" :disabled="busy || !draft.trim()" @click="send">
          {{ started ? "Send" : "Send to my Claude" }}
        </button>
        <span v-if="running" class="hint">it keeps working if you close this</span>
        <span v-else class="hint">⌘/Ctrl+Enter</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sheet-overlay {
  position: fixed; inset: 0; z-index: 25;
  background: rgba(0, 0, 0, 0.6);
  display: flex; align-items: center; justify-content: center; padding: 16px;
}
.sheet {
  background: linear-gradient(180deg, var(--panel-2), var(--panel));
  border: 1px solid var(--border); border-radius: 14px;
  padding: 18px 20px; width: min(680px, 100%);
  max-height: calc(100vh - 48px);
  display: flex; flex-direction: column; gap: 10px;
}
.sheet-head { display: flex; align-items: baseline; gap: 8px; }
.sheet-head h3 { font-size: 15px; margin: 0; flex: 1; }
.kind {
  font-size: 10px; letter-spacing: 1px; text-transform: uppercase;
  color: var(--dim); border: 1px solid var(--border);
  padding: 2px 6px; border-radius: 5px; flex: none;
}
.kind.ask { color: var(--accent-decision); border-color: var(--accent-decision); }
.concept { font-size: 11px; color: var(--dim); margin: -6px 0 0; }
.route { font-size: 12px; color: var(--dim); margin: 0; line-height: 1.55; }
.small { font-size: 11.5px; margin: 0; }
.examples { display: flex; flex-wrap: wrap; gap: 6px; }
.mini.ex { color: var(--dim); text-align: left; font-style: italic; }
.mini.ex:hover { color: var(--text); }
textarea {
  background: var(--bg); border: 1px solid var(--border); color: var(--text);
  border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 13px;
  resize: vertical;
}
textarea:focus { outline: none; border-color: var(--accent-decision); }
textarea:disabled { opacity: 0.5; }
.sheet-buttons { display: flex; gap: 8px; align-items: center; }
.mini.stop { border-color: #f85149; color: #f85149; }
.hint { font-size: 10px; color: var(--dim); margin-left: auto; }
</style>
