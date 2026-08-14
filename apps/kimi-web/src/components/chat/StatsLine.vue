<!-- apps/kimi-web/src/components/chat/StatsLine.vue -->
<!-- Live session statistics strip above the composer: turns · steps | LLM ·
     tool wall time | average first-token latency · decode throughput |
     cache-hit share · billed tokens. Ported from deepseek-harness
     ui-conversation StatsLine (MIT). Rendered only while the session has
     step activity; each pipe-separated group drops out when it has no data. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SessionStats } from '../../lib/sessionStats';
import {
  averageTtftMs,
  cacheHitPercent,
  formatDurationMs,
  formatTokensPerSecond,
  tokensPerSecond,
} from '../../lib/sessionStats';
import { formatTokens } from '../../lib/formatTokens';

const props = defineProps<{ stats: SessionStats }>();

const { t } = useI18n();

const groups = computed<string[]>(() => {
  const s = props.stats;
  const out: string[] = [];
  if (s.steps <= 0) return out;
  out.push(t('stats.counts', { turns: s.turns, steps: s.steps }));
  const durations: string[] = [];
  if (s.llmMs > 0) durations.push(t('stats.llm', { duration: formatDurationMs(s.llmMs) }));
  if (s.toolMs > 0) durations.push(t('stats.toolCall', { duration: formatDurationMs(s.toolMs) }));
  if (durations.length > 0) out.push(durations.join(' · '));
  const speeds: string[] = [];
  const ttft = averageTtftMs(s);
  if (ttft !== null) speeds.push(t('stats.ttftAverage', { duration: formatDurationMs(ttft) }));
  const tps = tokensPerSecond(s);
  if (tps !== null) speeds.push(t('stats.tokensPerSecond', { tps: formatTokensPerSecond(tps) }));
  if (speeds.length > 0) out.push(speeds.join(' · '));
  const hit = cacheHitPercent(s);
  if (hit !== null) out.push(t('stats.cacheHit', { percent: hit }));
  if (s.inputTokens > 0 || s.outputTokens > 0) {
    out.push(
      t('stats.inputOutput', {
        input: formatTokens(s.inputTokens),
        output: formatTokens(s.outputTokens),
      }),
    );
  }
  return out;
});
</script>

<template>
  <div v-if="groups.length > 0" class="stats-line">
    <span v-for="(group, index) in groups" :key="index" class="group">
      <template v-if="index > 0"> · </template>
      {{ group }}
    </span>
  </div>
</template>

<style scoped>
.stats-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  box-sizing: border-box;
  min-height: 22px;
  padding: 2px 12px;
  color: var(--muted);
  font-size: var(--ui-font-size-xs);
  line-height: 1.4;
  user-select: none;
}
</style>
