<!-- apps/kimi-web/src/components/TabBar.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { ContentAlign, PaneKey } from '../types';

defineProps<{ active: PaneKey; runningTasks: number; changesCount?: number; align?: ContentAlign }>();
const emit = defineEmits<{ select: [pane: PaneKey]; setAlign: [align: ContentAlign] }>();

const { t } = useI18n();

const tabs: { key: PaneKey; label: string }[] = [
  { key: 'chat', label: '~/chat' },
  { key: 'diff', label: '~/diff' },
  { key: 'tasks', label: '~/tasks' },
  { key: 'files', label: '~/files' },
];
</script>

<template>
  <div class="tabs">
    <div
      v-for="t in tabs"
      :key="t.key"
      class="tb"
      :class="{ on: active === t.key }"
      @click="emit('select', t.key)"
    >
      {{ t.label }}
      <span v-if="t.key === 'diff' && (changesCount ?? 0) > 0" class="d"></span>
      <span v-if="t.key === 'tasks'" class="cnt">{{ runningTasks }}</span>
    </div>

    <!-- Content alignment toggle (right side): left-aligned vs centered -->
    <div class="align" role="group" :aria-label="t('layout.alignLabel')">
      <button
        type="button"
        class="align-btn"
        :class="{ on: (align ?? 'center') === 'left' }"
        :title="t('layout.alignLeft')"
        :aria-label="t('layout.alignLeft')"
        :aria-pressed="(align ?? 'center') === 'left'"
        @click="emit('setAlign', 'left')"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
          <path d="M2 4h12M2 8h8M2 12h10" />
        </svg>
      </button>
      <button
        type="button"
        class="align-btn"
        :class="{ on: (align ?? 'center') === 'center' }"
        :title="t('layout.alignCenter')"
        :aria-label="t('layout.alignCenter')"
        :aria-pressed="(align ?? 'center') === 'center'"
        @click="emit('setAlign', 'center')"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
          <path d="M2 4h12M4 8h8M3 12h10" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.tabs {
  height: 32px;
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.tb {
  padding: 0 14px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--dim);
  border-right: 1px solid var(--line);
  cursor: pointer;
}
.tb:hover {
  background: var(--panel2);
}
.tb.on {
  background: #fff;
  color: var(--blue2);
  font-weight: 600;
}
.d {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
}
.cnt {
  background: var(--soft);
  color: var(--blue2);
  border-radius: 8px;
  padding: 0 6px;
  font-size: 10px;
  font-weight: 600;
}

/* Content alignment toggle — small segmented control, pushed to the right */
.align {
  margin-left: auto;
  display: flex;
  align-items: center;
  padding: 0 8px;
}
.align-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  background: none;
  border: 1px solid var(--line);
  color: var(--faint);
  cursor: pointer;
  padding: 0;
}
.align-btn:first-child { border-radius: 3px 0 0 3px; }
.align-btn:last-child { border-radius: 0 3px 3px 0; margin-left: -1px; }
.align-btn:hover { color: var(--ink); border-color: var(--bd); z-index: 1; }
.align-btn.on {
  color: var(--blue2);
  border-color: var(--bd);
  background: var(--soft);
  z-index: 1;
}
</style>
