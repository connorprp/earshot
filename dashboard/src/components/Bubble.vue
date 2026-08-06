<script setup>
import { computed } from "vue";

const props = defineProps({
  bubble: { type: Object, required: true },
  flash: { type: Boolean, default: false },
  // archive view: the bubble belongs to a past session. Its actions still run
  // (the hub feeds the agent THAT session's transcript), but history can't be
  // dismissed after the fact.
  archived: { type: Boolean, default: false },
});
defineEmits(["action", "dismiss"]);

const accent = computed(() => `var(--accent-${props.bubble.kind || "discussion"}, var(--dim))`);
const askedFor = computed(() => (props.bubble.actions || []).filter((a) => a.userNotes));
</script>

<template>
  <div class="bubble" :class="{ flash, archived, removed: bubble.removed }" :style="{ '--accent': accent }">
    <div class="bubble-head">
      <span class="kind">{{ bubble.kind }}</span>
      <h3>{{ bubble.title }}</h3>
      <span v-if="bubble.removed" class="kind" :title="bubble.removedReason">dismissed</span>
      <button v-if="!archived" class="dismiss" title="Ignore" @click="$emit('dismiss')">✕</button>
    </div>
    <p class="summary">{{ bubble.summary }}</p>
    <ul v-if="bubble.details?.length" class="details">
      <li v-for="(d, i) in bubble.details" :key="i">{{ d }}</li>
    </ul>
    <div v-if="bubble.actions?.length" class="actions">
      <button
        v-for="a in bubble.actions"
        :key="a.id"
        class="action"
        :class="a.status"
        :title="
          a.status === 'running'
            ? 'Your Claude is working on this — click to watch or stop it'
            : a.threadId
              ? 'Open the Claude session for this action'
              : archived
                ? 'Runs now on your Claude, using this past session as context'
                : ''
        "
        @click="$emit('action', a)"
      >
        <span v-if="a.status === 'running'" class="btn-spinner"></span>
        {{ a.status === "done" ? "✓ " : "" }}{{ a.label }}
        <!-- a session exists behind this button: click reopens the conversation -->
        <span v-if="a.threadId && a.status !== 'running'" class="thread-dot">💬</span>
      </button>
    </div>
    <!-- what the user typed in the send sheet, kept with the action so the
         archive shows what was actually asked for, not just that it ran -->
    <ul v-if="askedFor.length" class="asked">
      <li v-for="a in askedFor" :key="a.id">
        <span class="asked-label">{{ a.label }}:</span> “{{ a.userNotes }}”
      </li>
    </ul>
  </div>
</template>
