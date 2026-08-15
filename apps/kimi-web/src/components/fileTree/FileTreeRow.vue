<!-- apps/kimi-web/src/components/fileTree/FileTreeRow.vue -->
<!-- Recursive row of the workspace file tree: a directory row expands into
     its (lazy-loaded) children rendered by nested FileTreeRow instances; a
     file row selects the file for preview. State comes from the shared
     file-tree store (provide/inject) so the dialog and every level share one
     cache. -->
<script setup lang="ts">
import { useI18n } from 'vue-i18n';

import {
  useFileTreeBrowser,
  sortEntries,
  gitLabel,
  gitClass,
} from '../../composables/useFileTreeBrowser';
import Icon from '../ui/Icon.vue';
import Spinner from '../ui/Spinner.vue';

defineOptions({ name: 'FileTreeRow' });

const props = defineProps<{
  /** Directory whose children this level renders. */
  dirPath: string;
  /** Optional name filter for file rows (directories always visible). */
  filter?: string;
}>();

const emit = defineEmits<{
  openFile: [entry: { path: string; name: string }];
}>();

const { t } = useI18n();
const store = useFileTreeBrowser();

const entries = store.dirChildren(props.dirPath);
const sorted = sortEntries(entries);
const filterValue = (props.filter ?? '').trim().toLowerCase();
const visible =
  filterValue !== ''
    ? sorted.filter((e) => store.isDirectory(e) || e.name.toLowerCase().includes(filterValue))
    : sorted;
</script>

<template>
  <div class="ft-rows">
    <div v-for="entry in visible" :key="entry.path" class="ft-row">
      <div
        v-if="store.isDirectory(entry)"
        class="ft-row-main ft-dir"
        role="button"
        :tabindex="0"
        @click="store.toggleDir(entry)"
        @keydown.enter="store.toggleDir(entry)"
        @keydown.space.prevent="store.toggleDir(entry)"
      >
        <Icon
          class="ft-chevron"
          :class="{ open: store.expanded.value.has(entry.path) }"
          name="chevron-right"
          size="sm"
        />
        <Icon class="ft-folder" name="folder" size="sm" />
        <span class="ft-name">{{ entry.name }}</span>
        <span v-if="store.expanded.value.has(entry.path)" class="ft-spin">
          <Spinner v-if="store.loadingDirs.value.has(entry.path)" size="sm" />
        </span>
      </div>
      <div
        v-else
        class="ft-row-main ft-file"
        :class="{ selected: store.selectedPath.value === entry.path }"
        role="button"
        :tabindex="0"
        @click="emit('openFile', { path: entry.path, name: entry.name })"
        @keydown.enter="emit('openFile', { path: entry.path, name: entry.name })"
        @keydown.space.prevent="emit('openFile', { path: entry.path, name: entry.name })"
      >
        <Icon class="ft-folder" name="file-text" size="sm" />
        <span class="ft-name">{{ entry.name }}</span>
        <span v-if="gitLabel(entry.gitStatus)" class="ft-git" :class="gitClass(entry.gitStatus)">
          {{ t(gitLabel(entry.gitStatus)!) }}
        </span>
      </div>
      <!-- Recursive children of an expanded directory -->
      <div
        v-if="store.isDirectory(entry) && store.expanded.value.has(entry.path)"
        class="ft-children"
      >
        <div v-if="store.loadingDirs.value.has(entry.path)" class="ft-loading ft-inline">
          <Spinner size="sm" />
          <span>{{ t('fileTree.loading') }}</span>
        </div>
        <div v-else-if="store.dirChildren(entry.path).length === 0" class="ft-empty ft-inline">
          {{ t('fileTree.empty') }}
        </div>
        <FileTreeRow
          v-else
          :dir-path="entry.path"
          :filter="filter"
          @open-file="(payload) => emit('openFile', payload)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.ft-rows {
  min-width: 0;
}
.ft-row {
  min-width: 0;
}
.ft-children {
  margin-left: 14px;
}
.ft-row-main {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 6px;
  border-radius: var(--radius-xs);
  min-width: 0;
  cursor: pointer;
  outline: none;
}
.ft-row-main:hover {
  background: var(--color-surface-sunken);
}
.ft-row-main:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -1px;
}
.ft-file.selected {
  background: var(--color-accent-soft);
}
.ft-chevron {
  flex: none;
  color: var(--color-text-faint);
  transition: transform 0.12s;
}
.ft-chevron.open {
  transform: rotate(90deg);
}
.ft-folder {
  flex: none;
  color: var(--color-text-faint);
}
.ft-file.selected .ft-folder {
  color: var(--color-accent-hover);
}
.ft-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}
.ft-spin {
  flex: none;
  display: inline-flex;
}
.ft-git {
  flex: none;
  font-size: calc(var(--text-xs) - 1px);
  padding: 0 5px;
  border-radius: 999px;
}
.st-modified {
  color: var(--color-warning);
  background: color-mix(in srgb, var(--color-warning) 12%, transparent);
}
.st-added {
  color: var(--color-success);
  background: color-mix(in srgb, var(--color-success) 12%, transparent);
}
.st-deleted {
  color: var(--color-danger);
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
}
.st-conflict {
  color: var(--color-danger);
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
}
.st-untracked {
  color: var(--color-text-muted);
  background: var(--color-surface-sunken);
}

.ft-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  color: var(--color-text-muted);
  font-size: var(--text-base);
}
.ft-inline {
  padding: 4px 8px;
}
.ft-empty {
  padding: 6px 8px;
  color: var(--color-text-faint);
  font-size: var(--text-base);
}
</style>
