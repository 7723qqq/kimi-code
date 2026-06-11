<!-- apps/kimi-web/src/components/TabBar.vue -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { PaneKey, TodoView } from '../types';

defineProps<{ active: PaneKey; runningTasks: number; changesCount?: number; todos?: TodoView[]; mobile?: boolean; showCopyConversation?: boolean; copyConversationCopied?: boolean }>();
const emit = defineEmits<{ select: [pane: PaneKey]; copyConversation: [] }>();

const { t } = useI18n();

const tabs: { key: PaneKey; labelKey: string }[] = [
  { key: 'chat', labelKey: 'sidebar.tabChat' },
  // TODO: temporarily hide the files tab until the feature is ready
  // { key: 'files', labelKey: 'sidebar.tabFiles' },
  { key: 'tasks', labelKey: 'sidebar.tabTasks' },
  { key: 'todo', labelKey: 'sidebar.tabTodo' },
];
</script>

<template>
  <div class="tabs" :class="{ mobile }">
    <div class="tabs-left">
      <div
        v-for="tab in tabs"
        :key="tab.key"
        class="tb"
        :class="{ on: active === tab.key }"
        @click="emit('select', tab.key)"
      >
        {{ t(tab.labelKey) }}
        <!-- TODO: restore when files tab is re-enabled -->
        <!-- <span v-if="tab.key === 'files' && (changesCount ?? 0) > 0" class="d"></span> -->
        <span v-if="tab.key === 'tasks' && runningTasks > 0" class="cnt">{{ runningTasks }}</span>
        <span v-if="tab.key === 'todo' && (todos?.length ?? 0) > 0" class="cnt">{{ (todos?.filter((t) => t.status === 'done').length ?? 0) }}/{{ todos!.length }}</span>
      </div>
    </div>
    <div v-if="showCopyConversation && active === 'chat'" class="tabs-right">
      <button
        class="share-conversation-btn"
        :class="{ 'is-copied': copyConversationCopied }"
        type="button"
        :aria-label="copyConversationCopied ? t('sidebar.shareConversationCopied') : t('sidebar.shareConversation')"
        :title="copyConversationCopied ? t('sidebar.shareConversationCopied') : t('sidebar.shareConversation')"
        @click="emit('copyConversation')"
      >
        <svg v-if="!copyConversationCopied" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5.5 2.5h6A1.5 1.5 0 0 1 13 4v7.5"/>
          <rect x="3" y="4.5" width="8" height="9" rx="1.4"/>
          <path d="M5.3 7.1h3.4"/>
          <path d="M5.3 9.3h2.8"/>
          <path d="M5.3 11.5h3.4"/>
        </svg>
        <svg v-else viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="3,8 6.5,11.5 13,5"/>
        </svg>
        <span class="share-conversation-label">{{ copyConversationCopied ? t('sidebar.shareConversationCopied') : t('sidebar.shareConversation') }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.tabs {
  height: 32px;
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.tabs-left {
  display: flex;
  align-items: stretch;
}
.tabs-right {
  display: flex;
  align-items: center;
  padding: 0 12px;
}
.share-conversation-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--muted);
  font-size: 12px;
  font-family: var(--sans);
  cursor: pointer;
  transition: color 0.12s, background 0.12s;
  white-space: nowrap;
}
.share-conversation-btn:hover {
  color: var(--ink);
  background: var(--panel2);
}
.share-conversation-btn.is-copied {
  color: var(--ok);
}
.share-conversation-btn svg {
  flex: none;
}
.share-conversation-label {
  opacity: 0;
  max-width: 0;
  overflow: hidden;
  transition: opacity 0.15s ease, max-width 0.2s ease;
}
.share-conversation-btn:hover .share-conversation-label {
  opacity: 1;
  max-width: 120px;
}
.share-conversation-btn.is-copied .share-conversation-label {
  opacity: 1;
  max-width: 120px;
}
.tb {
  padding: 0 14px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--dim);
  border-right: 1px solid var(--line);
  cursor: pointer;
}
.tb:hover {
  background: var(--panel2);
}
.tb.on {
  /* Merge the active tab into the content surface below (dark-mode safe). */
  background: var(--bg);
  color: var(--blue2);
  font-weight: 600;
}
.d {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
}
.cnt {
  background: var(--soft);
  color: var(--blue2);
  border-radius: 8px;
  padding: 0 6px;
  font-size: 10px;
  font-weight: 600;
}

/* ---- Mobile swap-strip: full-width mono tabs, 46px tall (≥44px tap) ---- */
.tabs.mobile {
  height: 46px;
  background: var(--bg);
}
.tabs.mobile .tb {
  flex: 1;
  justify-content: center;
  gap: 5px;
  padding: 0 2px;
  font-family: var(--mono);
  font-size: 14.5px;
  color: var(--muted);
  border-right: none;
  border-bottom: none;
  /* Three flex:1 tabs + a "10/12" pill must not blow up tiny screens. */
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.tabs.mobile .tb:hover { background: var(--bg); }
.tabs.mobile .tb.on {
  background: var(--bg);
  color: var(--blue);
  font-weight: 600;
}
/* Tasks → solid blue count pill (prototype .bdg). */
.tabs.mobile .cnt {
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--blue);
  color: var(--bg); /* on-accent text — readable in dark + mono-dark */
  border-radius: 9px;
  font-size: 12px;
  font-weight: 600;
}
/* Diff → small warn dot (prototype .dt). */
.tabs.mobile .d {
  width: 6px;
  height: 6px;
  background: var(--warn);
}

/* NOTE: Modern-theme tab styles live in src/style.css (global). Scoped
   `:global(html[data-theme=modern]) .tb` rules here did NOT win the cascade
   (tabs stayed square + bordered), so they were moved to the global sheet. */
</style>
