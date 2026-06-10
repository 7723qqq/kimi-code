<!-- apps/kimi-web/src/components/TasksCard.vue -->
<!-- Compact background-task card for the wide-screen floating stack (top-right
     of the conversation pane, codex-style). Shows the running tasks only;
     clicking the header jumps to the full ~/tasks tab. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TaskItem } from '../types';

const MAX_ROWS = 4;

const props = defineProps<{
  tasks: TaskItem[];
}>();

const emit = defineEmits<{
  open: [];
}>();

const { t } = useI18n();

const running = computed(() => props.tasks.filter((tk) => tk.state === 'run'));
const shown = computed(() => running.value.slice(0, MAX_ROWS));
const overflow = computed(() => running.value.length - shown.value.length);
</script>

<template>
  <div class="tasks-card">
    <button class="tk-head" type="button" :title="t('tasks.openTab')" @click="emit('open')">
      <span class="tk-dot" aria-hidden="true" />
      <span class="tk-title">{{ t('sidebar.tabTasks') }}</span>
      <span class="tk-count">{{ running.length }}</span>
    </button>
    <div class="tk-list">
      <div v-for="tk in shown" :key="tk.id" class="tk-row">
        <span class="tk-name">{{ tk.name }}</span>
        <span class="tk-time">{{ tk.timing }}</span>
      </div>
      <div v-if="overflow > 0" class="tk-more">+{{ overflow }}</div>
    </div>
  </div>
</template>

<style scoped>
.tasks-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 3px;
  font-size: 13px;
  overflow: hidden;
}

.tk-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.4;
}
.tk-head:hover { color: var(--ink); }
.tk-title { font-weight: 700; letter-spacing: 0.04em; }
.tk-count { color: var(--faint); }

.tk-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
  animation: tk-pulse 1.4s ease-in-out infinite;
}
@keyframes tk-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.tk-list {
  border-top: 1px solid var(--line);
  padding: 4px 10px 6px;
}
.tk-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
  line-height: 1.5;
}
.tk-name {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink);
}
.tk-time {
  flex: none;
  color: var(--faint);
  font-family: var(--mono);
  font-size: 11px;
}
.tk-more {
  padding: 2px 0;
  color: var(--faint);
  font-family: var(--mono);
  font-size: 11px;
}
</style>
