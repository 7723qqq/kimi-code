<!-- apps/kimi-web/src/components/ThinkingBlock.vue -->
<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';

const props = withDefaults(
  defineProps<{
    text: string;
    mobile?: boolean;
    streaming?: boolean;
    foldable?: boolean;
  }>(),
  { mobile: false, streaming: false, foldable: true },
);

// Start collapsed unless this block is actively streaming: history sessions
// (never streamed) should not flood the transcript with expanded thinking.
const open = ref(props.streaming);

/** Last non-empty paragraph, shown as the collapsed teaser. */
const teaser = computed(
  () =>
    props.text
      .split(/\n{2,}/)
      .filter((p) => p.trim().length > 0)
      .pop() ?? '',
);

/** True while the user has text selected — don't steal the selection by toggling. */
function hasActiveSelection(): boolean {
  return window.getSelection()?.isCollapsed === false;
}

// Collapsed: the whole block is a click target to expand.
// Expanded: body clicks do nothing (only the head collapses).
function onWrapClick(): void {
  if (open.value) return;
  if (hasActiveSelection()) return;
  open.value = true;
}

// Head (chevron + teaser row) toggles in both states.
function onHeadClick(): void {
  if (hasActiveSelection()) return;
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
    <!-- Foldable: head (chevron + teaser) above, content below -->
    <template v-if="foldable">
      <div class="tc-wrap" :class="{ 'is-collapsed': !open }" @click="onWrapClick">
        <div
          class="tc-head"
          role="button"
          tabindex="0"
          :aria-expanded="open"
          @click.stop="onHeadClick"
          @keydown.enter.prevent="onHeadClick"
          @keydown.space.prevent="onHeadClick"
        >
          <svg class="chev" :class="{ 'chev-open': open }" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M5.5 3.5 L10.5 8 L5.5 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <div class="prev-anim">
            <span class="prev">{{ teaser }}</span>
          </div>
        </div>
        <div class="tc-anim">
          <pre ref="bodyEl" class="tc">{{ text }}</pre>
        </div>
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

.tc-wrap {
  display: grid;
  grid-template-rows: auto 1fr;
  transition: grid-template-rows 0.25s ease;
}
.tc-wrap.is-collapsed {
  grid-template-rows: auto 0fr;
  cursor: pointer;
}
.tc-anim {
  overflow: hidden;
  min-height: 0;
}

.tc-head {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  cursor: pointer;
  padding: 2px 0;
}

/* Always-visible chevron: points right when collapsed, down when expanded. */
.chev {
  flex: none;
  margin-top: 6px;
  color: var(--faint);
  transition:
    transform 0.25s ease,
    color 0.15s ease;
}
.chev-open {
  transform: rotate(90deg);
}

/* Hover hint on the clickable areas (whole block when collapsed, head when expanded) */
.tc-wrap.is-collapsed:hover .prev {
  color: var(--text);
}
.tc-wrap.is-collapsed:hover .chev,
.tc-head:hover .chev {
  color: var(--text);
}

/* Teaser collapses away while the body is expanded. */
.prev-anim {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.25s ease;
}
.tc-wrap:not(.is-collapsed) .prev-anim {
  grid-template-rows: 0fr;
}

.prev {
  color: var(--faint);
  font-size: 14px;
  font-family: var(--mono);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  display: block;
  overflow: hidden;
  min-height: 0;
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

/* On phones the inner scroll area fights the page scroll: let the body grow
   naturally and scroll with the page instead. Also enlarge the head tap target. */
@media (max-width: 640px) {
  .tc,
  .mob .tc {
    max-height: none;
    overflow-y: visible;
  }
  .tc-head {
    padding: 4px 0;
    min-height: 24px;
  }
}
</style>
