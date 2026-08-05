<script setup>
import { computed } from "vue";

const props = defineProps({
  bubble: { type: Object, required: true },
  flash: { type: Boolean, default: false },
});
defineEmits(["action", "dismiss"]);

const accent = computed(() => `var(--accent-${props.bubble.kind || "discussion"}, var(--dim))`);
</script>

<template>
  <div class="bubble" :class="{ flash }" :style="{ '--accent': accent }">
    <div class="bubble-head">
      <span class="kind">{{ bubble.kind }}</span>
      <h3>{{ bubble.title }}</h3>
      <button class="dismiss" title="Ignore" @click="$emit('dismiss')">✕</button>
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
        @click="$emit('action', a)"
      >
        {{ a.status === "done" ? "✓ " : "" }}{{ a.label }}
      </button>
    </div>
  </div>
</template>
