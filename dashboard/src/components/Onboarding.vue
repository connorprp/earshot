<script setup>
import { ref, computed, watch, onMounted } from "vue";

// First run, walked through instead of hidden in Settings. Each step watches
// live status from the hub, so it advances by itself the moment the thing
// actually happens — paste the install line and step 1 ticks over when the agent
// connects; install Claude Code and step 3 ticks over when the agent re-probes.
const props = defineProps({
  httpBase: { type: String, default: "" },
  me: { type: Object, default: null },          // /me payload (install urls, devices)
  captureConnected: { type: Boolean, default: false },
  devices: { type: Array, default: () => [] },
  claudeMissing: { type: Boolean, default: false },
  agentAvailable: { type: Boolean, default: false },
});
const emit = defineEmits(["done", "toast", "settings"]);

// mac|windows, guessed for the copy button; the user can switch
const guessed = /mac|darwin/i.test(navigator.userAgent) ? "mac" : "windows";
const os = ref(guessed);
const busy = ref(false);
const rechecking = ref(false);

const installLine = computed(() => {
  const base = props.me?.installUrl || "";
  return os.value === "mac" ? `curl -fsSL ${base}/mac | bash` : `irm ${base}/windows | iex`;
});

// Step state is derived, never stored: the truth is what the hub reports.
const agentDone = computed(() => props.captureConnected);
const claudeDone = computed(() => props.agentAvailable && !props.claudeMissing);
const step = computed(() => (!agentDone.value ? 1 : !claudeDone.value ? 2 : 3));
const macDevice = computed(() => props.devices.some((d) => d.platform === "mac"));

async function copyLine() {
  await navigator.clipboard.writeText(installLine.value);
  emit("toast", `Copied — paste it into ${os.value === "mac" ? "Terminal" : "PowerShell"} on the computer you want Earshot to listen from.`);
}

async function recheck() {
  rechecking.value = true;
  await fetch(`${props.httpBase}/me/agent-recheck`, { method: "POST" }).catch(() => {});
  setTimeout(() => (rechecking.value = false), 4000);
}

async function finish() {
  busy.value = true;
  await fetch(`${props.httpBase}/me/onboarded`, { method: "POST" }).catch(() => {});
  busy.value = false;
  emit("done");
}

// the agent showing up is the moment worth celebrating; nudge the ticker along
watch(agentDone, (now) => now && emit("toast", "Your computer is connected."));
onMounted(() => {
  if (props.claudeMissing) recheck(); // pick up a CLI installed before this page opened
});
</script>

<template>
  <div class="ob-overlay">
    <div class="ob-card">
      <h2>EARSHOT</h2>
      <p class="ob-lead">
        Earshot listens to the conversations you're already having and keeps a live board of
        what matters — with buttons that do the follow-up work. Two things to set up.
      </p>

      <!-- 1 · the agent -->
      <div class="ob-step" :class="{ active: step === 1, done: agentDone }">
        <div class="ob-head">
          <span class="ob-num">{{ agentDone ? "✓" : "1" }}</span>
          <h3>Install the listener on your computer</h3>
        </div>
        <template v-if="!agentDone">
          <p>
            Audio is captured on your own machine, so nothing runs here in the browser. Paste
            one line — no download, no security warnings:
          </p>
          <div class="ob-os">
            <button class="mini" :class="{ sel: os === 'mac' }" @click="os = 'mac'">macOS</button>
            <button class="mini" :class="{ sel: os === 'windows' }" @click="os = 'windows'">Windows</button>
            <span class="ob-hint">{{ os === "mac" ? "paste in Terminal" : "paste in PowerShell" }}</span>
          </div>
          <div class="keyrow">
            <code class="code-wrap">{{ installLine }}</code>
            <button class="mini dl" @click="copyLine">copy</button>
          </div>
          <p class="ob-wait"><span class="btn-spinner"></span> waiting for it to connect… this page updates itself</p>
          <p class="ob-hint">
            It will ask you to click <b>Allow this computer</b> here, then for microphone
            access on the machine itself.
          </p>
        </template>
        <p v-else class="ob-ok">
          Connected: <b>{{ devices.map((d) => d.name).join(", ") }}</b>
        </p>
      </div>

      <!-- 2 · the Claude CLI it drives -->
      <div class="ob-step" :class="{ active: step === 2, done: claudeDone }">
        <div class="ob-head">
          <span class="ob-num">{{ claudeDone ? "✓" : "2" }}</span>
          <h3>Point it at your Claude</h3>
        </div>
        <template v-if="!claudeDone">
          <p>
            The action buttons and <b>✦ Ask Claude</b> run on <b>your own Claude Code</b>, on
            your computer, using your subscription and the apps already connected to it —
            Earshot never asks you to connect anything.
          </p>
          <div class="keyrow">
            <a class="mini dl" href="https://claude.com/claude-code" target="_blank" rel="noopener">Get Claude Code ↗</a>
            <button class="mini" :disabled="rechecking || !captureConnected" @click="recheck">
              {{ rechecking ? "checking…" : "I've installed it — check again" }}
            </button>
          </div>
          <p class="ob-hint">
            Already have it? Make sure you've run <code>claude</code> once and signed in. Earshot
            also re-checks by itself every minute.
          </p>
          <p v-if="!captureConnected" class="ob-hint">Finish step 1 first — the check happens on your computer.</p>
        </template>
        <p v-else class="ob-ok">
          Ready on <b>{{ devices.filter((d) => d.claude).map((d) => d.name).join(", ") }}</b>
        </p>
      </div>

      <!-- 3 · optional mac audio driver -->
      <div v-if="macDevice" class="ob-step">
        <div class="ob-head">
          <span class="ob-num">◦</span>
          <h3>Mac only, optional: hear the other side of calls</h3>
        </div>
        <p>
          macOS won't let an app record system audio without a helper driver. The installer
          offered to set up <b>BlackHole</b> — if you skipped it, your microphone still works;
          you just won't capture the far end of a call. Run
          <code>earshot log</code> on that Mac to see what it's hearing.
        </p>
      </div>

      <div class="ob-actions">
        <button class="mini dl" :disabled="busy" @click="finish">
          {{ step === 3 ? "Done — take me to the board" : "Skip for now" }}
        </button>
        <button class="mini" @click="emit('settings')">open Settings instead</button>
      </div>
      <p class="ob-hint">You can reopen this from Settings ⚙ any time.</p>
    </div>
  </div>
</template>

<style scoped>
.ob-overlay {
  position: fixed; inset: 0; z-index: 30;
  background: var(--bg);
  display: flex; align-items: flex-start; justify-content: center;
  padding: 32px 16px; overflow-y: auto;
}
.ob-card {
  background: linear-gradient(180deg, var(--panel-2), var(--panel));
  border: 1px solid var(--border); border-radius: 14px;
  padding: 28px 30px; width: min(620px, 100%);
  display: flex; flex-direction: column; gap: 14px;
}
h2 { font-size: 18px; letter-spacing: 2px; text-align: center; }
.ob-lead { font-size: 13px; color: var(--dim); line-height: 1.6; }
.ob-step {
  border: 1px solid var(--border); border-radius: 10px;
  padding: 12px 14px; display: flex; flex-direction: column; gap: 8px;
  opacity: 0.75;
}
.ob-step.active { opacity: 1; border-color: var(--accent-scheduling); }
.ob-step.done { opacity: 0.85; border-color: #3fb950; }
.ob-head { display: flex; align-items: center; gap: 9px; }
.ob-head h3 { font-size: 13.5px; }
.ob-num {
  width: 22px; height: 22px; flex: none; border-radius: 50%;
  border: 1px solid var(--border); display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; color: var(--dim);
}
.ob-step.active .ob-num { border-color: var(--accent-scheduling); color: var(--accent-scheduling); }
.ob-step.done .ob-num { border-color: #3fb950; color: #3fb950; }
.ob-step p { font-size: 12.5px; color: var(--dim); line-height: 1.6; }
.ob-step code { font-size: 11.5px; }
.ob-os { display: flex; align-items: center; gap: 6px; }
.ob-hint { font-size: 11px; color: var(--dim); opacity: 0.9; }
.ob-wait { display: flex; align-items: center; gap: 7px; font-size: 12px; }
.ob-ok { color: #3fb950; font-size: 12.5px; }
.ob-actions { display: flex; gap: 8px; align-items: center; justify-content: flex-end; }
</style>
