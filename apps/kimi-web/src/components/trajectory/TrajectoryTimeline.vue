<!-- TrajectoryTimeline.vue — the overview strip above the trajectory ledger.
     Projects records into the active domain (sequence / duration / time /
     actual) on three lanes; turn boundaries are marked; hover shows the
     record label and duration; drag selects an inclusive interval; wheel
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
}>();

const emit = defineEmits<{
  rangeChange: [range: TrajectoryTimeRange | null];
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
    const { anchor, current } = drag.value;
    emit('rangeChange', {
      start: Math.min(anchor, current),
      end: Math.max(anchor, current),
    });
  };
  const onUp = (): void => {
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
  nextStart = Math.max(
    props.model.start,
    Math.min(props.model.end - nextWidth, nextStart),
  );
  viewStart.value = nextStart;
  viewEnd.value = nextStart + nextWidth;
}

function turnBoundaryStyle(time: number): Record<string, string> {
  return { left: `${((time - viewStart.value) / domainWidth.value) * 100}%` };
}
</script>

<template>
  <div
    class="trajectory-timeline"
    :data-mode="mode"
    @pointerdown="onPointerDown($event, ($event.currentTarget as HTMLElement))"
    @wheel.prevent="onWheel($event, ($event.currentTarget as HTMLElement))"
  >
    <div class="trajectory-timeline__lane">
      <div
        v-for="span in model.spans"
        :key="span.index"
        class="trajectory-timeline__span"
        :class="[
          `lane-${span.lane}`,
          { error: span.isError, selected: drag !== null && span.start <= drag.current && span.end >= drag.anchor },
        ]"
        :style="spanStyle(span)"
        :title="`${span.label} — ${formatDurationMillis(span.end - span.start)}`"
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
    <div v-if="drag" class="trajectory-timeline__drag" :style="{
      left: `${((Math.min(drag.anchor, drag.current) - viewStart) / domainWidth) * 100}%`,
      width: `${(Math.abs(drag.current - drag.anchor) / domainWidth) * 100}%`,
    }"></div>
    <div class="trajectory-timeline__hint">
      {{ hovered ? `${hovered.label} · ${formatDurationMillis(hovered.end - hovered.start)}` : '' }}
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
.trajectory-timeline__span.lane-0 { top: 0; }
.trajectory-timeline__span.lane-1 { top: 13px; }
.trajectory-timeline__span.lane-2 { top: 26px; }
.trajectory-timeline__span.error { background: var(--color-danger); }
.trajectory-timeline__span.selected { opacity: 1; outline: 1px solid var(--color-text-faint); }
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
  overflow: hidden;
  color: var(--color-text-faint);
  font-size: var(--text-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
  pointer-events: none;
}
</style>
