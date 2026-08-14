<!-- apps/kimi-web/src/components/WorkspaceFileBrowser.vue -->
<!-- Workspace file browser: lazy directory tree (left) + file preview (right),
     opened from the chat header. Self-contained â€?pulls everything through
     getKimiWebApi() (relative-to-cwd paths), no shared client state. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi } from '../api';
import type { FsEntry } from '../api/types';
import { isDaemonApiError } from '../api/errors';
import Dialog from './ui/Dialog.vue';
import Icon from './ui/Icon.vue';
import Spinner from './ui/Spinner.vue';

const props = defineProps<{
  /** Session whose cwd is browsed. When unset the browser shows an empty state. */
  sessionId?: string;
  /** Absolute workspace root, shown in the header for orientation. */
  workspaceRoot?: string;
}>();

const emit = defineEmits<{
  'update:open': [value: boolean];
  close: [];
}>();

const { t } = useI18n();

const open = ref(false);
const emitOpen = (v: boolean) => {
  open.value = v;
  emit('update:open', v);
  if (!v) emit('close');
};

// ---------------------------------------------------------------------------
// Tree state: per-directory listing cache + expanded set, lazy-loaded.
// ---------------------------------------------------------------------------

/** Loaded directory listings, keyed by the directory's relative path ('' = cwd). */
const dirCache = ref<Map<string, FsEntry[] | null>>(new Map());
/** Directories currently expanded. */
const expanded = ref<Set<string>>(new Set());
const loadingDirs = ref<Set<string>>(new Set());
const treeError = ref<string | null>(null);

function isDirectory(entry: FsEntry): boolean {
  return entry.kind === 'directory';
}

async function loadDir(dirPath: string): Promise<FsEntry[]> {
  const sid = props.sessionId;
  if (!sid) return [];
  loadingDirs.value = new Set(loadingDirs.value).add(dirPath);
  treeError.value = null;
  try {
    const result = await getKimiWebApi().listDirectory(sid, {
      path: dirPath,
      depth: 1,
      includeGitStatus: true,
    });
    const next = new Map(dirCache.value);
    next.set(dirPath, result.items);
    dirCache.value = next;
    return result.items;
  } catch (err) {
    treeError.value = isDaemonApiError(err) ? err.message : String(err);
    const next = new Map(dirCache.value);
    next.set(dirPath, []);
    dirCache.value = next;
    return [];
  } finally {
    const rest = new Set(loadingDirs.value);
    rest.delete(dirPath);
    loadingDirs.value = rest;
  }
}

async function toggleDir(entry: FsEntry): Promise<void> {
  const path = entry.path;
  const next = new Set(expanded.value);
  if (next.has(path)) {
    next.delete(path);
    expanded.value = next;
    return;
  }
  next.add(path);
  expanded.value = next;
  if (!dirCache.value.has(path)) {
    await loadDir(path);
  }
}

function dirChildren(dirPath: string): FsEntry[] {
  return dirCache.value.get(dirPath) ?? [];
}

async function refresh(): Promise<void> {
  dirCache.value = new Map();
  expanded.value = new Set();
  selectedPath.value = null;
  preview.value = null;
  await loadDir('');
}

// ---------------------------------------------------------------------------
// File preview
// ---------------------------------------------------------------------------

interface PreviewData {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mime: string;
  isBinary: boolean;
  size: number;
  lineCount?: number;
  truncated: boolean;
  languageId?: string;
}

const selectedPath = ref<string | null>(null);
const preview = ref<PreviewData | null>(null);
const previewLoading = ref(false);
const previewError = ref<string | null>(null);
let previewSeq = 0;

async function openFile(entry: FsEntry): Promise<void> {
  const sid = props.sessionId;
  if (!sid || entry.kind === 'directory') return;
  const seq = ++previewSeq;
  selectedPath.value = entry.path;
  preview.value = null;
  previewError.value = null;
  previewLoading.value = true;
  try {
    const result = await getKimiWebApi().readFile(sid, { path: entry.path, length: 256 * 1024 });
    if (seq !== previewSeq) return;
    preview.value = {
      path: result.path || entry.path,
      content: result.content,
      encoding: result.encoding,
      mime: result.mime,
      isBinary: result.isBinary,
      size: result.size,
      lineCount: result.lineCount,
      truncated: result.truncated,
      languageId: result.languageId,
    };
  } catch (err) {
    if (seq !== previewSeq) return;
    previewError.value = isDaemonApiError(err) ? err.message : String(err);
  } finally {
    if (seq === previewSeq) previewLoading.value = false;
  }
}

const previewText = computed(() =>
  preview.value && preview.value.encoding === 'utf-8' ? preview.value.content : null,
);
const previewImageSrc = computed(() => {
  const p = preview.value;
  if (!p || p.encoding !== 'base64' || !p.mime.startsWith('image/')) return null;
  return `data:${p.mime};base64,${p.content}`;
});
const downloadUrl = computed(() => {
  const p = preview.value;
  return p && props.sessionId ? getKimiWebApi().getFileDownloadUrl(props.sessionId, p.path) : null;
});

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const sizeLine = computed(() => {
  const p = preview.value;
  if (!p) return '';
  const size = formatSize(p.size);
  if (p.lineCount !== undefined && p.lineCount > 0) {
    return t('fileTree.size', { size, lines: String(p.lineCount) });
  }
  return size;
});

// ---------------------------------------------------------------------------
// Git status badges
// ---------------------------------------------------------------------------

const GIT_STATUS_LABEL: Record<string, string> = {
  M: 'fileTree.gitModified',
  A: 'fileTree.gitAdded',
  D: 'fileTree.gitDeleted',
  U: 'fileTree.gitConflict',
  '??': 'fileTree.gitUntracked',
};

function gitLabel(status: string | undefined): string | null {
  if (!status) return null;
  return GIT_STATUS_LABEL[status] ?? null;
}

function gitClass(status: string | undefined): string {
  if (status === 'M') return 'st-modified';
  if (status === 'A') return 'st-added';
  if (status === 'D') return 'st-deleted';
  if (status === 'U') return 'st-conflict';
  return 'st-untracked';
}

// ---------------------------------------------------------------------------
// Lifecycle: load the root when the dialog opens.
// ---------------------------------------------------------------------------

watch(open, (isOpen) => {
  if (isOpen) {
    void loadDir('');
  }
});

onBeforeUnmount(() => {
  previewSeq += 1;
});
</script>

<template>
  <Dialog
    :open="open"
    size="xl"
    height="fixed"
    :padded="false"
    close-on-overlay
    @update:open="emitOpen"
  >
    <template #head>
      <div class="wfb-head">
        <div>
          <div class="wfb-title">{{ t('fileTree.title') }}</div>
          <div v-if="workspaceRoot" class="wfb-root" :title="workspaceRoot">{{ workspaceRoot }}</div>
        </div>
        <button type="button" class="wfb-refresh" @click="refresh">
          {{ t('fileTree.refresh') }}
        </button>
      </div>
    </template>

    <div class="wfb-body">
      <!-- Left: directory tree -->
      <div class="wfb-tree">
        <div v-if="loadingDirs.has('') && dirCache.get('') === undefined" class="wfb-loading">
          <Spinner size="sm" />
          <span>{{ t('fileTree.loading') }}</span>
        </div>
        <template v-else>
          <div v-if="dirChildren('').length === 0" class="wfb-empty">{{ t('fileTree.empty') }}</div>
          <div v-for="entry in dirChildren('')" :key="entry.path" class="wfb-row">
            <div
              v-if="isDirectory(entry)"
              class="wfb-row-main wfb-dir"
              role="button"
              :tabindex="0"
              @click="toggleDir(entry)"
              @keydown.enter="toggleDir(entry)"
              @keydown.space.prevent="toggleDir(entry)"
            >
              <Icon class="wfb-chevron" :class="{ open: expanded.has(entry.path) }" name="chevron-right" size="sm" />
              <Icon class="wfb-folder" name="folder" size="sm" />
              <span class="wfb-name">{{ entry.name }}</span>
              <span v-if="expanded.has(entry.path)" class="wfb-spin">
                <Spinner v-if="loadingDirs.has(entry.path)" size="sm" />
              </span>
            </div>
            <div
              v-else
              class="wfb-row-main wfb-file"
              :class="{ selected: selectedPath === entry.path }"
              role="button"
              :tabindex="0"
              @click="openFile(entry)"
              @keydown.enter="openFile(entry)"
              @keydown.space.prevent="openFile(entry)"
            >
              <Icon class="wfb-folder" name="file-text" size="sm" />
              <span class="wfb-name">{{ entry.name }}</span>
              <span v-if="gitLabel(entry.gitStatus)" class="wfb-git" :class="gitClass(entry.gitStatus)">
                {{ t(gitLabel(entry.gitStatus)!) }}
              </span>
            </div>
            <!-- Lazy children of an expanded directory -->
            <div v-if="isDirectory(entry) && expanded.has(entry.path)" class="wfb-children">
              <div v-if="loadingDirs.has(entry.path)" class="wfb-loading wfb-inline">
                <Spinner size="sm" />
              </div>
              <div v-else-if="dirChildren(entry.path).length === 0" class="wfb-empty wfb-inline">
                {{ t('fileTree.empty') }}
              </div>
              <div v-for="child in dirChildren(entry.path)" :key="child.path" class="wfb-row">
                <div
                  v-if="isDirectory(child)"
                  class="wfb-row-main wfb-dir"
                  role="button"
                  :tabindex="0"
                  @click="toggleDir(child)"
                  @keydown.enter="toggleDir(child)"
                  @keydown.space.prevent="toggleDir(child)"
                >
                  <Icon class="wfb-chevron" :class="{ open: expanded.has(child.path) }" name="chevron-right" size="sm" />
                  <Icon class="wfb-folder" name="folder" size="sm" />
                  <span class="wfb-name">{{ child.name }}</span>
                  <span v-if="expanded.has(child.path)" class="wfb-spin">
                    <Spinner v-if="loadingDirs.has(child.path)" size="sm" />
                  </span>
                </div>
                <div
                  v-else
                  class="wfb-row-main wfb-file"
                  :class="{ selected: selectedPath === child.path }"
                  role="button"
                  :tabindex="0"
                  @click="openFile(child)"
                  @keydown.enter="openFile(child)"
                  @keydown.space.prevent="openFile(child)"
                >
                  <Icon class="wfb-folder" name="file-text" size="sm" />
                  <span class="wfb-name">{{ child.name }}</span>
                  <span v-if="gitLabel(child.gitStatus)" class="wfb-git" :class="gitClass(child.gitStatus)">
                    {{ t(gitLabel(child.gitStatus)!) }}
                  </span>
                </div>
                <div v-if="isDirectory(child) && expanded.has(child.path)" class="wfb-children">
                  <div v-if="loadingDirs.has(child.path)" class="wfb-loading wfb-inline">
                    <Spinner size="sm" />
                  </div>
                  <div v-else-if="dirChildren(child.path).length === 0" class="wfb-empty wfb-inline">
                    {{ t('fileTree.empty') }}
                  </div>
                  <div v-for="grand in dirChildren(child.path)" :key="grand.path" class="wfb-row">
                    <div
                      v-if="isDirectory(grand)"
                      class="wfb-row-main wfb-dir"
                      role="button"
                      :tabindex="0"
                      @click="toggleDir(grand)"
                      @keydown.enter="toggleDir(grand)"
                      @keydown.space.prevent="toggleDir(grand)"
                    >
                      <Icon class="wfb-chevron" :class="{ open: expanded.has(grand.path) }" name="chevron-right" size="sm" />
                      <Icon class="wfb-folder" name="folder" size="sm" />
                      <span class="wfb-name">{{ grand.name }}</span>
                    </div>
                    <div
                      v-else
                      class="wfb-row-main wfb-file"
                      :class="{ selected: selectedPath === grand.path }"
                      role="button"
                      :tabindex="0"
                      @click="openFile(grand)"
                      @keydown.enter="openFile(grand)"
                      @keydown.space.prevent="openFile(grand)"
                    >
                      <Icon class="wfb-folder" name="file-text" size="sm" />
                      <span class="wfb-name">{{ grand.name }}</span>
                      <span v-if="gitLabel(grand.gitStatus)" class="wfb-git" :class="gitClass(grand.gitStatus)">
                        {{ t(gitLabel(grand.gitStatus)!) }}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-if="treeError" class="wfb-error">{{ treeError }}</div>
        </template>
      </div>

      <!-- Right: file preview -->
      <div class="wfb-preview">
        <div v-if="previewLoading" class="wfb-preview-center">
          <Spinner size="sm" />
        </div>
        <div v-else-if="previewError" class="wfb-preview-center wfb-error">
          {{ previewError }}
        </div>
        <div v-else-if="preview" class="wfb-preview-body">
          <div class="wfb-preview-head">
            <span class="wfb-preview-path" :title="preview.path">{{ preview.path }}</span>
            <span v-if="sizeLine" class="wfb-preview-size">{{ sizeLine }}</span>
            <a
              v-if="downloadUrl"
              class="wfb-download"
              :href="downloadUrl"
              download
              :aria-label="t('fileTree.download')"
            >
              <Icon name="download" size="sm" />
              <span>{{ t('fileTree.download') }}</span>
            </a>
          </div>
          <div v-if="previewImageSrc" class="wfb-image-wrap">
            <img :src="previewImageSrc" :alt="preview.path" class="wfb-image" />
          </div>
          <div v-else-if="preview.isBinary" class="wfb-preview-center">
            {{ t('fileTree.binary') }}
          </div>
          <pre v-else-if="previewText !== null" class="wfb-pre"><code>{{ previewText }}</code></pre>
          <div v-if="preview.truncated" class="wfb-truncated">
            {{ t('fileTree.truncated', { shown: '256 KB', total: formatSize(preview.size) }) }}
          </div>
        </div>
        <div v-else class="wfb-preview-center wfb-empty">{{ t('fileTree.empty') }}</div>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.wfb-head {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.wfb-title {
  font-size: var(--text-lg);
  font-weight: 500;
  color: var(--color-text);
  line-height: var(--leading-tight);
}
.wfb-root {
  margin-top: 3px;
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 420px;
}
.wfb-refresh {
  flex: none;
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  padding: 3px 10px;
  cursor: pointer;
}
.wfb-refresh:hover {
  border-color: var(--color-line-strong);
  color: var(--color-text);
}

.wfb-body {
  display: flex;
  height: 100%;
  min-height: 0;
}

/* ---- tree column ---- */
.wfb-tree {
  flex: none;
  width: 300px;
  border-right: 1px solid var(--color-line);
  overflow-y: auto;
  padding: 8px 6px;
  font-size: var(--text-base);
}
.wfb-row { min-width: 0; }
.wfb-children { margin-left: 14px; }
.wfb-row-main {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 6px;
  border-radius: var(--radius-xs);
  min-width: 0;
  cursor: pointer;
  outline: none;
}
.wfb-row-main:hover { background: var(--color-surface-sunken); }
.wfb-row-main:focus-visible { outline: 2px solid var(--color-accent); outline-offset: -1px; }
.wfb-file.selected { background: var(--color-accent-soft); }
.wfb-chevron {
  flex: none;
  color: var(--color-text-faint);
  transition: transform 0.12s;
}
.wfb-chevron.open { transform: rotate(90deg); }
.wfb-folder { flex: none; color: var(--color-text-faint); }
.wfb-file.selected .wfb-folder { color: var(--color-accent-hover); }
.wfb-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text);
}
.wfb-spin { flex: none; display: inline-flex; }
.wfb-git {
  flex: none;
  font-size: calc(var(--text-xs) - 1px);
  padding: 0 5px;
  border-radius: 999px;
}
.st-modified { color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 12%, transparent); }
.st-added { color: var(--color-success); background: color-mix(in srgb, var(--color-success) 12%, transparent); }
.st-deleted { color: var(--color-danger); background: color-mix(in srgb, var(--color-danger) 12%, transparent); }
.st-conflict { color: var(--color-danger); background: color-mix(in srgb, var(--color-danger) 12%, transparent); }
.st-untracked { color: var(--color-text-muted); background: var(--color-surface-sunken); }

.wfb-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  color: var(--color-text-muted);
  font-size: var(--text-base);
}
.wfb-inline { padding: 4px 8px; }
.wfb-empty {
  padding: 12px;
  text-align: center;
  color: var(--color-text-faint);
  font-size: var(--text-base);
}
.wfb-error {
  padding: 10px;
  color: var(--color-danger);
  font-size: var(--text-base);
  overflow-wrap: anywhere;
}

/* ---- preview column ---- */
.wfb-preview {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
}
.wfb-preview-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-faint);
  font-size: var(--text-base);
  padding: 16px;
  text-align: center;
}
.wfb-preview-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.wfb-preview-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--color-line);
  min-width: 0;
}
.wfb-preview-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-text);
}
.wfb-preview-size {
  flex: none;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
}
.wfb-download {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  padding: 3px 10px;
  cursor: pointer;
  text-decoration: none;
}
.wfb-download:hover {
  border-color: var(--color-line-strong);
  color: var(--color-text);
}
.wfb-pre {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 12px 14px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.55;
  color: var(--color-text);
  white-space: pre-wrap;
  word-break: break-word;
}
.wfb-image-wrap {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.wfb-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.wfb-truncated {
  flex: none;
  padding: 6px 14px;
  border-top: 1px solid var(--color-line);
  font-size: var(--text-xs);
  color: var(--color-warning);
}

/* Mobile: stack the two columns. */
@media (max-width: 640px) {
  .wfb-body { flex-direction: column; }
  .wfb-tree {
    width: 100%;
    max-height: 40%;
    border-right: none;
    border-bottom: 1px solid var(--color-line);
  }
}
</style>
