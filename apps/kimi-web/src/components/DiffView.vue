<!-- apps/kimi-web/src/components/DiffView.vue -->
<!-- ~/diff tab: real git changes from the daemon's fs:git_status -->
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const props = defineProps<{
  changes: { path: string; status: string }[];
  gitInfo: { branch: string; ahead: number; behind: number } | null;
}>();

// Status badge: single-letter glyph + CSS class
type BadgeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'ignored' | 'clean' | 'unknown';

function badgeKind(s: string): BadgeKind {
  const lower = s.toLowerCase();
  if (lower === 'modified') return 'modified';
  if (lower === 'added') return 'added';
  if (lower === 'deleted') return 'deleted';
  if (lower === 'renamed') return 'renamed';
  if (lower === 'untracked') return 'untracked';
  if (lower === 'conflicted') return 'conflicted';
  if (lower === 'ignored') return 'ignored';
  if (lower === 'clean') return 'clean';
  return 'unknown';
}

const BADGE_GLYPH: Record<BadgeKind, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: 'C',
  ignored: 'I',
  clean: '·',
  unknown: '?',
};

function badgeGlyph(s: string): string {
  return BADGE_GLYPH[badgeKind(s)] ?? '?';
}

/**
 * Truncate a long path from the left, showing the tail.
 * e.g. "packages/daemon/src/middleware/schema.ts" → "…leware/schema.ts"
 */
function truncateLeft(path: string, maxLen = 60): string {
  if (path.length <= maxLen) return path;
  return '…' + path.slice(path.length - maxLen + 1);
}

const hasGitInfo = computed(() => props.gitInfo !== null);
const hasChanges = computed(() => props.changes.length > 0);
</script>

<template>
  <div class="changes-pane">
    <!-- Header -->
    <div class="ch-head">
      <template v-if="hasGitInfo">
        <span class="br-label">{{ t('diff.branch') }}</span>
        <span class="br-name">{{ gitInfo!.branch }}</span>
        <span v-if="gitInfo!.ahead > 0 || gitInfo!.behind > 0" class="sync-info">
          <span v-if="gitInfo!.ahead > 0" class="ahead" :title="t('diff.aheadTitle')">&#8593;{{ gitInfo!.ahead }}</span>
          <span v-if="gitInfo!.behind > 0" class="behind" :title="t('diff.behindTitle')">&#8595;{{ gitInfo!.behind }}</span>
        </span>
        <span class="change-count">{{ t('diff.changeCount', { count: changes.length }) }}</span>
      </template>
      <template v-else>
        <span class="empty-head">{{ t('diff.empty') }}</span>
      </template>
    </div>

    <!-- File list -->
    <div v-if="hasChanges" class="ch-list">
      <div
        v-for="entry in changes"
        :key="entry.path"
        class="ch-row"
        :title="entry.path"
      >
        <span class="badge" :class="badgeKind(entry.status)">{{ badgeGlyph(entry.status) }}</span>
        <span class="fpath">{{ truncateLeft(entry.path) }}</span>
      </div>
    </div>

    <!-- Empty state when git info present but no changes -->
    <div v-else-if="hasGitInfo" class="empty-state">
      {{ t('diff.clean') }}
    </div>

    <!-- No git info at all -->
    <div v-else class="empty-state">
      {{ t('diff.empty') }}
    </div>
  </div>
</template>

<style scoped>
.changes-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  font-family: var(--mono);
}

/* ---- Header ---- */
.ch-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  font-size: 11.5px;
  color: var(--dim);
  flex: none;
  white-space: nowrap;
  overflow: hidden;
}

.br-label {
  color: var(--muted);
  font-size: 10.5px;
}

.br-name {
  color: #1565C0;
  font-weight: 700;
  font-size: 12px;
}

.sync-info {
  display: flex;
  align-items: center;
  gap: 4px;
}

.ahead {
  color: #1565C0;
  font-size: 11px;
}

.behind {
  color: var(--warn);
  font-size: 11px;
}

.change-count {
  margin-left: auto;
  color: var(--dim);
  font-size: 10.5px;
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 0 6px;
}

.empty-head {
  color: var(--muted);
  font-size: 11px;
}

/* ---- File list ---- */
.ch-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.ch-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 16px;
  cursor: default;
  font-size: 12px;
  line-height: 1.6;
}

.ch-row:hover {
  background: var(--panel2, #f5f6f8);
}

/* ---- Status badge ---- */
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 2px;
  font-size: 10px;
  font-weight: 700;
  flex: none;
  user-select: none;
}

.badge.modified  { background: #e8f0fe; color: #1565C0; }
.badge.added     { background: #e6f4ea; color: #1e7e34; }
.badge.deleted   { background: #fce8e6; color: #c5221f; }
.badge.renamed   { background: #fef3e2; color: #b06000; }
.badge.untracked { background: var(--soft, #f0f0f5); color: var(--muted, #9098a0); }
.badge.conflicted{ background: #fce8e6; color: #c5221f; font-size: 9px; }
.badge.ignored   { background: var(--soft, #f0f0f5); color: var(--faint, #c0c5cc); }
.badge.clean     { background: transparent; color: var(--faint, #c0c5cc); }
.badge.unknown   { background: var(--soft, #f0f0f5); color: var(--muted, #9098a0); }

/* ---- File path ---- */
.fpath {
  color: var(--ink);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;   /* makes text-overflow clip from the left */
  text-align: left;
  min-width: 0;
}

/* ---- Empty state ---- */
.empty-state {
  padding: 32px 20px;
  color: var(--muted, #9098a0);
  font-size: 12px;
  text-align: center;
}
</style>
