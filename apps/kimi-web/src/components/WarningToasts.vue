<!-- apps/kimi-web/src/components/WarningToasts.vue -->
<!-- Floating stack of warning/error messages collected in the app state.
     Without this, agent errors (e.g. a 403 from the model provider) and load
     failures were silently swallowed. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { ref, watch, onUnmounted } from 'vue';

const props = defineProps<{ warnings: string[] }>();
const emit = defineEmits<{ dismiss: [index: number] }>();

const { t } = useI18n();

function isError(w: string): boolean {
  return w.startsWith(`${t('warnings.errorLabel')}:`) || /\b4\d\d\b|error|失败|failed/i.test(w);
}

/** One entry per visible toast. `id` is a unique per-instance key so that
    repeated identical texts each get their own auto-dismiss timer. */
interface ToastItem {
  id: number;
  text: string;
}

let nextId = 1;
const toasts = ref<ToastItem[]>([]);

/** Auto-dismiss timer per toast instance. `handle` is null while paused
    (pointer over the toast); `remaining` then holds the leftover time. */
interface ToastTimer {
  handle: ReturnType<typeof setTimeout> | null;
  deadline: number;
  remaining: number;
}
const timers = new Map<number, ToastTimer>();

function toastDuration(text: string): number {
  const base = isError(text) ? 10000 : 6000;
  // Touch screens have no hover-to-pause, so grant extra reading time.
  const touch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches === true;
  return touch ? base + 4000 : base;
}

function runTimer(id: number, ms: number): void {
  const entry = timers.get(id) ?? { handle: null, deadline: 0, remaining: 0 };
  entry.handle = setTimeout(() => dismissById(id), ms);
  entry.deadline = Date.now() + ms;
  timers.set(id, entry);
}

function clearTimer(id: number): void {
  const entry = timers.get(id);
  if (entry && entry.handle !== null) clearTimeout(entry.handle);
  timers.delete(id);
}

function pauseTimer(id: number): void {
  const entry = timers.get(id);
  if (!entry || entry.handle === null) return;
  clearTimeout(entry.handle);
  entry.handle = null;
  entry.remaining = Math.max(0, entry.deadline - Date.now());
}

function resumeTimer(id: number): void {
  const entry = timers.get(id);
  if (!entry || entry.handle !== null) return;
  runTimer(id, entry.remaining);
}

/** Used by both the timer expiry and the manual close button. Removes the
    toast locally first so a later reconcile can't mismatch duplicate texts. */
function dismissById(id: number): void {
  clearTimer(id);
  const idx = toasts.value.findIndex((item) => item.id === id);
  if (idx === -1) return;
  toasts.value = toasts.value.filter((item) => item.id !== id);
  emit('dismiss', idx);
}

// Reconcile local toast instances with the warnings prop: reuse instances
// (and their running timers) for texts still present, create fresh instances
// with fresh timers for new texts, and clear timers of removed ones — so a
// re-appearing identical text is never killed by a stale timer.
watch(
  () => props.warnings,
  (next) => {
    const unmatched = [...toasts.value];
    toasts.value = next.map((text) => {
      const at = unmatched.findIndex((item) => item.text === text);
      const reused = at === -1 ? undefined : unmatched.splice(at, 1)[0];
      if (reused) return reused;
      const item: ToastItem = { id: nextId++, text };
      runTimer(item.id, toastDuration(text));
      return item;
    });
    for (const gone of unmatched) clearTimer(gone.id);
  },
  { immediate: true, flush: 'post' },
);

onUnmounted(() => {
  timers.forEach((entry) => {
    if (entry.handle !== null) clearTimeout(entry.handle);
  });
  timers.clear();
});
</script>

<template>
  <div v-if="toasts.length" class="toasts" role="status" aria-live="polite">
    <div
      v-for="toast in toasts"
      :key="toast.id"
      class="toast"
      :class="{ err: isError(toast.text) }"
      @pointerenter="pauseTimer(toast.id)"
      @pointerleave="resumeTimer(toast.id)"
    >
      <span class="dot" aria-hidden="true"></span>
      <span class="msg">{{ toast.text }}</span>
      <button class="x" type="button" :aria-label="t('warnings.dismiss')" @click="dismissById(toast.id)">
        <svg viewBox="0 0 16 16" width="12" height="12">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 16px;
  bottom: 84px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 60;
  width: min(380px, calc(100vw - 32px));
  max-height: 56vh;
  overflow-y: auto;
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 9px 9px 9px 11px;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.12);
  font-size: 14px;
  line-height: 1.5;
}
/* Error toasts: a subtle red-tinted border (no left accent bar); the red dot
   is the primary error cue. */
.toast.err {
  border-color: color-mix(in srgb, var(--err) 35%, transparent);
}
.dot {
  flex: none;
  width: 6px;
  height: 6px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--muted);
}
.toast.err .dot {
  background: var(--err);
}
.msg {
  flex: 1;
  color: var(--ink);
  word-break: break-word;
}
.toast.err .msg {
  color: var(--err);
}
.x {
  flex: none;
  border: 0;
  background: none;
  cursor: pointer;
  color: var(--muted);
  padding: 1px 2px;
  display: flex;
  align-items: center;
  border-radius: 4px;
}
.x:hover {
  color: var(--ink);
  background: var(--hover, rgba(0, 0, 0, 0.05));
}

/* ---- Mobile: full-width stack with side margins, just above the composer. ----
   The desktop corner card (min(380px, …)) is too narrow + right-anchored for a
   phone; here we stretch edge-to-edge (minus 12px gutters) and bump the bottom
   offset above the composer + its safe-area inset. Dismiss tap target grows. */
@media (max-width: 640px) {
  .toasts {
    left: 12px;
    right: 12px;
    bottom: calc(76px + env(safe-area-inset-bottom));
    width: auto;
    max-height: 50vh;
  }
  .toast {
    padding: 11px 11px 11px 13px;
    border-radius: 10px;
  }
  .x {
    width: 28px;
    height: 28px;
    margin: -4px -4px -4px 0;
    justify-content: center;
  }
}
</style>
