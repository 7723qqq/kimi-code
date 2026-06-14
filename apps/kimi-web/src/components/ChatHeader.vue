<!-- apps/kimi-web/src/components/ChatHeader.vue -->
<!-- Thin context bar above the chat: workspace / session name, git branch +
     status, "open in editor", copy-all-conversation, and (when available) the
     GitHub PR status. -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const props = defineProps<{
  workspaceName?: string;
  sessionTitle?: string;
  branch?: string;
  ahead?: number;
  behind?: number;
  changesCount?: number;
  isGitRepo?: boolean;
  /** GitHub PR for the current branch, when known (null/undefined = none). */
  pr?: { number: number; state: string; url: string } | null;
  /** True for ~2s after a successful copy-all, to flip the icon to a check. */
  copied?: boolean;
}>();

const emit = defineEmits<{
  openInEditor: [];
  copyAll: [];
  openPr: [];
}>();

const ahead = computed(() => props.ahead ?? 0);
const behind = computed(() => props.behind ?? 0);
const changes = computed(() => props.changesCount ?? 0);
</script>

<template>
  <header class="chat-header">
    <!-- Workspace / session breadcrumb -->
    <div class="ch-id">
      <span v-if="workspaceName" class="ch-ws">{{ workspaceName }}</span>
      <span v-if="workspaceName && sessionTitle" class="ch-sep">/</span>
      <span v-if="sessionTitle" class="ch-ses" :title="sessionTitle">{{ sessionTitle }}</span>
    </div>

    <!-- Copy all conversation — kept close to the title on the left -->
    <button type="button" class="ch-act ch-act-copy" :title="t('header.copyAll')" @click="emit('copyAll')">
      <svg v-if="!copied" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="9" height="9" rx="1.5" /><path d="M6 1h7a1 1 0 0 1 1 1v7" />
      </svg>
      <svg v-else viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="3,8 6.5,11.5 13,5" />
      </svg>
      <span class="ch-act-label">{{ copied ? t('header.copied') : t('header.copyAll') }}</span>
    </button>

    <div class="ch-spacer" />

    <!-- Git branch + status — plain text with semantic colors -->
    <div v-if="isGitRepo && branch" class="ch-git" :title="t('header.gitTooltip')">
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <circle cx="4" cy="4" r="1.7" /><circle cx="4" cy="12" r="1.7" /><circle cx="12" cy="6" r="1.7" />
        <path d="M4 5.7v4.6M5.7 4H9a2 2 0 0 1 2 2v.3" />
      </svg>
      <span class="ch-branch">{{ branch }}</span>
      <span v-if="ahead > 0" class="ch-ahead">↑{{ ahead }}</span>
      <span v-if="behind > 0" class="ch-behind">↓{{ behind }}</span>
      <span v-if="changes > 0" class="ch-changes">{{ t('header.changed', { n: changes }) }}</span>
    </div>

    <!-- GitHub PR status -->
    <button
      v-if="pr"
      type="button"
      class="ch-pr"
      :class="`pr-${pr.state}`"
      :title="t('header.openPr')"
      @click="emit('openPr')"
    >
      <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
        <path d="M11.5 4.5a2 2 0 1 0-2.7 1.86V9.6A2 2 0 1 0 10 11.5V6.36A2 2 0 0 0 11.5 4.5zM4.5 2.5a2 2 0 0 0-.7 3.86v3.28a2 2 0 1 0 1.4 0V6.36A2 2 0 0 0 4.5 2.5z"/>
      </svg>
      <span>PR #{{ pr.number }} · {{ pr.state }}</span>
    </button>

    <!-- Open in editor — shorter label on desktop, icon-only on narrow widths -->
    <button type="button" class="ch-act ch-act-editor" :title="t('header.openInEditor')" @click="emit('openInEditor')">
      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M9 2h5v5M14 2 7 9M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5" />
      </svg>
      <span class="ch-act-label">{{ t('header.openInEditorShort') }}</span>
    </button>
  </header>
</template>

<style scoped>
.chat-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 38px;
  padding: 0 14px;
  border-bottom: 1px solid var(--line);
  background: var(--bg);
  font-family: var(--sans);
  min-width: 0;
}
.ch-id { display: flex; align-items: center; gap: 6px; min-width: 0; flex: none; max-width: 46%; }
.ch-ws { color: var(--muted); font-size: 12.5px; flex: none; }
.ch-sep { color: var(--faint); flex: none; }
.ch-ses {
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ch-git {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11.5px;
  min-width: 0;
}
.ch-git svg { flex: none; }
.ch-branch { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
.ch-ahead { color: var(--warn); flex: none; }
.ch-behind { color: var(--blue2); flex: none; }
.ch-changes {
  flex: none;
  color: var(--warn);
}
.ch-spacer { flex: 1; min-width: 0; }

.ch-act {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--dim);
  font-family: var(--sans);
  font-size: 12px;
  padding: 0;
  cursor: pointer;
}
.ch-act:hover { color: var(--ink); }
.ch-act svg { flex: none; }

.ch-pr {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: none;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg);
  font-family: var(--mono);
  font-size: 11px;
  padding: 2px 9px;
  cursor: pointer;
  color: var(--dim);
}
.ch-pr.pr-open { color: #1a7f37; border-color: color-mix(in srgb, #1a7f37 30%, var(--line)); }
.ch-pr.pr-merged { color: #8250df; border-color: color-mix(in srgb, #8250df 30%, var(--line)); }
.ch-pr.pr-closed { color: var(--err); }
.ch-pr:hover { background: var(--soft); }

/* On a narrow conversation column, the action labels collapse to icons. */
@media (max-width: 900px) {
  .ch-act-label { display: none; }
}
@media (max-width: 640px) {
  .chat-header { display: none; }
}
</style>
