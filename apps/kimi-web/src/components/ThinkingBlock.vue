<!-- apps/kimi-web/src/components/ThinkingBlock.vue -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{ text: string }>();

const { t } = useI18n();

const open = ref(false);

function toggle() {
  open.value = !open.value;
}

/** First line or up to ~80 chars for the collapsed summary */
const preview = computed(() => {
  const firstLine = props.text.split('\n')[0] ?? '';
  if (firstLine.length > 72) return firstLine.slice(0, 72) + '…';
  return firstLine;
});
</script>

<template>
  <div class="think" :class="{ open }">
    <button class="th" @click="toggle" :aria-expanded="open">
      <span class="car">{{ open ? '▾' : '▸' }}</span>
      <span class="label">{{ t('thinking.label') }}</span>
      <span v-if="!open" class="prev">{{ preview }}</span>
    </button>
    <div v-if="open" class="tb">
      <pre class="tc">{{ text }}</pre>
    </div>
  </div>
</template>

<style scoped>
.think {
  margin: 4px 0 6px 0;
}

.th {
  display: flex;
  align-items: baseline;
  gap: 7px;
  width: 100%;
  background: none;
  border: none;
  padding: 4px 8px;
  cursor: pointer;
  color: var(--dim);
  font-size: 12px;
  font-family: var(--mono);
  font-style: italic;
  text-align: left;
}

.th:hover {
  color: var(--text);
}

.car {
  color: var(--faint);
  font-style: normal;
  flex: none;
}

.label {
  color: var(--muted);
  font-weight: 600;
  font-style: normal;
  flex: none;
}

.prev {
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}

.tb {
  padding: 0 8px 6px 8px;
}

.tc {
  font-family: var(--mono);
  font-size: 11.5px;
  font-style: italic;
  color: var(--muted);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  line-height: 1.7;
}
</style>
