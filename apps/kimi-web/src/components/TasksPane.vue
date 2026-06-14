<!-- apps/kimi-web/src/components/TasksPane.vue -->
<!-- TUI-inspired todo list: clean rows with status glyphs, strikethrough done,
     compact output, minimal chrome. Matches the terminal todo-panel style. -->
<script setup lang="ts">
import { reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TaskItem } from '../types';

defineProps<{ tasks: TaskItem[] }>();

const emit = defineEmits<{ cancel: [taskId: string] }>();

const { t } = useI18n();

// Which task rows are expanded (showing their output/detail). Click a row to
// toggle. Persisted only for the component's lifetime.
const expandedIds = reactive(new Set<string>());

function hasDetail(task: TaskItem): boolean {
  return Boolean((task.output && task.output.length > 0) || task.meta);
}

function toggle(task: TaskItem): void {
  if (!hasDetail(task)) return;
  if (expandedIds.has(task.id)) expandedIds.delete(task.id);
  else expandedIds.add(task.id);
}

function statusGlyph(state: string): string {
  switch (state) {
    case 'run': return '●';
    case 'done': return '✓';
    case 'fail': return '✗';
    default: return '○';
  }
}

function statusClass(state: string): string {
  switch (state) {
    case 'run': return 's-run';
    case 'done': return 's-done';
    case 'fail': return 's-fail';
    default: return 's-pending';
  }
}
</script>

<template>
  <div class="taskspane">
    <!-- TUI-style header: border line + title -->
    <div class="tp-head">
      <span class="tp-title">{{ t('tasks.tag') }}</span>
      <span class="tp-count">{{ tasks.length }}</span>
    </div>

    <div class="tp-list">
      <div v-if="tasks.length === 0" class="tp-empty">{{ t('tasks.emptyTasks') }}</div>

      <template v-else>
        <div
          v-for="task in tasks"
          :key="task.id"
          class="tp-row"
          :class="{ done: task.state === 'done', fail: task.state === 'fail', expandable: hasDetail(task) }"
        >
          <div class="tp-main" :role="hasDetail(task) ? 'button' : undefined" @click="toggle(task)">
            <span class="tp-glyph" :class="statusClass(task.state)">{{ statusGlyph(task.state) }}</span>
            <span class="tp-name">{{ task.name }}</span>
            <span class="tp-kind">{{ task.kind }}</span>
            <span class="tp-time">{{ task.timing }}</span>
            <button
              v-if="task.state === 'run'"
              class="tp-stop"
              @click.stop="emit('cancel', task.id)"
            >{{ t('tasks.stop') }}</button>
            <svg
              v-if="hasDetail(task)"
              class="tp-chevron"
              :class="{ open: expandedIds.has(task.id) }"
              viewBox="0 0 16 16" width="12" height="12"
              fill="none" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
            >
              <path d="M6 4l4 4-4 4" />
            </svg>
          </div>
          <template v-if="expandedIds.has(task.id)">
            <div v-if="task.meta" class="tp-meta">{{ task.meta }}</div>
            <div v-if="task.output" class="tp-out">
              <div v-for="(line, i) in task.output" :key="i">{{ line }}</div>
            </div>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.taskspane {
  padding: 14px 18px 10px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* TUI-style header: top border + bold title */
.tp-head {
  border-top: 1px solid var(--line);
  padding-top: 10px;
  margin-bottom: 8px;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.tp-title {
  color: var(--blue2);
  font-weight: 700;
  font-size: 12.5px;
  text-transform: capitalize;
}
.tp-count {
  color: var(--muted);
  font-size: 11px;
}

/* List: no cards, just clean rows. Shows ALL tasks and scrolls internally once
   they overflow the pane (no "+N more" cap) so nothing is silently hidden. */
.tp-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tp-row {
  padding: 4px 0;
}
.tp-row.done .tp-name {
  color: var(--muted);
  text-decoration: line-through;
}
.tp-row.fail .tp-name {
  color: var(--err);
}

.tp-main {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
}
.tp-row.expandable > .tp-main {
  cursor: pointer;
  border-radius: 4px;
}
.tp-row.expandable > .tp-main:hover {
  background: var(--panel2);
}
.tp-chevron {
  flex: none;
  color: var(--muted);
  transition: transform 0.12s;
}
.tp-chevron.open {
  transform: rotate(90deg);
}

/* Status glyph */
.tp-glyph {
  flex: none;
  font-size: 11px;
  width: 14px;
  text-align: center;
  user-select: none;
}
.tp-glyph.s-run   { color: var(--blue); font-weight: 700; }
.tp-glyph.s-done  { color: var(--ok); }
.tp-glyph.s-fail  { color: var(--err); }
.tp-glyph.s-pending { color: var(--faint); }

.tp-name {
  color: var(--ink);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tp-kind {
  flex: none;
  font-size: 10px;
  color: var(--dim);
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 0 5px;
}

.tp-time {
  flex: none;
  font-size: 11px;
  color: var(--muted);
}

.tp-stop {
  flex: none;
  background: none;
  border: 1px solid color-mix(in srgb, var(--err) 22%, var(--bg));
  border-radius: 3px;
  color: var(--err);
  font-size: 10.5px;
  padding: 1px 8px;
  cursor: pointer;
  font-family: var(--mono);
}
.tp-stop:hover { background: var(--panel); }

.tp-meta {
  margin-top: 3px;
  padding-left: 22px;
  font-size: 11px;
  color: var(--muted);
}

.tp-out {
  margin: 4px 0 0 22px;
  padding: 5px 8px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--dim);
  font-size: 11px;
  line-height: 1.55;
  overflow-x: auto;
}
.tp-out > div { white-space: pre; }

.tp-empty {
  padding: 24px 0;
  text-align: center;
  color: var(--faint);
  font-size: 13px;
}

/* Mobile */
@media (max-width: 640px) {
  .taskspane { padding: 14px 14px 16px; }
  .tp-main { flex-wrap: wrap; row-gap: 4px; }
  .tp-name { font-size: 13px; }
  .tp-stop {
    min-height: 32px;
    display: inline-flex;
    align-items: center;
    padding: 4px 12px;
    border-radius: 6px;
    font-size: 12px;
  }
  .tp-meta { padding-left: 0; font-size: 12px; }
  .tp-out { margin-left: 0; font-size: 12px; }
}
</style>
