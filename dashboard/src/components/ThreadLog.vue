<script setup>
// One Claude conversation, rendered the way a terminal would print it:
// what you said, the assistant's text, tool calls and their results, the final
// result with openable deliverables, and "✎ …" system lines for edits it made
// to your notes. Shared by ActionSheet (a button's session) and AskSheet
// (free-form direction), so both look and behave identically.
import { ref, watch, nextTick, onMounted } from "vue";

const props = defineProps({
  messages: { type: Array, default: () => [] },
  running: { type: Boolean, default: false },
});
// a file lives on the machine that ran the task, so the parent turns this into
// a request to that device agent
defineEmits(["open"]);

// the log follows the conversation on its own — both sheets used to do this
const root = ref(null);
function follow() {
  nextTick(() => {
    if (root.value) root.value.scrollTop = root.value.scrollHeight;
  });
}
watch(() => [props.messages.length, props.running], follow);
onMounted(follow);
</script>

<template>
  <div ref="root" class="log">
    <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
      <template v-if="m.role === 'user'">
        <span class="caret">❯</span><span class="msg-text">{{ m.text }}</span>
      </template>
      <template v-else-if="m.role === 'tool'">
        <span class="tool-name">⚒ {{ m.name }}</span>
        <span v-if="m.text" class="tool-arg">{{ m.text }}</span>
      </template>
      <template v-else-if="m.role === 'tool_result'">
        <pre class="tool-out" :class="{ bad: m.ok === false }">{{ m.text }}</pre>
      </template>
      <template v-else-if="m.role === 'result'">
        <div class="result" :class="{ bad: m.ok === false }">
          <b>{{ m.ok === false ? "✗ didn't finish" : "✓ done" }}</b>
          <span class="msg-text">{{ m.text }}</span>
          <div v-if="m.links?.length || m.files?.length" class="deliverables">
            <template v-for="(l, j) in m.links || []" :key="j">
              <a v-if="l.url" class="mini dl" :href="l.url" target="_blank" rel="noopener">↗ {{ l.label }}</a>
              <button v-else class="mini dl" @click="$emit('open', l.file)">📄 {{ l.label }}</button>
            </template>
            <button v-if="m.files?.length" class="mini" @click="$emit('open', '')">open the folder</button>
          </div>
          <p v-if="m.files?.length" class="files">on your computer: {{ m.files.join(", ") }}</p>
        </div>
      </template>
      <template v-else-if="m.role === 'system'">
        <em class="sys">{{ m.text }}</em>
      </template>
      <span v-else class="msg-text">{{ m.text }}</span>
    </div>
    <div v-if="running" class="msg working"><span class="btn-spinner"></span> your Claude is working…</div>
  </div>
</template>

<style scoped>
.log {
  flex: 1; min-height: 140px; max-height: 46vh; overflow-y: auto;
  background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
  padding: 12px; display: flex; flex-direction: column; gap: 10px;
  font-size: 12.5px; line-height: 1.6;
}
.msg { display: flex; gap: 6px; align-items: baseline; }
.msg-text { white-space: pre-wrap; word-break: break-word; }
.msg.user { color: var(--text); }
.msg.user .caret { color: var(--accent-decision); font-weight: 700; flex: none; }
.msg.assistant { display: block; white-space: pre-wrap; word-break: break-word; }
.msg.tool { font-size: 11px; color: var(--dim); flex-wrap: wrap; }
.tool-name { color: var(--accent-scheduling); flex: none; }
.tool-arg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-out {
  margin: 0; font-size: 11px; color: var(--dim); white-space: pre-wrap;
  word-break: break-word; max-height: 7em; overflow-y: auto;
  border-left: 2px solid var(--border); padding-left: 8px; width: 100%;
}
.tool-out.bad { border-left-color: #f85149; }
.result {
  border: 1px solid #3fb950; border-radius: 8px; padding: 8px 10px;
  display: flex; flex-direction: column; gap: 4px; width: 100%;
}
.result.bad { border-color: #f85149; }
.result .files { margin: 0; font-size: 11px; color: var(--dim); }
.deliverables { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.deliverables .mini { text-decoration: none; }
/* an edit to the notes, or a stop — the conversation's own margin notes */
.sys { color: var(--accent-data); font-size: 11px; }
.working { color: var(--dim); font-size: 11px; align-items: center; }
</style>
