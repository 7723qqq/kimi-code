<!-- TrajectoryLedger.vue — virtualized record ledger: turn boundaries, group
     headers, one row per record (#N · kind · summary · duration), selection,
     collapse, and interval-focus highlighting. Ported from deepseek-harness
     ui-trajectory's virtualized TrajectoryTable (MIT); fixed row heights,
     overscan windowing, stable keys. -->
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TrajectoryRecord, TrajectoryTurnModel } from '../../lib/trajectory/records';
import {
  groupTrajectoryVirtualRows,
  trajectoryVirtualWindow,
} from '../../lib/trajectory/virtualRows';

const props = defineProps<{
  turns: readonly TrajectoryTurnModel[];
  selectedId?: string;
  focusIds?: ReadonlySet<string>;
  collapsedTurns?: ReadonlySet<number>;
}>();

const emit = defineEmits<{
  select: [record: TrajectoryRecord];
  toggleTurn: [turn: number];
}>();

const { t } = useI18n();

interface FlatRecord extends TrajectoryRecord {
  turnTitle: string;
  groupTitle: string;
  firstInTurn: boolean;
  firstInGroup: boolean;
  collapsedSummary?: 'turn';
}

const flat = computed<readonly FlatRecord[]>(() => {
  const out: FlatRecord[] = [];
  for (const turn of props.turns) {
    const turnTitle =
      turn.turn === null
        ? t('trajectory.betweenTurns')
        : t('trajectory.turn', { turn: turn.turn });
    if (props.collapsedTurns?.has(turn.turn ?? -1) === true) {
      const count = turn.groups.reduce((sum, g) => sum + g.records.length, 0);
      out.push({
        id: `turn-summary\u0000${turn.turn ?? 'between'}`,
        index: 0,
        kind: 'system',
        turn: turn.turn,
        group: turnTitle,
        text: `${turnTitle} — ${count} records`,
        timeSeconds: null,
        startedAt: null,
        turnTitle,
        groupTitle: turnTitle,
        firstInTurn: true,
        firstInGroup: true,
        collapsedSummary: 'turn',
      });
      continue;
    }
    let firstInTurn = true;
    for (const group of turn.groups) {
      let firstInGroup = true;
      for (const record of group.records) {
        out.push({
          ...record,
          turnTitle,
          groupTitle: group.title,
          firstInTurn,
          firstInGroup,
        });
        firstInTurn = false;
        firstInGroup = false;
      }
    }
  }
  return out;
});

const rows = computed(() => groupTrajectoryVirtualRows(flat.value));

const scrollTop = ref(0);
const viewportHeight = ref(400);
const viewport = ref<HTMLElement | null>(null);

const windowModel = computed(() =>
  trajectoryVirtualWindow(rows.value, scrollTop.value, viewportHeight.value),
);

function onScroll(event: Event): void {
  const el = event.currentTarget as HTMLElement;
  scrollTop.value = el.scrollTop;
}

function onResize(): void {
  if (viewport.value !== null) viewportHeight.value = viewport.value.clientHeight;
}

let resizeObserver: ResizeObserver | undefined;
watch(viewport, (el) => {
  if (el !== null) {
    viewportHeight.value = el.clientHeight;
    resizeObserver ??= new ResizeObserver(onResize);
    resizeObserver.observe(el);
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
  resizeObserver = undefined;
});

const rowOffsets = computed(() => {
  let acc = 0;
  const offsets: number[] = [];
  for (const row of rows.value) {
    offsets.push(acc);
    acc += row.height;
  }
  return offsets;
});

const visible = computed(() => {
  const { start, end, totalHeight } = windowModel.value;
  const items: Array<{ row: (typeof rows.value)[number]; offset: number }> = [];
  for (let i = start; i < end; i += 1) {
    const row = rows.value[i];
    if (row === undefined) continue;
    items.push({ row, offset: rowOffsets.value[i] ?? 0 });
  }
  return { items, totalHeight };
});
</script>

<template>
  <div ref="viewport" class="trajectory-ledger" @scroll.passive="onScroll">
    <div class="trajectory-ledger__inner" :style="{ height: visible.totalHeight + 'px' }">
      <div
        v-for="item in visible.items"
        :key="item.row.key"
        class="trajectory-ledger__row"
        :style="{ transform: 'translateY(' + item.offset + 'px)' }"
      >
        <template v-for="entry in item.row.entries" :key="entry.record.id">
          <div v-if="(entry.record as FlatRecord).firstInTurn" class="trajectory-ledger__turn">
            {{ (entry.record as FlatRecord).turnTitle }}
            <button
              type="button"
              class="trajectory-ledger__collapse"
              @click.stop="emit('toggleTurn', entry.record.turn ?? -1)"
            >
              {{ (props.collapsedTurns?.has(entry.record.turn ?? -1) ?? false) ? '▶' : '▼' }}
            </button>
          </div>
          <div
            v-if="(entry.record as FlatRecord).firstInGroup && (entry.record as FlatRecord).firstInTurn === false"
            class="trajectory-ledger__group"
          >
            {{ (entry.record as FlatRecord).groupTitle }}
          </div>
          <div
            v-if="entry.record.requestOnly !== true"
            class="trajectory-ledger__record"
            :class="[
              entry.record.kind,
              {
                selected: entry.record.id === props.selectedId,
                focused: props.focusIds?.has(entry.record.id) === true,
                error: entry.record.isError === true,
              },
            ]"
            role="button"
            tabindex="0"
            @click="emit('select', entry.record)"
            @keydown.enter="emit('select', entry.record)"
          >
            <span class="trajectory-ledger__index">#{{ entry.record.index }}</span>
            <span class="trajectory-ledger__kind">{{ entry.record.kind }}</span>
            <span class="trajectory-ledger__text">{{ entry.record.text }}</span>
            <span class="trajectory-ledger__duration">
              {{ entry.record.timeSeconds === null ? '' : Math.round(entry.record.timeSeconds) + 's' }}
            </span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trajectory-ledger {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border-top: 1px solid var(--color-line);
}
.trajectory-ledger__inner {
  position: relative;
  width: 100%;
}
.trajectory-ledger__row {
  position: absolute;
  left: 0;
  right: 0;
  will-change: transform;
}
.trajectory-ledger__turn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  height: 22px;
  padding: 0 var(--space-3);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.trajectory-ledger__collapse {
  background: none;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: var(--text-xs);
}
.trajectory-ledger__group {
  box-sizing: border-box;
  height: 18px;
  padding: 0 var(--space-3);
  color: var(--color-text-faint);
  font-size: var(--text-xs);
}
.trajectory-ledger__record {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  box-sizing: border-box;
  height: 30px;
  padding: 0 var(--space-3);
  cursor: pointer;
  border-left: 2px solid transparent;
}
.trajectory-ledger__record:hover { background: var(--color-hover); }
.trajectory-ledger__record.selected {
  background: var(--color-surface-raised);
  border-left-color: var(--color-accent);
}
.trajectory-ledger__record.focused { background: var(--color-accent-soft); }
.trajectory-ledger__record.error .trajectory-ledger__text { color: var(--color-danger); }
.trajectory-ledger__index {
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.trajectory-ledger__kind {
  min-width: 58px;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.trajectory-ledger__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--text-sm);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trajectory-ledger__duration {
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
</style>
