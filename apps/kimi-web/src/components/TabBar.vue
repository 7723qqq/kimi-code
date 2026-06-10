<!-- apps/kimi-web/src/components/TabBar.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { PaneKey, TodoView } from '../types';

defineProps<{ active: PaneKey; runningTasks: number; changesCount?: number; todos?: TodoView[]; mobile?: boolean }>();
const emit = defineEmits<{ select: [pane: PaneKey] }>();

const { t } = useI18n();

const tabs: { key: PaneKey; labelKey: string }[] = [
  { key: 'chat', labelKey: 'sidebar.tabChat' },
  // TODO: temporarily hide the files tab until the feature is ready
  // { key: 'files', labelKey: 'sidebar.tabFiles' },
  { key: 'tasks', labelKey: 'sidebar.tabTasks' },
  { key: 'todo', labelKey: 'sidebar.tabTodo' },
];
</script>

<template>
  <div class="tabs" :class="{ mobile }">
    <div
      v-for="tab in tabs"
      :key="tab.key"
      class="tb"
      :class="{ on: active === tab.key }"
      @click="emit('select', tab.key)"
    >
      {{ t(tab.labelKey) }}
      <!-- TODO: restore when files tab is re-enabled -->
      <!-- <span v-if="tab.key === 'files' && (changesCount ?? 0) > 0" class="d"></span> -->
      <span v-if="tab.key === 'tasks' && runningTasks > 0" class="cnt">{{ runningTasks }}</span>
      <span v-if="tab.key === 'todo' && (todos?.length ?? 0) > 0" class="cnt">{{ (todos?.filter((t) => t.status === 'done').length ?? 0) }}/{{ todos!.length }}</span>
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
  font-size: 12.5px;
  color: var(--dim);
  border-right: 1px solid var(--line);
  cursor: pointer;
}
.tb:hover {
  background: var(--panel2);
}
.tb.on {
  /* Merge the active tab into the content surface below (dark-mode safe). */
  background: var(--bg);
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

/* ---- Mobile swap-strip: full-width mono tabs, 46px tall (≥44px tap) ---- */
.tabs.mobile {
  height: 46px;
  background: var(--bg);
}
.tabs.mobile .tb {
  flex: 1;
  justify-content: center;
  gap: 5px;
  padding: 0 2px;
  font-family: var(--mono);
  font-size: 14.5px;
  color: var(--muted);
  border-right: none;
  border-bottom: none;
  /* Three flex:1 tabs + a "10/12" pill must not blow up tiny screens. */
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.tabs.mobile .tb:hover { background: var(--bg); }
.tabs.mobile .tb.on {
  background: var(--bg);
  color: var(--blue);
  font-weight: 600;
}
/* Tasks → solid blue count pill (prototype .bdg). */
.tabs.mobile .cnt {
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--blue);
  color: var(--bg); /* on-accent text — readable in dark + mono-dark */
  border-radius: 9px;
  font-size: 12px;
  font-weight: 600;
}
/* Diff → small warn dot (prototype .dt). */
.tabs.mobile .d {
  width: 6px;
  height: 6px;
  background: var(--warn);
}

/* NOTE: Modern-theme tab styles live in src/style.css (global). Scoped
   `:global(html[data-theme=modern]) .tb` rules here did NOT win the cascade
   (tabs stayed square + bordered), so they were moved to the global sheet. */
</style>
