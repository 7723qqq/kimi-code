<!-- apps/kimi-web/src/components/MobileSwitcherSheet.vue -->
<!-- Mobile switcher bottom sheet, mirroring the desktop sidebar: a "+ new
     workspace" row, then collapsible workspace groups (folder icon + name +
     branch/path sub-line + per-group "+") with their session rows beneath.
     Tapping a session selects it AND closes the sheet; tapping a group header
     folds it, same as the desktop sidebar. -->
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { Session, WorkspaceGroup } from '../types';
import BottomSheet from './BottomSheet.vue';

const { t } = useI18n();

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    /** Workspace groups (same list the desktop sidebar renders). */
    groups: WorkspaceGroup[];
    activeWorkspaceId: string | null;
    activeId: string;
    attentionBySession?: Record<string, number>;
    attentionByWorkspace?: Record<string, number>;
  }>(),
  {
    activeWorkspaceId: null,
    attentionBySession: () => ({}),
    attentionByWorkspace: () => ({}),
  },
);

const emit = defineEmits<{
  'update:modelValue': [open: boolean];
  select: [sessionId: string];
  createInWorkspace: [workspaceId: string];
  addWorkspace: [];
  rename: [id: string, title: string];
  delete: [id: string];
}>();

const totalSessionCount = computed(() =>
  props.groups.reduce((n, g) => n + g.sessions.length, 0),
);

function close(): void {
  emit('update:modelValue', false);
}

function onSelectSession(id: string): void {
  emit('select', id);
  close();
}

function onCreateInWorkspace(id: string): void {
  emit('createInWorkspace', id);
  close();
}

function onAddWorkspace(): void {
  emit('addWorkspace');
  close();
}

// ---------------------------------------------------------------------------
// Collapse groups — same interaction as the desktop sidebar header.
// ---------------------------------------------------------------------------
const collapsedIds = ref<Set<string>>(new Set());

function isCollapsed(id: string): boolean {
  return collapsedIds.value.has(id);
}

function toggleCollapse(id: string): void {
  const next = new Set(collapsedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsedIds.value = next;
}

function wsAttention(id: string): number {
  return props.attentionByWorkspace[id] ?? 0;
}

// ---------------------------------------------------------------------------
// Per-row kebab menu (rename / delete) — opened from the ⋯ button.
// ---------------------------------------------------------------------------
const menuFor = ref<string | null>(null);
function toggleMenu(id: string): void {
  menuFor.value = menuFor.value === id ? null : id;
}
function onRename(s: Session): void {
  menuFor.value = null;
  const next = typeof window !== 'undefined' ? window.prompt(t('sidebar.rename'), s.title) : null;
  const title = next?.trim();
  if (title) emit('rename', s.id, title);
}
function onDelete(id: string): void {
  menuFor.value = null;
  emit('delete', id);
}
</script>

<template>
  <BottomSheet
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- + New workspace (mirrors the sidebar's top button) -->
    <button type="button" class="newrow" @click="onAddWorkspace">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
        <path d="M8 3v10M3 8h10" />
      </svg>
      {{ t('sidebar.newWorkspace') }}
    </button>

    <!-- Workspace groups with their sessions -->
    <div class="mlist">
      <div v-if="totalSessionCount === 0 && groups.length === 0" class="mempty">
        {{ t('sidebar.emptyState') }}
      </div>

      <div v-for="g in groups" :key="g.workspace.id" class="mgroup">
        <div
          class="mgh"
          :class="{ on: g.workspace.id === activeWorkspaceId }"
          @click="toggleCollapse(g.workspace.id)"
        >
          <!-- Folder icon: open/closed mirrors the desktop sidebar -->
          <svg
            class="mgh-folder"
            width="15"
            height="15"
            viewBox="0 0 14 14"
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            aria-hidden="true"
          >
            <template v-if="isCollapsed(g.workspace.id)">
              <rect x="1" y="3.5" width="12" height="8.5" rx="1"/>
              <path d="M1 5V3.5A1 1 0 0 1 2 2.5h3.5l1.3 2"/>
            </template>
            <template v-else>
              <path d="M1 3.5V2.5A1 1 0 0 1 2 1.5h3.5l1.3 2h5.2a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1z"/>
              <path d="M1 5.5h12"/>
            </template>
          </svg>

          <div class="mgh-main">
            <span class="mgh-name">{{ g.workspace.name }}</span>
            <span class="mgh-path" :title="g.workspace.root">{{ g.workspace.branch || g.workspace.shortPath }}</span>
          </div>

          <span
            v-if="isCollapsed(g.workspace.id) && wsAttention(g.workspace.id) > 0"
            class="att"
          >{{ wsAttention(g.workspace.id) }}</span>

          <button
            type="button"
            class="mgh-add"
            :title="t('workspace.newInGroup')"
            :aria-label="t('workspace.newInGroup')"
            @click.stop="onCreateInWorkspace(g.workspace.id)"
          >+</button>
        </div>

        <div v-show="!isCollapsed(g.workspace.id)">
          <div v-if="g.sessions.length === 0" class="mempty small">{{ t('sidebar.emptyState') }}</div>
          <div
            v-for="s in g.sessions"
            :key="s.id"
            class="srow"
            :class="{ cur: s.id === activeId }"
            @click="onSelectSession(s.id)"
          >
            <div class="m">
              <div class="t">{{ s.title }}</div>
              <div class="s">{{ s.time }}</div>
            </div>
            <span v-if="(attentionBySession[s.id] ?? 0) > 0" class="att">{{ attentionBySession[s.id] }}</span>
            <button
              type="button"
              class="kb"
              :title="t('sidebar.options')"
              @click.stop="toggleMenu(s.id)"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
                <circle cx="8" cy="3" r="1.3" />
                <circle cx="8" cy="8" r="1.3" />
                <circle cx="8" cy="13" r="1.3" />
              </svg>
            </button>

            <!-- Kebab menu -->
            <div v-if="menuFor === s.id" class="kmenu" @click.stop>
              <button class="kitem" @click.stop="onRename(s)">{{ t('sidebar.rename') }}</button>
              <button class="kitem del" @click.stop="onDelete(s.id)">{{ t('sidebar.delete') }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </BottomSheet>
</template>

<style scoped>
/* ---- + New workspace row ---- */
.newrow {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 14px 16px;
  background: none;
  border: none;
  border-bottom: 1px solid var(--line2);
  color: var(--blue);
  font-family: var(--mono);
  font-weight: 600;
  font-size: 13.5px;
  cursor: pointer;
  text-align: left;
}
.newrow:active { background: var(--panel); }

/* ---- List + alignment contract (mirrors the desktop sidebar):
        session titles start at --m-pad + --m-gutter + --m-gap, exactly under
        the workspace name next to the folder icon. ---- */
.mlist {
  --m-pad: 16px;    /* row horizontal padding */
  --m-gutter: 15px; /* folder icon width */
  --m-gap: 8px;     /* gap between icon and text */
  --m-indent: calc(var(--m-pad) + var(--m-gutter) + var(--m-gap));
  padding-bottom: 4px;
}
.mempty {
  padding: 24px 16px;
  text-align: center;
  color: var(--faint);
  font-size: 14px;
}
.mempty.small { padding: 10px 16px 12px var(--m-indent); text-align: left; font-size: 12px; }

/* ---- Workspace group header ---- */
.mgroup { padding-top: 2px; }
.mgh {
  display: flex;
  align-items: center;
  gap: var(--m-gap);
  padding: 10px var(--m-pad) 6px;
  cursor: pointer;
  user-select: none;
}
.mgh:active { background: var(--panel); }
.mgh-folder { flex: none; color: var(--muted); }
.mgh-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.mgh-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mgh-path {
  font-size: 11px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mgh-add {
  flex: none;
  background: transparent;
  border: none;
  color: var(--faint);
  cursor: pointer;
  font-family: var(--mono);
  font-size: 20px;
  line-height: 1;
  /* 44px square tap target */
  width: 44px;
  height: 44px;
  margin: -10px -12px -10px 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mgh-add:active { color: var(--dim); }

/* ---- Session rows ---- */
.srow {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px var(--m-pad) 13px var(--m-indent);
  border-bottom: 1px solid var(--line2);
  cursor: pointer;
  position: relative;
}
.srow:active { background: var(--panel); }
.srow.cur { background: var(--bluebg); }
.srow .m { flex: 1; min-width: 0; }
.srow .m .t {
  font-size: 13.5px;
  color: var(--ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.srow.cur .m .t { font-weight: 600; color: var(--blue2); }
.srow .m .s {
  font-size: 11px;
  color: var(--faint);
  margin-top: 1px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.att {
  flex: none;
  font-family: var(--mono);
  font-size: 10px;
  color: #fff;
  background: var(--warn);
  border-radius: 10px;
  padding: 1px 7px;
}
.srow .kb {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--faint);
  padding: 4px;
}
.srow .kb:active { color: var(--ink); }

/* Kebab menu */
.kmenu {
  position: absolute;
  right: 12px;
  top: 44px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 6px;
  z-index: 10;
  box-shadow: 0 4px 16px rgba(18, 22, 30, 0.16);
  overflow: hidden;
  min-width: 96px;
}
.kitem {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font-family: var(--mono);
  font-size: 12.5px;
  color: var(--ink);
  padding: 10px 14px;
}
.kitem:active { background: var(--panel2); }
.kitem.del { color: var(--err); }
</style>
