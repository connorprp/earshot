<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import ThreadLog from "./ThreadLog.vue";

// The Claude session behind a concept. Clicking an action opens this: type
// instructions, watch your own Claude work (the same text a terminal would
// print), then keep talking to it — every turn resumes the SAME session on
// your machine, and the whole conversation stays attached to the bubble.
const props = defineProps({
  httpBase: { type: String, default: "" },
  bubble: { type: Object, required: true },
  action: { type: Object, required: true },
  // archive view: the session this bubble belongs to (the hub gives the agent
  // THAT conversation as context, so the preview must ask with it too)
  sessionId: { type: String, default: undefined },
  // latest {type:"thread"} ws message; we take the ones addressed to us
  feed: { type: Object, default: null },
});
// "ran" = the action itself was dispatched (the button's status follows it);
// "toast" = just tell the user something, the button is unaffected
const emit = defineEmits(["sending", "ran", "toast", "close"]);

const draft = ref(props.action.userNotes || "");
const box = ref(null);
const thread = ref(null);
const messages = ref([]);
const running = ref(false);
const busy = ref(false); // a send is in flight (before the hub answers)
const preview = ref(null); // { title, type, route, prompt }
const previewOpen = ref(false);
const loadingPreview = ref(false);
let previewTimer = null;
let seq = 0; // ignore out-of-order preview responses while typing

// a thread that has reached its agent can be continued; before that, the only
// thing to send is the action's own mission
const canResume = computed(() => Boolean(thread.value?.claudeSessionId));
const started = computed(() => messages.value.length > 0);

async function loadThread() {
  const q = new URLSearchParams({ bubbleId: props.bubble.id, actionId: props.action.id });
  if (props.sessionId) q.set("sessionId", props.sessionId);
  try {
    const r = await fetch(`${props.httpBase}/thread?${q}`);
    const data = await r.json();
    if (!data.ok || !data.thread) return;
    thread.value = data.thread;
    messages.value = data.thread.messages || [];
    running.value = data.running;
  } catch {
    /* no thread yet is the normal case */
  }
}

async function loadPreview() {
  const mine = ++seq;
  loadingPreview.value = true;
  try {
    const r = await fetch(`${props.httpBase}/action/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bubbleId: props.bubble.id,
        actionId: props.action.id,
        sessionId: props.sessionId,
        notes: draft.value,
      }),
    });
    const data = await r.json();
    if (mine === seq && data.ok) preview.value = data;
  } catch {
    /* preview is a nicety — the send path doesn't depend on it */
  } finally {
    if (mine === seq) loadingPreview.value = false;
  }
}

// re-render the prompt as the user types, but only while they're looking at it
watch(draft, () => {
  if (!previewOpen.value) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(loadPreview, 400);
});

function togglePreview(e) {
  previewOpen.value = e.target.open;
  if (previewOpen.value) loadPreview();
}

// live stream from the hub: appends addressed to this thread (or, right after
// the first send, to this bubble+action before we know the thread id)
watch(
  () => props.feed,
  (msg) => {
    if (!msg) return;
    const mine =
      (thread.value && msg.threadId === thread.value.id) ||
      (!thread.value && msg.bubbleId === props.bubble.id && msg.actionId === props.action.id);
    if (!mine) return;
    if (!thread.value) thread.value = { id: msg.threadId, claudeSessionId: null };
    else if (msg.threadId !== thread.value.id) thread.value.id = msg.threadId;
    messages.value = messages.value.concat(msg.messages || []);
    running.value = msg.status === "running";
    if (!running.value) loadThread(); // picks up claudeSessionId so replies can resume
  }
);

async function send() {
  const text = draft.value.trim();
  if (busy.value || running.value) return;
  if (canResume.value) {
    if (!text) return;
    busy.value = true;
    draft.value = "";
    try {
      const r = await (
        await fetch(`${props.httpBase}/thread/reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId: thread.value.id, text }),
        })
      ).json();
      if (r.ok) running.value = true;
      else {
        draft.value = text; // give it back rather than swallowing what they wrote
        emit("toast", r.message);
      }
    } finally {
      busy.value = false;
    }
    return;
  }
  // first turn: the hub builds the full mission prompt and opens the thread
  busy.value = true;
  emit("sending");
  try {
    const r = await (
      await fetch(`${props.httpBase}/action`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bubbleId: props.bubble.id,
          actionId: props.action.id,
          sessionId: props.sessionId,
          notes: text,
        }),
      })
    ).json();
    emit("ran", r);
    if (r.status === "running") {
      running.value = true;
      draft.value = "";
      loadThread();
    }
  } finally {
    busy.value = false;
  }
}

// deliverables live on the machine that ran the task, so opening one is a
// request to that agent — not a link this browser could ever follow
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
  if (!started.value) loadPreview(); // for the route chip on a fresh action
  box.value?.focus();
  window.addEventListener("keydown", onKey);
});
onBeforeUnmount(() => {
  clearTimeout(previewTimer);
  window.removeEventListener("keydown", onKey);
});
</script>

<template>
  <div class="sheet-overlay" @click.self="emit('close')">
    <div class="sheet">
      <div class="sheet-head">
        <span class="kind">{{ action.type.replace("_", " ") }}</span>
        <h3>{{ preview?.title || thread?.title || action.label }}</h3>
        <button class="mini" @click="emit('close')">close</button>
      </div>
      <p class="concept">on “{{ bubble.title }}”</p>

      <!-- the session itself: what your Claude said and did, as it happens -->
      <ThreadLog v-if="started" ref="log" :messages="messages" :running="running" @open="openFile" />

      <p v-else class="route">
        <template v-if="preview?.route === 'agent'">
          Runs on <b>your Claude</b>, on your computer — you'll see it work here, and you can keep talking to it.
        </template>
        <template v-else-if="preview?.route === 'hub'">
          No Claude agent is reachable — Earshot will produce the file itself, and
          your instructions go into it.
        </template>
        <template v-else>Preparing…</template>
      </p>

      <label v-if="!started" for="action-notes">Your instructions (optional) — these outrank the description above</label>
      <textarea
        id="action-notes"
        ref="box"
        v-model="draft"
        :rows="started ? 2 : 4"
        :disabled="running"
        :placeholder="
          canResume
            ? 'Reply to your Claude — it still has the whole task in context…'
            : 'e.g. keep it to three sentences, CC Dana, use Tuesday not Thursday, check Asana first…'
        "
      ></textarea>

      <details v-if="!started" class="prompt-fold" @toggle="togglePreview">
        <summary>see the exact prompt your Claude gets{{ loadingPreview && previewOpen ? " (updating…)" : "" }}</summary>
        <pre v-if="preview?.prompt">{{ preview.prompt }}</pre>
        <p v-else class="route">This action doesn't go to an agent — nothing to preview.</p>
      </details>

      <div class="sheet-buttons">
        <button v-if="running" class="mini stop" @click="stop">■ stop</button>
        <button
          v-else
          class="mini dl"
          :disabled="busy || (canResume && !draft.trim())"
          @click="send"
        >
          {{ started ? "Send" : "Send to my Claude" }}
        </button>
        <span v-if="running" class="hint">it keeps running if you close this</span>
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
.concept { font-size: 11px; color: var(--dim); margin: -6px 0 0; }
.route { font-size: 12px; color: var(--dim); margin: 0; }
label { font-size: 11px; color: var(--dim); }

/* the session log itself lives in ThreadLog.vue (shared with AskSheet) */

textarea {
  background: var(--bg); border: 1px solid var(--border); color: var(--text);
  border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 13px;
  resize: vertical;
}
textarea:focus { outline: none; border-color: var(--accent-scheduling); }
textarea:disabled { opacity: 0.5; }
.prompt-fold summary { font-size: 11px; color: var(--dim); cursor: pointer; }
.prompt-fold pre {
  margin-top: 8px; max-height: 240px; overflow: auto;
  background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
  padding: 10px; font-size: 11px; line-height: 1.5; white-space: pre-wrap;
  word-break: break-word;
}
.sheet-buttons { display: flex; gap: 8px; align-items: center; }
.mini.stop { border-color: #f85149; color: #f85149; }
.hint { font-size: 10px; color: var(--dim); margin-left: auto; }
</style>
