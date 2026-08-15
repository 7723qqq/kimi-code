<!-- TrajectoryLedger.vue — virtualized record ledger: turn boundaries, group
     headers (localized Step/Message/Compaction + wall-clock & tool histogram
     description), one row per record (#N · kind · summary · duration),
     selection, collapse, interval-focus highlighting, keyboard navigation,
     and tail-follow (sticks to the newest records until the user scrolls
     up). Ported from deepseek-harness ui-trajectory's virtualized
     TrajectoryTable (MIT); turn/group headers own their rows so virtual
     offsets stay exact. -->
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import type {
  TrajectoryGroupModel,
  TrajectoryRecord,
  TrajectoryTurnModel,
} from '../../lib/trajectory/records';
import { trajectoryVirtualWindow } from '../../lib/trajectory/virtualRows';

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

const TURN_HEADER_HEIGHT = 22;
const GROUP_HEADER_HEIGHT = 18;
const RECORD_HEIGHT = 30;
const SUMMARY_HEIGHT = 20;

interface DisplayRow {
  readonly key: string;
  readonly height: number;
  readonly kind: 'turn' | 'group' | 'record' | 'summary';
  readonly record?: TrajectoryRecord;
  readonly turn?: number | null;
  readonly title?: string;
  readonly desc?: string;
}

function groupTitle(group: TrajectoryGroupModel): string {
  if (group.kind === 'step') return t('trajectory.step', { step: group.step ?? 0 });
  if (group.kind === 'compaction') {
    return `${t('trajectory.compaction')} #${group.seq ?? 0}`;
  }
  return t('trajectory.message');
}

/** "1.5s · bash×2 · read×1" — wall-clock span plus the tool histogram. */
function groupDesc(group: TrajectoryGroupModel): string {
  const parts: string[] = [];
  if (group.stats.wallMs !== null)
    parts.push(`${Math.max(1, Math.round(group.stats.wallMs / 100) / 10)}s`);
  const tools = [...group.stats.tools.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([name, count]) => (count === 1 ? name : `${name}×${count}`));
  parts.push(...tools);
  return parts.join(' · ');
}

/** Localized kind label for the record row's kind column. */
function kindLabel(kind: TrajectoryRecord['kind']): string {
  switch (kind) {
    case 'tool':
    case 'subtool':
      return t('trajectory.tool');
    case 'assistant':
      return t('trajectory.assistant');
    case 'user':
      return t('trajectory.user');
    case 'system':
      return t('trajectory.system');
    case 'compacted':
      return t('trajectory.compacted');
  }
}

const rows = computed<readonly DisplayRow[]>(() => {
  const out: DisplayRow[] = [];
  for (const turn of props.turns) {
    const turnKey = turn.turn === null ? 'between' : String(turn.turn);
    const turnTitle =
      turn.turn === null ? t('trajectory.betweenTurns') : t('trajectory.turn', { turn: turn.turn });
    if (props.collapsedTurns?.has(turn.turn ?? -1) === true) {
      const count = turn.groups.reduce((sum, g) => sum + g.records.length, 0);
      out.push({
        key: `turn-summary\u0000${turnKey}`,
        height: SUMMARY_HEIGHT,
        kind: 'summary',
        turn: turn.turn,
        title: `${turnTitle} · ${t('trajectory.recordsCount', { count })}`,
      });
      continue;
    }
    let firstInTurn = true;
    for (const group of turn.groups) {
      let firstInGroup = true;
      const title = groupTitle(group);
      const desc = groupDesc(group);
      for (const record of group.records) {
        if (record.requestOnly === true) continue;
        if (firstInTurn) {
          out.push({
            key: `turn\u0000${turnKey}`,
            height: TURN_HEADER_HEIGHT,
            kind: 'turn',
            turn: turn.turn,
            title: turnTitle,
          });
        }
        if (firstInGroup) {
          out.push({
            key: `group\u0000${turnKey}\u0000${record.group}`,
            height: GROUP_HEADER_HEIGHT,
            kind: 'group',
            title,
            desc,
          });
        }
        out.push({
          key: `record\u0000${record.id}`,
          height: RECORD_HEIGHT,
          kind: 'record',
          record,
        });
        firstInTurn = false;
        firstInGroup = false;
      }
    }
  }
  return out;
});

/** Records in display order — the keyboard navigation sequence. */
const navRecords = computed(() =>
  rows.value.flatMap((row) =>
    row.kind === 'record' && row.record !== undefined ? [row.record] : [],
  ),
);

const scrollTop = ref(0);
const viewportHeight = ref(400);
const viewport = ref<HTMLElement | null>(null);

const windowModel = computed(() =>
  trajectoryVirtualWindow(rows.value, scrollTop.value, viewportHeight.value),
);

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
  const items: Array<{ row: DisplayRow; offset: number }> = [];
  for (let i = start; i < end; i += 1) {
    const row = rows.value[i];
    if (row === undefined) continue;
    items.push({ row, offset: rowOffsets.value[i] ?? 0 });
  }
  return { items, totalHeight };
});

// --- tail-follow: stick to the newest records while the user is at the
// bottom; scrolling up pauses it (dsh's tail-follow semantics).
const followTail = ref(true);

function onScroll(event: Event): void {
  const el = event.currentTarget as HTMLElement;
  scrollTop.value = el.scrollTop;
  followTail.value = el.scrollHeight - el.scrollTop - el.clientHeight < 16;
}

function scrollToBottom(): void {
  if (viewport.value !== null) viewport.value.scrollTop = viewport.value.scrollHeight;
}

watch(
  () => rows.value.length,
  () => {
    if (followTail.value) void nextTick(scrollToBottom);
  },
);

onMounted(() => {
  void nextTick(scrollToBottom);
});

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

// --- keyboard navigation: ↑/↓ move selection record by record, Home/End
// jump to the first/last record.
function moveSelection(delta: 1 | -1): void {
  const list = navRecords.value;
  if (list.length === 0) return;
  const current = list.findIndex((record) => record.id === props.selectedId);
  const next =
    current === -1
      ? delta === 1
        ? 0
        : list.length - 1
      : Math.min(list.length - 1, Math.max(0, current + delta));
  const record = list[next];
  if (record !== undefined && record.id !== props.selectedId) emit('select', record);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveSelection(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveSelection(-1);
  } else if (event.key === 'Home') {
    event.preventDefault();
    const first = navRecords.value[0];
    if (first !== undefined && first.id !== props.selectedId) emit('select', first);
  } else if (event.key === 'End') {
    event.preventDefault();
    const last = navRecords.value.at(-1);
    if (last !== undefined && last.id !== props.selectedId) emit('select', last);
  }
}

// Keep the selected record inside the viewport (keyboard navigation and
// timeline span clicks both land here); no-op when already visible.
watch(
  () => props.selectedId,
  (id) => {
    if (id === undefined) return;
    void nextTick(() => {
      const el = viewport.value;
      if (el === null) return;
      const index = rows.value.findIndex((row) => row.kind === 'record' && row.record?.id === id);
      if (index === -1) return;
      const offset = rowOffsets.value[index] ?? 0;
      const bottom = offset + RECORD_HEIGHT;
      if (offset < el.scrollTop || bottom > el.scrollTop + el.clientHeight) {
        el.scrollTop = Math.max(0, offset - el.clientHeight / 2);
      }
    });
  },
);
</script>

<template>
  <div
    ref="viewport"
    class="trajectory-ledger"
    tabindex="0"
    @scroll.passive="onScroll"
    @keydown="onKeydown"
  >
    <div v-if="rows.length === 0" class="trajectory-ledger__empty">
      {{ t('trajectory.noRecords') }}
    </div>
    <div v-else class="trajectory-ledger__inner" :style="{ height: visible.totalHeight + 'px' }">
      <div
        v-for="item in visible.items"
        :key="item.row.key"
        class="trajectory-ledger__row"
        :style="{ transform: 'translateY(' + item.offset + 'px)', height: item.row.height + 'px' }"
      >
        <div v-if="item.row.kind === 'turn'" class="trajectory-ledger__turn">
          <span>{{ item.row.title }}</span>
          <button
            type="button"
            class="trajectory-ledger__collapse"
            @click.stop="emit('toggleTurn', item.row.turn ?? -1)"
          >
            ▼
          </button>
        </div>
        <div v-else-if="item.row.kind === 'group'" class="trajectory-ledger__group">
          <span class="trajectory-ledger__group-title">{{ item.row.title }}</span>
          <span v-if="item.row.desc" class="trajectory-ledger__group-desc">{{
            item.row.desc
          }}</span>
        </div>
        <div
          v-else-if="item.row.kind === 'summary'"
          class="trajectory-ledger__summary"
          role="button"
          tabindex="0"
          @click="emit('toggleTurn', item.row.turn ?? -1)"
          @keydown.enter="emit('toggleTurn', item.row.turn ?? -1)"
        >
          <span>{{ item.row.title }}</span>
          <button type="button" class="trajectory-ledger__collapse">▶</button>
        </div>
        <div
          v-else-if="item.row.record"
          class="trajectory-ledger__record"
          :class="[
            item.row.record.kind,
            {
              selected: item.row.record.id === props.selectedId,
              focused: props.focusIds?.has(item.row.record.id) === true,
              error: item.row.record.isError === true,
            },
          ]"
          role="button"
          tabindex="0"
          @click="emit('select', item.row.record)"
          @keydown.enter="emit('select', item.row.record)"
        >
          <span class="trajectory-ledger__index">#{{ item.row.record.index }}</span>
          <span class="trajectory-ledger__kind">{{ kindLabel(item.row.record.kind) }}</span>
          <span class="trajectory-ledger__text">
            <span>{{ item.row.record.text }}</span>
            <span
              v-if="item.row.record.result !== undefined"
              class="trajectory-ledger__result"
              :class="{ error: item.row.record.isError === true }"
              >→ {{ item.row.record.result }}</span
            >
          </span>
          <span v-if="item.row.record.kind === 'assistant'" class="trajectory-ledger__tokens">
            <span v-if="item.row.record.input !== undefined">{{ item.row.record.input }}</span>
            <span v-if="item.row.record.output !== undefined">{{ item.row.record.output }}</span>
            <span v-if="item.row.record.think !== undefined">{{ item.row.record.think }}</span>
          </span>
          <span class="trajectory-ledger__duration">
            {{
              item.row.record.timeSeconds === null
                ? ''
                : Math.round(item.row.record.timeSeconds) + 's'
            }}
          </span>
        </div>
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
.trajectory-ledger:focus-visible {
  outline: none;
}
.trajectory-ledger__empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: var(--space-4);
  box-sizing: border-box;
  color: var(--color-text-faint);
  font-size: var(--text-sm);
  text-align: center;
}
.trajectory-ledger__inner {
  position: relative;
  width: 100%;
}
.trajectory-ledger__row {
  position: absolute;
  left: 0;
  right: 0;
  overflow: hidden;
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
  display: flex;
  align-items: center;
  gap: var(--space-2);
  box-sizing: border-box;
  height: 18px;
  padding: 0 var(--space-3);
}
.trajectory-ledger__group-title {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
}
.trajectory-ledger__group-desc {
  overflow: hidden;
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  opacity: 0.8;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trajectory-ledger__summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-sizing: border-box;
  height: 20px;
  padding: 0 var(--space-3);
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: var(--text-xs);
}
.trajectory-ledger__summary:hover {
  background: var(--color-hover);
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
.trajectory-ledger__record:hover {
  background: var(--color-hover);
}
.trajectory-ledger__record.selected {
  background: var(--color-surface-raised);
  border-left-color: var(--color-accent);
}
.trajectory-ledger__record.focused {
  background: var(--color-accent-soft);
}
.trajectory-ledger__record.error .trajectory-ledger__text {
  color: var(--color-danger);
}
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
.trajectory-ledger__result {
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.trajectory-ledger__result.error {
  color: var(--color-danger);
}
.trajectory-ledger__tokens {
  display: inline-flex;
  gap: var(--space-2);
  flex: none;
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.trajectory-ledger__duration {
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
</style>
