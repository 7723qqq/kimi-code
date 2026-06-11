<!-- apps/kimi-web/src/components/ThinkingPanel.vue -->
<!-- Full thinking text in the right-side panel (App's shared preview slot —
     opening this replaces a file preview and vice versa). Content is reactive:
     while the block is still streaming the text keeps growing, and the body
     follows the bottom as long as the user hasn't scrolled up. -->
<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  text: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const { t } = useI18n();

const bodyEl = ref<HTMLElement | null>(null);
watch(
  () => props.text,
  () => {
    const el = bodyEl.value;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atBottom) return;
    void nextTick(() => {
      if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight;
    });
  },
  { immediate: true },
);
</script>

<template>
  <div class="tp">
    <div class="tp-header">
      <span class="tp-title">{{ t('thinking.panelTitle') }}</span>
      <button type="button" class="tp-close" :title="t('thinking.close')" @click="emit('close')">
        <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
      </button>
    </div>
    <pre ref="bodyEl" class="tp-body">{{ text }}</pre>
  </div>
</template>

<style scoped>
.tp {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg);
}

.tp-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.tp-title {
  font-family: var(--mono);
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--muted);
}
.tp-close {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: none;
  border: none;
  border-radius: 5px;
  color: var(--muted);
  cursor: pointer;
}
.tp-close:hover {
  background: var(--hover);
  color: var(--ink);
}

.tp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 12px 14px;
  font-family: var(--mono);
  font-size: 14px;
  line-height: 1.7;
  color: var(--dim);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
