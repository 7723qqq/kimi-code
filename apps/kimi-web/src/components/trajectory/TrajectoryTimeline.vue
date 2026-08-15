<!-- TrajectoryTimeline.vue — the overview strip above the trajectory ledger.
     Projects records into the active domain (sequence / duration / time /
     actual) on three lanes; turn boundaries are marked; hover shows #index,
     kind, label, duration and (timed modes) the wall clock; drag selects an
     inclusive interval; a click (no drag) selects the hovered record; double
     click or the toolbar buttons clear the selection / reset the zoom; wheel
     zooms the time domain around the pointer. Ported from deepseek-harness
     ui-trajectory TrajectoryTimeline (MIT). -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

import type {
  TrajectoryTimeRange,
  TrajectoryTimelineMode,
  TrajectoryTimelineModel,
  TrajectoryTimelineSpan,
} from '../../lib/trajectory/timeline';
import { formatDurationMillis } from '../../lib/trajectory/timeline';

const props = defineProps<{
  model: TrajectoryTimelineModel;
  mode: TrajectoryTimelineMode;
  /** Whether an interval selection is active (drives the clear button). */
  hasSelection?: boolean;
}>();

const emit = defineEmits<{
  rangeChange: [range: TrajectoryTimeRange | null];
  /** A span was clicked without dragging — select its record. */
  spanSelect: [index: number];
}>();

const { t } = useI18n();

// Visible domain window (zoom). Initialised to the full domain; reset when
// the model changes (mode switch, search filter, ledger growth).
const viewStart = ref(props.model.start);
const viewEnd = ref(props.model.end);

watch(
  () => props.model,
  (model) => {
    viewStart.value = model.start;
    viewEnd.value = model.end;
    drag.value = null;
  },
);

// Active drag selection in domain coordinates.
const drag = ref<{ anchor: number; current: number } | null>(null);
const hovered = ref<TrajectoryTimelineSpan | null>(null);

const domainWidth = computed(() => Math.max(1, viewEnd.value - viewStart.value));

const zoomed = computed(
  () => viewStart.value !== props.model.start || viewEnd.value !== props.model.end,
);

function toDomain(clientX: number, el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  const ratio = (clientX - rect.left) / Math.max(1, rect.width);
  return viewStart.value + ratio * domainWidth.value;
}

function spanStyle(span: TrajectoryTimelineSpan): Record<string, string> {
  const left = ((span.start - viewStart.value) / domainWidth.value) * 100;
  const width = Math.max(0.3, ((span.end - span.start) / domainWidth.value) * 100);
  return { left: `${left}%`, width: `${width}%` };
}

function onPointerDown(event: PointerEvent, el: HTMLElement): void {
  if (event.button !== 0) return;
  const anchor = toDomain(event.clientX, el);
  drag.value = { anchor, current: anchor };
  emit('rangeChange', { start: anchor, end: anchor });
  const onMove = (move: PointerEvent): void => {
    if (drag.value === null) return;
    drag.value.current = toDomain(move.clientX, el);
    const { anchor: from, current } = drag.value;
    emit('rangeChange', {
      start: Math.min(from, current),
      end: Math.max(from, current),
    });
  };
  const onUp = (): void => {
    // A press-release without movement is a click: select the hovered span's
    // record instead of leaving a zero-width interval behind.
    const moved = drag.value !== null && Math.abs(drag.value.current - drag.value.anchor) > 2;
    if (!moved && hovered.value !== null) {
      emit('spanSelect', hovered.value.index);
      emit('rangeChange', null);
    }
    drag.value = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

function onWheel(event: WheelEvent, el: HTMLElement): void {
  event.preventDefault();
  const rect = el.getBoundingClientRect();
  const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
  const anchor = viewStart.value + ratio * domainWidth.value;
  const factor = event.deltaY < 0 ? 0.8 : 1.25;
  const nextWidth = Math.min(
    props.model.end - props.model.start,
    Math.max(1, domainWidth.value * factor),
  );
  let nextStart = anchor - ratio * nextWidth;
  nextStart = Math.max(props.model.start, Math.min(props.model.end - nextWidth, nextStart));
  viewStart.value = nextStart;
  viewEnd.value = nextStart + nextWidth;
}

function resetView(): void {
  viewStart.value = props.model.start;
  viewEnd.value = props.model.end;
}

function onDblclick(): void {
  resetView();
  emit('rangeChange', null);
}

function turnBoundaryStyle(time: number): Record<string, string> {
  return { left: `${((time - viewStart.value) / domainWidth.value) * 100}%` };
}

const hint = computed(() => {
  const span = hovered.value;
  if (span === null) return '';
  const clock =
    props.mode !== 'sequence' && span.startedAt !== null
      ? ` · ${new Date(span.startedAt).toLocaleTimeString()}`
      : '';
  return `#${span.index} ${span.kind.toUpperCase()} · ${span.label} · ${formatDurationMillis(span.end - span.start)}${clock}`;
});
</script>

<template>
  <div
    class="trajectory-timeline"
    :data-mode="mode"
    @pointerdown="onPointerDown($event, $event.currentTarget as HTMLElement)"
    @wheel.prevent="onWheel($event, $event.currentTarget as HTMLElement)"
    @dblclick="onDblclick"
  >
    <div class="trajectory-timeline__lane">
      <div
        v-for="span in model.spans"
        :key="span.index"
        class="trajectory-timeline__span"
        :class="[
          `lane-${span.lane}`,
          {
            error: span.isError,
            selected: drag !== null && span.start <= drag.current && span.end >= drag.anchor,
          },
        ]"
        :style="spanStyle(span)"
        :title="hint"
        @pointerenter="hovered = span"
        @pointerleave="hovered = null"
      />
      <div
        v-for="boundary in model.turnBoundaries"
        :key="boundary.turn"
        class="trajectory-timeline__boundary"
        :style="turnBoundaryStyle(boundary.time)"
        :title="t('trajectory.turn', { turn: boundary.turn })"
      />
    </div>
    <div
      v-if="drag"
      class="trajectory-timeline__drag"
      :style="{
        left: `${((Math.min(drag.anchor, drag.current) - viewStart) / domainWidth) * 100}%`,
        width: `${(Math.abs(drag.current - drag.anchor) / domainWidth) * 100}%`,
      }"
    ></div>
    <div class="trajectory-timeline__hint">
      <span class="trajectory-timeline__hint-text">{{ hint }}</span>
      <span v-if="zoomed || hasSelection" class="trajectory-timeline__hint-actions">
        <button v-if="zoomed" type="button" @click.stop="resetView">
          {{ t('trajectory.resetView') }}
        </button>
        <button v-if="hasSelection" type="button" @click.stop="emit('rangeChange', null)">
          {{ t('trajectory.clearFocus') }}
        </button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.trajectory-timeline {
  position: relative;
  height: 64px;
  padding: 6px 0 14px;
  box-sizing: border-box;
  cursor: crosshair;
  user-select: none;
  touch-action: none;
}
.trajectory-timeline__lane {
  position: absolute;
  inset: 6px 0 14px;
  border-bottom: 1px solid var(--color-line);
}
.trajectory-timeline__span {
  position: absolute;
  height: 8px;
  border-radius: var(--radius-xs);
  background: var(--color-accent);
  opacity: 0.75;
}
.trajectory-timeline__span.lane-0 {
  top: 0;
}
.trajectory-timeline__span.lane-1 {
  top: 13px;
}
.trajectory-timeline__span.lane-2 {
  top: 26px;
}
.trajectory-timeline__span.error {
  background: var(--color-danger);
}
.trajectory-timeline__span.selected {
  opacity: 1;
  outline: 1px solid var(--color-text-faint);
}
.trajectory-timeline__boundary {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--color-text-muted);
  opacity: 0.5;
}
.trajectory-timeline__drag {
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-line);
  pointer-events: none;
}
.trajectory-timeline__hint {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  pointer-events: none;
}
.trajectory-timeline__hint-text {
  overflow: hidden;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trajectory-timeline__hint-actions {
  display: flex;
  gap: var(--space-2);
  flex: none;
}
.trajectory-timeline__hint-actions button {
  padding: 0;
  border: none;
  background: none;
  color: var(--color-accent);
  cursor: pointer;
  font-size: var(--text-xs);
  pointer-events: auto;
}
.trajectory-timeline__hint-actions button:hover {
  text-decoration: underline;
}
.trajectory-timeline__hint-actions button:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
</style>
