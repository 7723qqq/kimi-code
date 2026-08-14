<!-- apps/kimi-web/src/components/WorkspaceFileBrowser.vue -->
<!-- Workspace file browser: lazy recursive directory tree (left) + file
     preview (right), opened from the chat header. Self-contained — pulls
     everything through getKimiWebApi() (relative-to-cwd paths). The tree is
     rendered by the recursive FileTreeRow over a shared provide/inject
     store; a name filter narrows file rows, directories sort first. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi } from '../api';
import { isDaemonApiError } from '../api/errors';
import {
  createFileTreeBrowserStore,
  provideFileTreeBrowser,
} from '../composables/useFileTreeBrowser';
import Dialog from './ui/Dialog.vue';
import Icon from './ui/Icon.vue';
import Spinner from './ui/Spinner.vue';
import FileTreeRow from './fileTree/FileTreeRow.vue';

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
// Tree store (shared with the recursive rows)
// ---------------------------------------------------------------------------

const sessionIdRef = computed(() => props.sessionId);
const store = createFileTreeBrowserStore(sessionIdRef);
provideFileTreeBrowser(store);

// Name filter for file rows (directories always visible).
const filter = ref('');

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

const preview = ref<PreviewData | null>(null);
const previewLoading = ref(false);
const previewError = ref<string | null>(null);
let previewSeq = 0;

async function openFile(entry: { path: string; name: string }): Promise<void> {
  const sid = props.sessionId;
  if (!sid) return;
  const seq = ++previewSeq;
  store.selectedPath.value = entry.path;
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
// Lifecycle: load the root when the dialog opens.
// ---------------------------------------------------------------------------

watch(open, (isOpen) => {
  if (isOpen) {
    store.reset();
    void store.loadDir('');
  }
});

function refresh(): void {
  store.reset();
  void store.loadDir('');
}

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
        <div class="wfb-head-actions">
          <input
            v-model="filter"
            class="wfb-filter"
            type="search"
            :placeholder="t('fileTree.filter')"
            :aria-label="t('fileTree.filter')"
          />
          <button type="button" class="wfb-refresh" @click="refresh">
            {{ t('fileTree.refresh') }}
          </button>
        </div>
      </div>
    </template>

    <div class="wfb-body">
      <!-- Left: directory tree -->
      <div class="wfb-tree">
        <div v-if="store.loadingDirs.value.has('') && store.dirCache.value.get('') === undefined" class="wfb-loading">
          <Spinner size="sm" />
          <span>{{ t('fileTree.loading') }}</span>
        </div>
        <template v-else>
          <div v-if="store.dirChildren('').length === 0" class="wfb-empty">{{ t('fileTree.empty') }}</div>
          <FileTreeRow
            v-else
            :dir-path="''"
            :filter="filter"
            @open-file="openFile"
          />
          <div v-if="store.treeError" class="wfb-error">{{ store.treeError }}</div>
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
.wfb-head-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
}
.wfb-filter {
  width: 180px;
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  color: var(--color-text);
  font-size: var(--text-xs);
  padding: 4px 9px;
  outline: none;
}
.wfb-filter:focus { border-color: var(--color-accent); }
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

.wfb-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  color: var(--color-text-muted);
  font-size: var(--text-base);
}
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
  .wfb-filter { width: 120px; }
}
</style>
