<!-- apps/kimi-web/src/components/FilePreview.vue -->
<!-- File preview pane: renders text/markdown/json/image/binary by mime and encoding. -->
<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Markdown from './Markdown.vue';

const { t } = useI18n();

export interface FileData {
  path: string;
  content: string;
  encoding: 'utf-8' | 'base64';
  mime: string;
  languageId?: string;
  isBinary: boolean;
  size: number;
  lineCount?: number;
}

const props = defineProps<{
  file: FileData | null;
  loading: boolean;
  error?: string | null;
  line?: number;
  downloadUrl?: string | null;
  closable?: boolean;
  externalActions?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  openExternal: [];
  reveal: [];
}>();

const rootRef = ref<HTMLElement | null>(null);

// ---------------------------------------------------------------------------
// Content type detection
// ---------------------------------------------------------------------------

type ContentKind = 'markdown' | 'json' | 'html' | 'pdf' | 'csv' | 'image' | 'text' | 'binary';

const contentKind = computed<ContentKind>(() => {
  const f = props.file;
  if (!f) return 'binary';
  const mime = f.mime ?? '';
  const lang = f.languageId ?? '';
  const lowerPath = f.path.toLowerCase();

  if (mime === 'text/markdown' || lang === 'markdown' || lang === 'md') return 'markdown';
  if (mime === 'application/json' || lang === 'json') return 'json';
  if (mime === 'text/html' || lang === 'html' || lowerPath.endsWith('.html') || lowerPath.endsWith('.htm')) return 'html';
  if (mime === 'application/pdf' || lowerPath.endsWith('.pdf')) return 'pdf';
  if (mime === 'text/csv' || lang === 'csv' || lowerPath.endsWith('.csv')) return 'csv';
  if (mime.startsWith('image/')) return 'image';
  if (f.isBinary) return 'binary';
  // text/* and code files
  if (mime.startsWith('text/') || lang !== '') return 'text';
  return 'binary';
});

// ---------------------------------------------------------------------------
// JSON pretty-print
// ---------------------------------------------------------------------------

const prettyJson = computed<string>(() => {
  if (contentKind.value !== 'json' || !props.file) return '';
  try {
    return JSON.stringify(JSON.parse(props.file.content), null, 2);
  } catch {
    return props.file.content;
  }
});

// ---------------------------------------------------------------------------
// Line numbers for code/text
// ---------------------------------------------------------------------------

const lines = computed<string[]>(() => {
  const f = props.file;
  if (!f) return [];
  const src = contentKind.value === 'json' ? prettyJson.value : f.content;
  return src.split('\n');
});

const sourceText = computed<string>(() => {
  if (!props.file) return '';
  return contentKind.value === 'json' ? prettyJson.value : props.file.content;
});

// ---------------------------------------------------------------------------
// Search + jump-to-line
// ---------------------------------------------------------------------------

const searchQuery = ref('');
const activeMatch = ref(0);

const searchMatches = computed<number[]>(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  lines.value.forEach((line, idx) => {
    if (line.toLowerCase().includes(q)) out.push(idx + 1);
  });
  return out;
});

watch(searchQuery, () => {
  activeMatch.value = 0;
});

function scrollToLine(line: number | undefined): void {
  if (!line) return;
  void nextTick(() => {
    const el = rootRef.value?.querySelector<HTMLElement>(`[data-line="${line}"]`);
    el?.scrollIntoView({ block: 'center' });
  });
}

watch(
  () => [props.file?.path, props.line] as const,
  () => scrollToLine(props.line),
  { immediate: true },
);

function nextMatch(delta: number): void {
  const matches = searchMatches.value;
  if (matches.length === 0) return;
  activeMatch.value = (activeMatch.value + delta + matches.length) % matches.length;
  scrollToLine(matches[activeMatch.value]);
}

function lineClass(lineNo: number): Record<string, boolean> {
  const matches = searchMatches.value;
  return {
    target: props.line === lineNo,
    hit: matches.includes(lineNo),
    active: matches[activeMatch.value] === lineNo,
  };
}

// ---------------------------------------------------------------------------
// Size formatter
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

const copied = ref(false);
const copiedPath = ref(false);

function copyContent(): void {
  if (!props.file) return;
  navigator.clipboard.writeText(sourceText.value).then(() => {
    copied.value = true;
    setTimeout(() => { copied.value = false; }, 1400);
  }).catch(() => {/* ignore */});
}

function copyPath(): void {
  if (!props.file) return;
  navigator.clipboard.writeText(props.file.path).then(() => {
    copiedPath.value = true;
    setTimeout(() => { copiedPath.value = false; }, 1400);
  }).catch(() => {/* ignore */});
}

// ---------------------------------------------------------------------------
// Rich previews
// ---------------------------------------------------------------------------

const htmlMode = ref<'preview' | 'source'>('preview');
const imageFit = ref<'fit' | 'actual'>('fit');

watch(contentKind, (kind) => {
  htmlMode.value = kind === 'html' ? 'preview' : 'source';
  imageFit.value = 'fit';
});

const imageSrc = computed<string | null>(() => {
  const f = props.file;
  if (!f || contentKind.value !== 'image') return null;
  if (f.encoding === 'base64') return `data:${f.mime};base64,${f.content}`;
  if (f.mime === 'image/svg+xml') {
    return `data:${f.mime};charset=utf-8,${encodeURIComponent(f.content)}`;
  }
  return null;
});

const pdfSrc = computed<string | null>(() => {
  const f = props.file;
  if (!f || contentKind.value !== 'pdf') return null;
  if (props.downloadUrl) return props.downloadUrl;
  if (f.encoding === 'base64') return `data:${f.mime};base64,${f.content}`;
  return null;
});

const htmlSrcdoc = computed<string>(() => {
  const f = props.file;
  if (!f) return '';
  return [
    '<!doctype html>',
    '<meta charset="utf-8">',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; style-src \'unsafe-inline\'; font-src data:;">',
    f.content,
  ].join('');
});

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"' && line[i + 1] === '"') {
      current += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

const csvRows = computed<string[][]>(() => lines.value.slice(0, 200).map(parseCsvLine));

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function languageKey(): string {
  const f = props.file;
  if (!f) return '';
  const lang = f.languageId?.toLowerCase();
  if (lang) return lang;
  return f.path.split('.').pop()?.toLowerCase() ?? '';
}

function highlightLine(line: string): string {
  const lang = languageKey();
  let html = escapeHtml(line);

  if (contentKind.value === 'json' || lang === 'json' || lang === 'jsonc') {
    html = html.replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="tok-key">$1</span>$2');
    html = html.replace(/(:\s*)(&quot;[^&]*?&quot;)/g, '$1<span class="tok-string">$2</span>');
    html = html.replace(/\b(true|false|null)\b/g, '<span class="tok-literal">$1</span>');
    html = html.replace(/(:\s*)(-?\d+(?:\.\d+)?)/g, '$1<span class="tok-number">$2</span>');
    return html;
  }

  if (contentKind.value === 'html' || lang === 'html' || lang === 'xml' || lang === 'svg') {
    html = html.replace(/\s([A-Za-z_:][-A-Za-z0-9_:.]*)(=)/g, ' <span class="tok-attr">$1</span>$2');
    html = html.replace(/(&quot;.*?&quot;)/g, '<span class="tok-string">$1</span>');
    html = html.replace(/(&lt;\/?)([A-Za-z][\w:-]*)/g, '$1<span class="tok-tag">$2</span>');
    return html;
  }

  html = html.replace(
    /\b(async|await|break|case|catch|class|const|continue|else|export|extends|finally|for|from|function|if|import|interface|let|new|return|switch|throw|try|type|while)\b/g,
    '<span class="tok-keyword">$1</span>',
  );
  html = html.replace(/(&quot;.*?&quot;|'.*?')/g, '<span class="tok-string">$1</span>');
  html = html.replace(/(\/\/.*)$/g, '<span class="tok-comment">$1</span>');
  return html;
}

// ---------------------------------------------------------------------------
// Path display (truncate-left for long paths)
// ---------------------------------------------------------------------------

function truncatePath(path: string, maxLen = 55): string {
  if (!path || path.length <= maxLen) return path;
  return '…' + path.slice(path.length - maxLen + 1);
}
</script>

<template>
  <div ref="rootRef" class="file-preview">
    <!-- Empty state: nothing selected -->
    <div v-if="error && !loading" class="fp-empty fp-error">
      <span>{{ error }}</span>
      <button v-if="closable" type="button" class="fp-action" @click="emit('close')">
        {{ t('filePreview.close') }}
      </button>
    </div>

    <div v-else-if="!file && !loading" class="fp-empty">
      {{ t('filePreview.empty') }}
    </div>

    <!-- Loading state -->
    <div v-else-if="loading" class="fp-loading">
      <span class="spinner"></span>
      <span>{{ t('filePreview.loading') }}</span>
    </div>

    <!-- File loaded -->
    <template v-else-if="file">
      <!-- Header -->
      <div class="fp-header">
        <span class="fp-path" :title="file.path">{{ truncatePath(file.path) }}</span>
        <span class="fp-meta">
          <span v-if="file.lineCount" class="fp-lines">{{ t('filePreview.lineCount', { count: file.lineCount }) }}</span>
          <span class="fp-size">{{ formatSize(file.size) }}</span>
        </span>
        <div v-if="contentKind === 'html'" class="fp-seg" role="group" :aria-label="t('filePreview.htmlMode')">
          <button
            type="button"
            class="fp-seg-btn"
            :class="{ on: htmlMode === 'preview' }"
            @click="htmlMode = 'preview'"
          >{{ t('filePreview.preview') }}</button>
          <button
            type="button"
            class="fp-seg-btn"
            :class="{ on: htmlMode === 'source' }"
            @click="htmlMode = 'source'"
          >{{ t('filePreview.source') }}</button>
        </div>
        <div v-if="contentKind === 'image'" class="fp-seg" role="group" :aria-label="t('filePreview.imageFit')">
          <button
            type="button"
            class="fp-seg-btn"
            :class="{ on: imageFit === 'fit' }"
            @click="imageFit = 'fit'"
          >{{ t('filePreview.fit') }}</button>
          <button
            type="button"
            class="fp-seg-btn"
            :class="{ on: imageFit === 'actual' }"
            @click="imageFit = 'actual'"
          >{{ t('filePreview.actual') }}</button>
        </div>
        <div v-if="contentKind === 'text' || contentKind === 'json' || contentKind === 'html' || contentKind === 'csv'" class="fp-search">
          <input
            v-model="searchQuery"
            class="fp-search-input"
            type="search"
            :placeholder="t('filePreview.search')"
          />
          <span v-if="searchQuery.trim()" class="fp-search-count">
            {{ searchMatches.length }}
          </span>
          <button type="button" class="fp-icon-btn" :disabled="searchMatches.length === 0" :title="t('filePreview.prevMatch')" @click="nextMatch(-1)">↑</button>
          <button type="button" class="fp-icon-btn" :disabled="searchMatches.length === 0" :title="t('filePreview.nextMatch')" @click="nextMatch(1)">↓</button>
        </div>
        <button type="button" class="fp-action" :class="{ copied: copiedPath }" @click="copyPath">
          {{ copiedPath ? t('filePreview.copied') : t('filePreview.copyPath') }}
        </button>
        <button v-if="externalActions" type="button" class="fp-action" @click="emit('openExternal')">
          {{ t('filePreview.openInEditor') }}
        </button>
        <button v-if="externalActions" type="button" class="fp-action" @click="emit('reveal')">
          {{ t('filePreview.reveal') }}
        </button>
        <a
          v-if="downloadUrl"
          class="fp-action"
          :href="downloadUrl"
          target="_blank"
          rel="noreferrer"
          download
        >
          {{ t('filePreview.download') }}
        </a>
        <button
          v-if="!file.isBinary && contentKind !== 'image'"
          type="button"
          class="fp-action"
          :class="{ copied }"
          @click="copyContent"
        >
          {{ copied ? t('filePreview.copied') : t('filePreview.copy') }}
        </button>
        <button v-if="closable" type="button" class="fp-close" :title="t('filePreview.close')" @click="emit('close')">
          ×
        </button>
      </div>

      <!-- Body: Markdown -->
      <div v-if="contentKind === 'markdown'" class="fp-body fp-markdown">
        <Markdown :text="file.content" />
      </div>

      <!-- Body: JSON -->
      <div v-else-if="contentKind === 'json'" class="fp-body fp-code">
        <div class="fp-line-table">
          <div
            v-for="(line, idx) in lines"
            :key="idx"
            class="fp-line-row"
            :class="lineClass(idx + 1)"
            :data-line="idx + 1"
          >
            <span class="fp-gutter">{{ idx + 1 }}</span>
            <span class="fp-line-text" v-html="highlightLine(line)"></span>
          </div>
        </div>
      </div>

      <!-- Body: HTML (sandboxed preview + source mode) -->
      <div v-else-if="contentKind === 'html'" class="fp-body">
        <iframe
          v-if="htmlMode === 'preview'"
          class="fp-html-frame"
          sandbox=""
          :srcdoc="htmlSrcdoc"
          :title="file.path"
        ></iframe>
        <div v-else class="fp-code">
          <div class="fp-line-table">
            <div
              v-for="(line, idx) in lines"
              :key="idx"
              class="fp-line-row"
              :class="lineClass(idx + 1)"
              :data-line="idx + 1"
            >
              <span class="fp-gutter">{{ idx + 1 }}</span>
              <span class="fp-line-text" v-html="highlightLine(line)"></span>
            </div>
          </div>
        </div>
      </div>

      <!-- Body: PDF -->
      <div v-else-if="contentKind === 'pdf'" class="fp-body fp-pdf-wrap">
        <iframe v-if="pdfSrc" class="fp-pdf-frame" :src="pdfSrc" :title="file.path"></iframe>
        <div v-else class="fp-binary-card">
          <span class="fp-binary-label">{{ t('filePreview.pdfNoPreview') }}</span>
        </div>
      </div>

      <!-- Body: CSV -->
      <div v-else-if="contentKind === 'csv'" class="fp-body fp-table-wrap">
        <table class="fp-table">
          <tbody>
            <tr v-for="(row, ri) in csvRows" :key="ri" :class="lineClass(ri + 1)" :data-line="ri + 1">
              <th>{{ ri + 1 }}</th>
              <td v-for="(cell, ci) in row" :key="ci">{{ cell }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Body: Image (base64) -->
      <div v-else-if="contentKind === 'image'" class="fp-body fp-image-wrap">
        <template v-if="imageSrc">
          <img
            :src="imageSrc"
            :alt="file.path"
            class="fp-image"
            :class="{ actual: imageFit === 'actual' }"
          />
        </template>
        <div v-else class="fp-binary-card">
          <span class="fp-binary-icon">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <rect x="2" y="2" width="16" height="16" rx="2" stroke="currentColor" stroke-width="1.2" fill="none"/>
              <path d="M7 10h6M10 7v6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
          </span>
          <span class="fp-binary-label">{{ t('filePreview.imageNoPreview', { mime: file.mime, size: formatSize(file.size) }) }}</span>
        </div>
      </div>

      <!-- Body: Text/Code (with line numbers) -->
      <div v-else-if="contentKind === 'text'" class="fp-body fp-code">
        <div class="fp-line-table">
          <div
            v-for="(line, idx) in lines"
            :key="idx"
            class="fp-line-row"
            :class="lineClass(idx + 1)"
            :data-line="idx + 1"
          >
            <span class="fp-gutter">{{ idx + 1 }}</span>
            <span class="fp-line-text" v-html="highlightLine(line)"></span>
          </div>
        </div>
      </div>

      <!-- Body: Binary / unknown -->
      <div v-else class="fp-body fp-binary-wrap">
        <div class="fp-binary-card">
          <span class="fp-binary-icon">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M5 3h7l4 4v10H5V3z" stroke="currentColor" stroke-width="1.2" fill="none"/>
              <path d="M12 3v4h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>
            </svg>
          </span>
          <span class="fp-binary-label">
            {{ t('filePreview.binaryNoPreview', { mime: file.mime || t('filePreview.unknownType'), size: formatSize(file.size) }) }}
          </span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.file-preview {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  font-family: var(--mono);
  min-width: 0;
}

/* ---- Empty / loading ---- */
.fp-empty,
.fp-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--muted);
  font-size: 14px;
}

/* ---- Header ---- */
.fp-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  flex: none;
  min-width: 0;
  overflow: visible;
}

.fp-path {
  flex: 1 1 160px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
  font-size: 14px;
  color: var(--ink);
  font-weight: 500;
}

.fp-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.fp-lines,
.fp-size {
  font-size: 10.5px;
  color: var(--muted);
  white-space: nowrap;
}

.fp-action,
.fp-icon-btn,
.fp-close,
.fp-seg-btn {
  flex: none;
  padding: 2px 8px;
  font-size: 11px;
  font-family: var(--mono);
  background: var(--panel2);
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--dim);
  cursor: pointer;
  white-space: nowrap;
  text-decoration: none;
}
.fp-action:hover,
.fp-icon-btn:hover:not(:disabled),
.fp-close:hover,
.fp-seg-btn:hover {
  background: var(--soft);
  color: var(--blue2);
  border-color: var(--bd);
}
.fp-action.copied {
  color: var(--ok);
  border-color: color-mix(in srgb, var(--ok) 35%, var(--bg));
}
.fp-icon-btn:disabled {
  cursor: default;
  opacity: 0.45;
}
.fp-close {
  width: 24px;
  height: 24px;
  padding: 0;
  font-size: 16px;
  line-height: 1;
}
.fp-seg {
  display: inline-flex;
  flex: none;
  min-width: 0;
}
.fp-seg-btn:first-child { border-radius: 3px 0 0 3px; border-right: 0; }
.fp-seg-btn:last-child { border-radius: 0 3px 3px 0; }
.fp-seg-btn.on {
  background: var(--soft);
  color: var(--blue2);
  border-color: var(--bd);
}
.fp-search {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1 1 150px;
  min-width: 120px;
}
.fp-search-input {
  flex: 1;
  min-width: 0;
  height: 24px;
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 2px 7px;
  background: var(--bg);
  color: var(--ink);
  font: 11px var(--mono);
}
.fp-search-count {
  color: var(--muted);
  font-size: 10.5px;
  min-width: 18px;
  text-align: right;
}

/* ---- Body ---- */
.fp-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

/* ---- Markdown ---- */
.fp-markdown {
  padding: 16px 20px;
}

/* ---- Code / text with line numbers ---- */
.fp-code {
  background: var(--bg);
}

.fp-line-table {
  display: table;
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
  line-height: 1.6;
}

.fp-line-row {
  display: table-row;
}
.fp-line-row.hit .fp-line-text,
.fp-table tr.hit td {
  background: #fff7d6;
}
.fp-line-row.active .fp-line-text,
.fp-table tr.active td {
  background: #ffe8a3;
}
.fp-line-row.target .fp-gutter,
.fp-line-row.target .fp-line-text,
.fp-table tr.target th,
.fp-table tr.target td {
  background: var(--soft);
}

.fp-gutter {
  display: table-cell;
  width: 44px;
  padding: 0 10px 0 12px;
  text-align: right;
  color: var(--faint);
  user-select: none;
  font-size: 11px;
  white-space: nowrap;
  border-right: 1px solid var(--line2);
  vertical-align: top;
}

.fp-line-text {
  display: table-cell;
  padding: 0 12px;
  color: var(--ink);
  white-space: pre;
  vertical-align: top;
}
.fp-line-text :deep(.tok-key),
.fp-line-text :deep(.tok-keyword) {
  color: #8f3f9f;
  font-weight: 600;
}
.fp-line-text :deep(.tok-string) { color: #116329; }
.fp-line-text :deep(.tok-number),
.fp-line-text :deep(.tok-literal) { color: #0550ae; }
.fp-line-text :deep(.tok-comment) { color: var(--muted); font-style: italic; }
.fp-line-text :deep(.tok-tag) { color: #953800; font-weight: 600; }
.fp-line-text :deep(.tok-attr) { color: #0550ae; }

/* ---- HTML / PDF ---- */
.fp-html-frame,
.fp-pdf-frame {
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}
.fp-pdf-wrap {
  background: var(--panel2);
}

/* ---- CSV ---- */
.fp-table-wrap {
  background: var(--bg);
}
.fp-table {
  border-collapse: collapse;
  min-width: 100%;
  font: 12px/1.5 var(--mono);
}
.fp-table th {
  position: sticky;
  left: 0;
  z-index: 1;
  width: 44px;
  min-width: 44px;
  padding: 2px 8px;
  text-align: right;
  color: var(--faint);
  background: var(--panel);
  border-right: 1px solid var(--line2);
  user-select: none;
}
.fp-table td {
  padding: 2px 10px;
  border-right: 1px solid var(--line2);
  border-bottom: 1px solid var(--line2);
  white-space: pre;
}

/* ---- Image ---- */
.fp-image-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--panel2);
}

.fp-image {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border: 1px solid var(--line);
  border-radius: 4px;
}
.fp-image.actual {
  max-width: none;
  max-height: none;
}

/* ---- Binary card ---- */
.fp-binary-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
}

.fp-binary-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 20px 24px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--panel);
  color: var(--muted);
  font-size: 14px;
  margin: 32px auto;
  max-width: 480px;
}

.fp-binary-icon {
  color: var(--faint);
  flex: none;
}
.fp-error {
  flex-direction: column;
  padding: 24px;
  text-align: center;
}

/* ---- Spinner ---- */
@keyframes spin { to { transform: rotate(360deg); } }

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--line);
  border-top-color: var(--blue);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

/* ---- Mobile (≤640px): a comfier header (copy is a real tap target), and the
        code body keeps its line-number gutter while scrolling sideways for long
        lines. Markdown/images fit the full width. ---- */
@media (max-width: 640px) {
  .fp-header { padding: 8px 12px; gap: 8px; }
  .fp-action,
  .fp-icon-btn,
  .fp-close,
  .fp-seg-btn {
    min-height: 32px;
    padding: 5px 12px;
    font-size: 12px;
    border-radius: 6px;
  }
  /* Hide the line-count chip on the narrowest screens to keep the header tidy;
     the size chip + copy stay. */
  .fp-lines { display: none; }
  .fp-markdown { padding: 14px 16px; }
  .fp-body.fp-code { -webkit-overflow-scrolling: touch; }
}
</style>
