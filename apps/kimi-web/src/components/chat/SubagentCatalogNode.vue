<!-- apps/kimi-web/src/components/chat/SubagentCatalogNode.vue -->
<!-- Recursive node of the subagent lineage catalog. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

import type { AppSubagentPhase, AppTask } from '../../api/types';
import Badge from '../ui/Badge.vue';
import StatusDot from '../ui/StatusDot.vue';

interface CatalogNode {
  task: AppTask;
  children: CatalogNode[];
}

const props = defineProps<{ node: CatalogNode }>();

const emit = defineEmits<{ openAgent: [taskId: string] }>();

const { t } = useI18n();

const phase = computed<AppSubagentPhase>(() => {
  const task = props.node.task;
  return task.subagentPhase ?? (task.status === 'running' ? 'working' : 'completed');
});

const duration = computed<string | null>(() => {
  const task = props.node.task;
  const start = task.startedAt ? Date.parse(task.startedAt) : NaN;
  if (!Number.isFinite(start)) return null;
  const end = task.completedAt ? Date.parse(task.completedAt) : Date.now();
  const seconds = Math.max(0, (end - start) / 1000);
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`
    : `${seconds.toFixed(1)}s`;
});

const label = computed(() => {
  const task = props.node.task;
  return task.subagentType && task.subagentType !== 'agent'
    ? task.subagentType
    : task.description || task.id;
});
</script>

<template>
  <li class="sc-node">
    <button type="button" class="sc-row" @click="emit('openAgent', node.task.id)">
      <StatusDot :status="phase" />
      <span class="sc-name" :title="node.task.id">{{ label }}</span>
      <Badge v-if="node.task.swarmIndex !== undefined" variant="info" size="sm" class="sc-swarm"
        >{{ t('subagents.swarm') }} {{ node.task.swarmIndex }}</Badge
      >
      <Badge variant="neutral" size="sm" class="sc-phase">{{
        t(`subagents.phase.${phase}`)
      }}</Badge>
      <span v-if="duration" class="sc-duration">{{ duration }}</span>
    </button>
    <ul v-if="node.children.length > 0" class="sc-tree sc-children">
      <SubagentCatalogNode
        v-for="child in node.children"
        :key="child.task.id"
        :node="child"
        @open-agent="emit('openAgent', $event)"
      />
    </ul>
  </li>
</template>

<style scoped>
.sc-tree {
  list-style: none;
  margin: 0;
  padding: 0;
}
.sc-children {
  margin-left: var(--space-3);
  padding-left: var(--space-2);
  border-left: 1px solid var(--color-line);
}
.sc-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: 5px var(--space-3);
  background: none;
  border: none;
  color: var(--color-text);
  font: var(--text-sm) var(--font-ui);
  cursor: pointer;
  text-align: left;
  min-width: 0;
}
.sc-row:hover {
  background: var(--color-surface);
}
.sc-row:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}
.sc-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sc-swarm,
.sc-phase {
  flex: none;
}
.sc-duration {
  flex: none;
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-mono);
}
</style>
