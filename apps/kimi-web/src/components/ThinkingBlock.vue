<!-- apps/kimi-web/src/components/ThinkingBlock.vue -->
<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';

const props = withDefaults(
  defineProps<{
    text: string;
    mobile?: boolean;
    streaming?: boolean;
  }>(),
  { mobile: false, streaming: false },
);

const { t } = useI18n();

// Default open so the reasoning is visible; user can fold it away.
const open = ref(true);

function toggle() {
  open.value = !open.value;
}

/** True when the text spans more than 3 lines (\n-delimited). */
const isLong = computed(() => props.text.split('\n').length > 3);

/** First line or up to ~40 chars for the collapsed teaser. */
const preview = computed(() => {
  const firstLine = props.text.split('\n')[0] ?? '';
  if (firstLine.length > 40) return firstLine.slice(0, 40) + '…';
  return firstLine || t('thinking.label');
});

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
  <div class="think" :class="{ 'is-long': isLong, mob: mobile }">
    <Transition name="think" mode="out-in">
      <div v-if="open" key="open">
        <pre ref="bodyEl" class="tc">{{ text }}</pre>
        <button v-if="isLong" class="fold-btn" @click="toggle">
          <span class="fold-car">▾</span>
          <span class="fold-lbl">{{ t('thinking.label') }}</span>
        </button>
      </div>
      <button v-else key="closed" class="th" @click="toggle">
        <span class="label">{{ t('thinking.label') }}</span>
        <span class="prev">{{ preview }}</span>
      </button>
    </Transition>
  </div>
</template>

<style scoped>
.think {
  margin: 6px 0 18px 0;
}

/* ---- Collapsed teaser (desktop) ---- */
.th {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  background: none;
  border: none;
  padding: 2px 0;
  cursor: pointer;
  color: var(--dim);
  font-size: 13px;
  font-family: var(--mono);
  text-align: left;
  line-height: 1.4;
}
.th:hover {
  color: var(--text);
}
.label {
  color: var(--muted);
  font-weight: 600;
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

/* ---- Expanded body ---- */
.tc {
  font-family: var(--mono);
  font-size: 12.5px;
  font-style: normal;
  color: var(--muted);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  line-height: 1.7;
  max-height: calc(1.7em * 9.5);
  overflow-y: auto;
}

/* Fold button sits beneath the text on long blocks */
.fold-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  padding: 2px 0;
  margin-top: 2px;
  cursor: pointer;
  color: var(--faint);
  font-size: 11px;
  font-family: var(--mono);
  line-height: 1;
}
.fold-btn:hover {
  color: var(--muted);
}
.fold-car {
  font-size: 9px;
}
.fold-lbl {
  color: inherit;
}

/* ---- Transition ---- */
.think-enter-active,
.think-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.think-enter-from,
.think-leave-to {
  opacity: 0;
  transform: translateY(-3px);
}

/* ---- Mobile tweaks ---- */
.mob {
  margin: 10px 0;
}
.mob .tc {
  color: var(--faint);
  line-height: 1.6;
  max-height: calc(1.6em * 9.5);
}
.mob .th {
  font-size: 13px;
  color: var(--muted);
}
.mob .label {
  color: var(--muted);
  font-weight: 500;
}
.mob .prev {
  color: var(--faint);
}
</style>
