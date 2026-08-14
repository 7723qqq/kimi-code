<!-- apps/kimi-web/src/components/chat/SubagentCatalogPanel.vue -->
<!-- Subagent lineage catalog in the right-side detail layer: builds a tree from
     the live AppTask store (parentToolCallId links) and shows phase / duration
     per node; clicking a node opens the Agent detail panel. Ports
     deepseek-harness ui-subagent's catalog concept (MIT). -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AppTask } from '../../api/types';
import PanelHeader from '../ui/PanelHeader.vue';
import SubagentCatalogNode from './SubagentCatalogNode.vue';

const props = defineProps<{ tasks: AppTask[] }>();

const emit = defineEmits<{
  close: [];
  openAgent: [taskId: string];
}>();

const { t } = useI18n();

interface CatalogNode {
  task: AppTask;
  children: CatalogNode[];
}

function buildTree(tasks: AppTask[]): CatalogNode[] {
  const byId = new Map<string, CatalogNode>();
  for (const task of tasks) byId.set(task.id, { task, children: [] });
  const roots: CatalogNode[] = [];
  for (const task of tasks) {
    const node = byId.get(task.id);
    if (node === undefined) continue;
    const parent = task.parentToolCallId ? byId.get(task.parentToolCallId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const byTime = (a: CatalogNode, b: CatalogNode) =>
    a.task.createdAt.localeCompare(b.task.createdAt);
  const sort = (nodes: CatalogNode[]): void => {
    nodes.sort(byTime);
    for (const node of nodes) sort(node.children);
  };
  sort(roots);
  return roots;
}

const subagentTasks = computed(() =>
  props.tasks.filter((task) => task.kind === 'subagent'),
);

const tree = computed(() => buildTree(subagentTasks.value));
</script>

<template>
  <div class="sc">
    <PanelHeader
      :title="t('subagents.title')"
      :subtitle="t('subagents.agents', { count: subagentTasks.length })"
      :close-label="t('thinking.close')"
      @close="emit('close')"
    />

    <div class="sc-body">
      <div v-if="tree.length === 0" class="sc-empty">{{ t('subagents.empty') }}</div>
      <ul v-else class="sc-tree">
        <SubagentCatalogNode
          v-for="node in tree"
          :key="node.task.id"
          :node="node"
          @open-agent="emit('openAgent', $event)"
        />
      </ul>
    </div>
  </div>
</template>

<style scoped>
.sc {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg);
}
.sc-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-2) 0;
}
.sc-empty {
  padding: var(--space-4) var(--space-3);
  color: var(--color-text-muted);
  font: var(--text-sm) var(--font-ui);
}
.sc-tree {
  list-style: none;
  margin: 0;
  padding: 0;
}
</style>
