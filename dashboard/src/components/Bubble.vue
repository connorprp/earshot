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
            ? 'Your Claude agent is working on this on your device'
            : archived
              ? 'Runs now on your Claude, using this past session as context'
              : ''
        "
        @click="$emit('action', a)"
      >
        <span v-if="a.status === 'running'" class="btn-spinner"></span>
        {{ a.status === "done" ? "✓ " : "" }}{{ a.label }}
      </button>
    </div>
  </div>
</template>
