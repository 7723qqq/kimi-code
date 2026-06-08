<!-- apps/kimi-web/src/components/TasksPane.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TaskItem } from '../types';

const props = defineProps<{ tasks: TaskItem[] }>();

const emit = defineEmits<{ cancel: [taskId: string] }>();

const { t } = useI18n();

const stopLabel = computed(() => t('tasks.stop'));

const summary = () => {
  const run = props.tasks.filter((t) => t.state === 'run').length;
  const done = props.tasks.filter((t) => t.state === 'done').length;
  return t('tasks.summary', { run, done });
};
</script>

<template>
  <div class="taskspane">
    <div class="pvhead"><span class="tag">{{ t('tasks.tag') }}</span><span class="f">{{ summary() }}</span></div>
    <div class="tfull">
      <div v-for="t in tasks" :key="t.id" class="trow">
        <div class="top">
          <span class="tdot" :class="t.state"></span>
          <span class="tn">{{ t.name }}</span>
          <span class="badge">{{ t.kind }}</span>
          <span class="ts">{{ t.timing }}</span>
          <span v-if="t.state === 'run'" class="stop" @click="emit('cancel', t.id)">{{ stopLabel }}</span>
        </div>
        <div v-if="t.meta" class="meta">{{ t.meta }}</div>
        <div v-if="t.output" class="out">
          <div v-for="(line, i) in t.output" :key="i">{{ line }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pvhead {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  font-size: 11.5px;
  color: var(--dim);
}
.tag { color: var(--blue2); font-weight: 700; }
.f { color: var(--ink); font-weight: 600; }
.tfull { padding: 8px 10px; }
.trow {
  padding: 9px 10px;
  border: 1px solid var(--line);
  border-radius: 4px;
  margin-bottom: 6px;
  background: #fff;
}
.top { display: flex; align-items: center; gap: 9px; }
.tdot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.tdot.run { background: var(--blue); box-shadow: 0 0 0 3px var(--soft); }
.tdot.done { background: var(--ok); }
.tdot.fail { background: var(--err); }
.tn { color: var(--ink); font-size: 12.5px; font-weight: 600; }
.badge { font-size: 10.5px; color: var(--dim); border: 1px solid var(--line); border-radius: 3px; padding: 0 6px; }
.ts { margin-left: auto; color: var(--muted); font-size: 11px; }
.stop { margin-left: 8px; color: var(--err); border: 1px solid #f0c9c9; border-radius: 3px; padding: 1px 8px; font-size: 10.5px; cursor: pointer; }
.meta { padding-left: 18px; margin-top: 5px; color: var(--muted); font-size: 11px; }
.out {
  margin: 6px 0 0 18px;
  padding: 7px 9px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--dim);
  font-size: 11px;
  line-height: 1.6;
}
</style>
