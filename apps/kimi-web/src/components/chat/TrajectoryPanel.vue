<!-- apps/kimi-web/src/components/chat/TrajectoryPanel.vue -->
<!-- Trajectory view container in the right-side detail layer: assembles the
     ported ui-trajectory pieces (overview timeline, virtualized ledger,
     inspector) around the raw-frame ledger (lib/trajectory/ledger.ts). -->
<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import type { LedgerFrame } from '../../lib/trajectory/ledger';
import {
  deriveTrajectoryLayout,
  type TrajectoryRecord,
  type TrajectoryTurnModel,
} from '../../lib/trajectory/records';
import {
  deriveTrajectoryTimeline,
  trajectoryTimelineFocusIndexes,
  type TrajectoryTimeRange,
  type TrajectoryTimelineMode,
} from '../../lib/trajectory/timeline';
import { TrajectorySearchIndex } from '../../lib/trajectory/search';
import Badge from '../ui/Badge.vue';
import PanelHeader from '../ui/PanelHeader.vue';
import SegmentedControl from '../ui/SegmentedControl.vue';
import TrajectoryLedger from '../trajectory/TrajectoryLedger.vue';
import TrajectoryTimeline from '../trajectory/TrajectoryTimeline.vue';
import TrajectoryInspector from '../trajectory/TrajectoryInspector.vue';

const props = defineProps<{ frames: readonly LedgerFrame[] | null }>();

const emit = defineEmits<{
  close: [];
  /** Clear the raw-frame ledger for the active session. */
  clear: [];
}>();

const { t } = useI18n();

const layout = computed(() => deriveTrajectoryLayout(props.frames ?? []));

const totalFrames = computed(() => props.frames?.length ?? 0);

const mode = ref<TrajectoryTimelineMode>('sequence');
const search = ref('');
const collapsedTurns = ref<Set<number>>(new Set());
const selectedId = ref<string | null>(null);
const focusRange = ref<TrajectoryTimeRange | null>(null);

const searchIndex = new TrajectorySearchIndex();
watchEffect(() => {
  searchIndex.update(layout.value);
});

// Search-filtered layout: keeps the turn/group structure, drops non-matching
// records when a query is active.
const filteredLayout = computed<readonly TrajectoryTurnModel[]>(() => {
  const query = search.value;
  if (query.trim() === '') return layout.value;
  const ids = searchIndex.search(query);
  if (ids === null) return layout.value;
  return layout.value
    .map((turn) => ({
      turn: turn.turn,
      groups: turn.groups
        // Spread the group so kind/step/seq/stats survive the filter —
        // the ledger's group header reads them for title + description.
        .map((group) => ({ ...group, records: group.records.filter((record) => ids.has(record.id)) }))
        .filter((group) => group.records.length > 0),
    }))
    .filter((turn) => turn.groups.length > 0);
});

const timelineModel = computed(() =>
  deriveTrajectoryTimeline(filteredLayout.value, mode.value),
);

/** Match count for the active query (null when not searching). */
const matchCount = computed<number | null>(() => {
  const query = search.value;
  if (query.trim() === '') return null;
  const ids = searchIndex.search(query);
  return ids === null ? null : ids.size;
});

const focusIds = computed<ReadonlySet<string>>(() => {
  if (focusRange.value === null) return new Set();
  const indexes = trajectoryTimelineFocusIndexes(
    filteredLayout.value,
    focusRange.value,
    mode.value,
  );
  const byIndex = new Map<number, string>();
  for (const turn of filteredLayout.value) {
    for (const group of turn.groups) {
      for (const record of group.records) {
        byIndex.set(record.index, record.id);
      }
    }
  }
  const ids = new Set<string>();
  for (const index of indexes) {
    const id = byIndex.get(index);
    if (id !== undefined) ids.add(id);
  }
  return ids;
});

const selectedRecord = computed<TrajectoryRecord | null>(() => {
  const id = selectedId.value;
  if (!id) return null;
  for (const turn of layout.value) {
    for (const group of turn.groups) {
      for (const record of group.records) {
        if (record.id === id) return record;
      }
    }
  }
  return null;
});

function onSelect(record: TrajectoryRecord): void {
  selectedId.value = record.id === selectedId.value ? null : record.id;
}

function onToggleTurn(turn: number): void {
  const next = new Set(collapsedTurns.value);
  if (next.has(turn)) next.delete(turn);
  else next.add(turn);
  collapsedTurns.value = next;
}

function onRangeChange(range: TrajectoryTimeRange | null): void {
  focusRange.value = range;
}

/** A timeline span was clicked — select its record (by record index). */
function onSpanSelect(index: number): void {
  for (const turn of filteredLayout.value) {
    for (const group of turn.groups) {
      for (const record of group.records) {
        if (record.index === index) {
          selectedId.value = record.id;
          return;
        }
      }
    }
  }
}

function collapseAll(): void {
  collapsedTurns.value = new Set(filteredLayout.value.map((turn) => turn.turn ?? -1));
}

function expandAll(): void {
  collapsedTurns.value = new Set();
}

function clearSelection(): void {
  selectedId.value = null;
}
</script>

<template>
  <div class="tv">
    <PanelHeader
      :title="t('trajectory.title')"
      :subtitle="t('trajectory.record') + ' × ' + totalFrames"
      :close-label="t('thinking.close')"
      @close="emit('close')"
    >
      <Badge variant="neutral" size="sm">{{ filteredLayout.length }} turns</Badge>
    </PanelHeader>

    <div class="tv-toolbar">
      <SegmentedControl
        :model-value="mode"
        :options="[
          { value: 'sequence', label: t('trajectory.modeSequence') },
          { value: 'duration', label: t('trajectory.modeDuration') },
          { value: 'time', label: t('trajectory.modeTime') },
          { value: 'actual', label: t('trajectory.modeActual') },
        ]"
        @update:model-value="mode = $event as TrajectoryTimelineMode"
      />
      <input
        v-model="search"
        class="tv-search"
        type="search"
        :placeholder="t('trajectory.searchPlaceholder')"
      />
      <div class="tv-actions">
        <span v-if="matchCount !== null" class="tv-match-count">
          {{ t('trajectory.matchCount', { count: matchCount }) }}
        </span>
        <button type="button" class="tv-action" @click="collapseAll">{{ t('trajectory.collapseAll') }}</button>
        <button type="button" class="tv-action" @click="expandAll">{{ t('trajectory.expandAll') }}</button>
        <button type="button" class="tv-action tv-action-danger" @click="emit('clear')">
          {{ t('trajectory.clearLedger') }}
        </button>
      </div>
    </div>

    <TrajectoryTimeline
      v-if="timelineModel"
      :model="timelineModel"
      :mode="mode"
      :has-selection="focusRange !== null"
      @range-change="onRangeChange"
      @span-select="onSpanSelect"
    />

    <div class="tv-body">
      <TrajectoryLedger
        :turns="filteredLayout"
        :selected-id="selectedId ?? undefined"
        :focus-ids="focusIds"
        :collapsed-turns="collapsedTurns"
        @select="onSelect"
        @toggle-turn="onToggleTurn"
      />
    </div>

    <TrajectoryInspector
      v-if="selectedRecord"
      :record="selectedRecord"
      @clear="clearSelection"
    />
  </div>
</template>

<style scoped>
.tv {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg);
}
.tv-toolbar {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--color-line);
}
.tv-search {
  width: 100%;
  box-sizing: border-box;
  padding: 4px 8px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font: var(--text-sm) var(--font-ui);
}
.tv-search:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
.tv-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.tv-match-count {
  color: var(--color-text-muted);
  font: var(--text-xs) var(--font-ui);
}
.tv-action {
  padding: 0;
  background: none;
  border: none;
  color: var(--color-accent);
  font: var(--text-xs) var(--font-ui);
  cursor: pointer;
}
.tv-action-danger {
  color: var(--color-danger);
}
.tv-action:hover {
  text-decoration: underline;
}
.tv-action:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
.tv-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
