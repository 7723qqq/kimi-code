<!-- apps/kimi-web/src/components/ThinkingBlock.vue -->
<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';

const props = withDefaults(
  defineProps<{
    text: string;
    mobile?: boolean;
    streaming?: boolean;
    foldable?: boolean;
  }>(),
  { mobile: false, streaming: false, foldable: true },
);

const open = ref(true);

function toggle() {
  open.value = !open.value;
}

// Auto-fold when this thinking block finishes streaming.
watch(
  () => props.streaming,
  (next, prev) => {
    if (prev === true && next === false && props.foldable) {
      open.value = false;
    }
  },
);

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
  <div class="think" :class="{ mob: mobile }">
    <!-- Foldable: content above, last-line teaser below; click to toggle -->
    <template v-if="foldable">
      <div class="tc-wrap" :class="{ 'is-collapsed': !open }" @click="toggle">
        <pre v-show="open" ref="bodyEl" class="tc">{{ text }}</pre>
        <span v-show="!open" class="prev">{{ text.split(/\n{2,}/).filter((p) => p.trim().length > 0).pop() ?? '' }}</span>
      </div>
    </template>
    <!-- Non-foldable: always show full content -->
    <pre v-else ref="bodyEl" class="tc">{{ text }}</pre>
  </div>
</template>

<style scoped>
.think {
  margin: 6px 0 18px 0;
}

.prev {
  color: var(--faint);
  font-size: 14px;
  font-family: var(--mono);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}

.tc-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* Collapsed: hide content, show last-line teaser */
.tc-wrap.is-collapsed .tc {
  display: none;
}

/* Hover indicates clickability only when collapsed (prev is visible) */
.tc-wrap.is-collapsed {
  cursor: pointer;
}
.tc-wrap.is-collapsed:hover .prev {
  color: var(--text);
}

.tc {
  font-family: var(--mono);
  font-size: 14px;
  font-style: normal;
  color: var(--muted);
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  line-height: 1.7;
  max-height: calc(1.7em * 9);
  overflow-y: auto;
}

/* ---- Mobile tweaks ---- */
.mob {
  margin: 10px 0;
}
.mob .tc {
  color: var(--faint);
  line-height: 1.6;
  max-height: calc(1.6em * 9);
}
.mob .prev {
  color: var(--faint);
  line-height: 1.6;
}
</style>
