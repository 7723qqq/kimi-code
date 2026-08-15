<!-- apps/kimi-web/src/components/chat/TurnFold.vue -->
<!-- Per-assistant-turn work fold: a single "Worked {duration}" header that
     collapses/expands the turn's work process (thinking + tool activity).
     Auto-opens while the turn streams, collapses once it settles (mirroring
     the official web's TurnFold). -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '../ui/Icon.vue';
import { formatDuration } from '../chatTurnRendering';

const props = withDefaults(
  defineProps<{
    /** The turn's wall-clock duration, when known. */
    durationMs?: number;
    /** Whether the wrapped turn is still streaming. */
    streaming?: boolean;
  }>(),
  { durationMs: undefined, streaming: false },
);

const { t } = useI18n();

// The user's manual toggle. While streaming we force the fold open; when the
// turn settles we collapse it again (per the official web).
const manualOpen = ref(false);
const open = computed(() => props.streaming || manualOpen.value);

watch(
  () => props.streaming,
  (now, prev) => {
    if (prev && !now) manualOpen.value = false;
  },
);

function toggle(): void {
  manualOpen.value = !manualOpen.value;
}

const label = computed(() =>
  props.durationMs !== undefined
    ? t('conversation.fold.worked', { duration: formatDuration(props.durationMs) })
    : t('conversation.fold.workedUnknown'),
);
</script>

<template>
  <div class="turn-fold" :class="{ open, streaming }">
    <button
      type="button"
      class="tf-head"
      :aria-expanded="open"
      :aria-label="label"
      @click="toggle"
    >
      <span class="tf-sum" :title="label">{{ label }}</span>
      <Icon class="tf-car" :name="open ? 'chevron-down' : 'chevron-right'" size="sm" />
    </button>
    <div v-show="open" class="tf-body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.turn-fold {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  overflow: hidden;
}
.tf-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 30px;
  padding: 0 11px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font: var(--text-sm) var(--font-ui);
  text-align: left;
  cursor: pointer;
  user-select: none;
}
.tf-head:hover,
.turn-fold.open > .tf-head {
  background: var(--color-surface-sunken);
  color: var(--color-text);
}
.tf-head:focus-visible {
  outline: none;
  box-shadow: inset 0 0 0 2px var(--color-accent-soft);
}
.tf-sum {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tf-car {
  flex: none;
  color: var(--color-text-faint);
}
.tf-body {
  border-top: 1px solid var(--color-line);
  padding: 4px 0;
}
</style>
