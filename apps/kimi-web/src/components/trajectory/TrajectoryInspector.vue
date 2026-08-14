<!-- TrajectoryInspector.vue — detail panel for a selected trajectory record:
     kind/turn/group, duration, token usage, assistant timing, and the full
     input/output/thinking/result content. Ported from deepseek-harness
     ui-trajectory's local inspector (MIT). -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { TrajectoryRecord } from '../../lib/trajectory/records';
import { formatDurationMillis } from '../../lib/trajectory/timeline';
import Badge from '../ui/Badge.vue';

const props = defineProps<{ record: TrajectoryRecord }>();

const emit = defineEmits<{ clear: [] }>();

const { t } = useI18n();

const kindLabel = computed(() => {
  switch (props.record.kind) {
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
});

const startedLabel = computed(() =>
  props.record.startedAt === null
    ? '—'
    : new Date(props.record.startedAt).toLocaleTimeString(),
);

const tokens = computed(() => [
  props.record.input === undefined ? null : [t('trajectory.input'), String(props.record.input)] as const,
  props.record.output === undefined ? null : [t('trajectory.output'), String(props.record.output)] as const,
  props.record.cacheRead === undefined ? null : [t('trajectory.cacheRead'), String(props.record.cacheRead)] as const,
  props.record.cacheWrite === undefined ? null : [t('trajectory.cacheWrite'), String(props.record.cacheWrite)] as const,
  props.record.think === undefined ? null : [t('trajectory.think'), String(props.record.think)] as const,
].filter((entry): entry is readonly [string, string] => entry !== null));

const timing = computed(() => [
  props.record.ttftMs === undefined || props.record.ttftMs === null
    ? null
    : [t('trajectory.ttft'), formatDurationMillis(props.record.ttftMs)] as const,
  props.record.streamMs === undefined || props.record.streamMs === null
    ? null
    : [t('trajectory.stream'), formatDurationMillis(props.record.streamMs)] as const,
  props.record.requestBuildMs === undefined || props.record.requestBuildMs === null
    ? null
    : [t('trajectory.requestBuild'), formatDurationMillis(props.record.requestBuildMs)] as const,
].filter((entry): entry is readonly [string, string] => entry !== null));

const sections = computed(() => [
  props.record.thinkingDetail === undefined
    ? null
    : [t('trajectory.think'), props.record.thinkingDetail] as const,
  props.record.inputDetail === undefined
    ? null
    : [t('trajectory.input'), props.record.inputDetail] as const,
  props.record.outputDetail === undefined
    ? null
    : [t('trajectory.output'), props.record.outputDetail] as const,
  props.record.result === undefined
    ? null
    : [t('trajectory.output'), props.record.result] as const,
].filter((entry): entry is readonly [string, string] => entry !== null));
</script>

<template>
  <div class="trajectory-inspector">
    <div class="trajectory-inspector__head">
      <Badge :variant="record.isError === true ? 'danger' : 'neutral'">{{ kindLabel }}</Badge>
      <span class="trajectory-inspector__index">#{{ record.index }}</span>
      <span class="trajectory-inspector__turn">
        {{ record.turn === null ? t('trajectory.betweenTurns') : t('trajectory.turn', { turn: record.turn }) }}
      </span>
      <button type="button" class="trajectory-inspector__clear" @click="emit('clear')">
        {{ t('trajectory.clearSelection') }}
      </button>
    </div>
    <div class="trajectory-inspector__meta">
      <span>{{ t('trajectory.duration') }}: {{ formatDurationMillis(record.timeSeconds === null ? null : record.timeSeconds * 1000) }}</span>
      <span>{{ t('trajectory.startedAt') }}: {{ startedLabel }}</span>
    </div>
    <template v-if="tokens.length > 0">
      <div class="trajectory-inspector__section-title">{{ t('trajectory.tokens') }}</div>
      <div class="trajectory-inspector__grid">
        <span v-for="[label, value] in tokens" :key="label" class="trajectory-inspector__cell">
          <span class="trajectory-inspector__cell-label">{{ label }}</span>
          <span class="trajectory-inspector__cell-value">{{ value }}</span>
        </span>
      </div>
    </template>
    <template v-if="timing.length > 0">
      <div class="trajectory-inspector__section-title">{{ t('trajectory.timing') }}</div>
      <div class="trajectory-inspector__grid">
        <span v-for="[label, value] in timing" :key="label" class="trajectory-inspector__cell">
          <span class="trajectory-inspector__cell-label">{{ label }}</span>
          <span class="trajectory-inspector__cell-value">{{ value }}</span>
        </span>
      </div>
    </template>
    <div v-for="[title, body] in sections" :key="title" class="trajectory-inspector__section">
      <div class="trajectory-inspector__section-title">{{ title }}</div>
      <pre class="trajectory-inspector__pre">{{ body }}</pre>
    </div>
  </div>
</template>

<style scoped>
.trajectory-inspector {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  box-sizing: border-box;
  overflow-y: auto;
}
.trajectory-inspector__head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.trajectory-inspector__index {
  color: var(--color-text-faint);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.trajectory-inspector__turn {
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.trajectory-inspector__clear {
  margin-left: auto;
  padding: 0;
  background: none;
  border: none;
  color: var(--color-accent);
  font-size: var(--text-xs);
  cursor: pointer;
}
.trajectory-inspector__clear:hover {
  text-decoration: underline;
}
.trajectory-inspector__meta {
  display: flex;
  gap: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--text-sm);
}
.trajectory-inspector__section-title {
  margin-top: var(--space-2);
  color: var(--color-text);
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.trajectory-inspector__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: var(--space-1) var(--space-2);
}
.trajectory-inspector__cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.trajectory-inspector__cell-label {
  color: var(--color-text-faint);
  font-size: var(--text-xs);
}
.trajectory-inspector__cell-value {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
}
.trajectory-inspector__section {
  min-width: 0;
}
.trajectory-inspector__pre {
  margin: 0;
  padding: var(--space-2);
  box-sizing: border-box;
  max-height: 260px;
  overflow: auto;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
