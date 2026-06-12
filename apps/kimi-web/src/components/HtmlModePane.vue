<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Composer from './Composer.vue';
import type { FileItem } from './MentionMenu.vue';
import type { AppModel, ThinkingLevel } from '../api/types';
import type { ChatTurn, ConversationStatus, PermissionMode, QueuedPromptView, TurnBlock } from '../types';
import {
  buildHtmlModePrompt,
  collectHtmlModeSuggestions,
  createHtmlModeDocument,
  extractHtmlFromAssistantText,
  htmlModeTitle,
  isHtmlModePrompt,
  stripHtmlModePrompt,
} from '../lib/htmlMode';

type HtmlViewMode = 'preview' | 'source';
type HtmlViewport = 'desktop' | 'tablet' | 'mobile';

interface HtmlEntry {
  id: string;
  prompt: string;
  raw: string;
  title: string;
}

const props = withDefaults(defineProps<{
  turns: ChatTurn[];
  running?: boolean;
  sending?: boolean;
  sessionLoading?: boolean;
  queued?: QueuedPromptView[];
  searchFiles?: (q: string) => Promise<FileItem[]>;
  uploadImage?: (file: Blob, name?: string) => Promise<{ fileId: string; name: string; mediaType: string } | null>;
  status?: ConversationStatus;
  thinking?: ThinkingLevel;
  planMode?: boolean;
  models?: AppModel[];
}>(), {
  running: false,
  sending: false,
  sessionLoading: false,
  queued: () => [],
  searchFiles: undefined,
  uploadImage: undefined,
  status: undefined,
  thinking: undefined,
  planMode: false,
  models: () => [],
});

const emit = defineEmits<{
  htmlSubmit: [payload: { text: string; attachments: { fileId: string }[] }];
  htmlSteer: [payload: { text: string; attachments: { fileId: string }[] }];
  command: [cmd: string];
  interrupt: [];
  unqueue: [index: number];
  editQueued: [index: number];
  setPermission: [mode: PermissionMode];
  setThinking: [level: ThinkingLevel];
  togglePlan: [];
  compact: [];
  pickModel: [];
  selectModel: [modelId: string];
}>();

const { t } = useI18n();

const selectedEntryId = ref<string | null>(null);
const followLatest = ref(true);
const viewMode = ref<HtmlViewMode>('preview');
const viewport = ref<HtmlViewport>('desktop');
const frameRef = ref<HTMLIFrameElement | null>(null);
const frameRevision = ref(0);
const copied = ref<string | null>(null);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
let frameRevisionTimer: ReturnType<typeof setTimeout> | null = null;

const htmlQueued = computed<QueuedPromptView[]>(() =>
  props.queued.map((item) => ({
    ...item,
    text: stripHtmlModePrompt(item.text),
  })),
);

const htmlEntries = computed<HtmlEntry[]>(() => {
  const entries: HtmlEntry[] = [];
  let current: { id: string; prompt: string; parts: string[] } | null = null;

  function flush(): void {
    if (!current) return;
    const raw = current.parts.join('\n\n').trim();
    entries.push({
      id: current.id,
      prompt: current.prompt,
      raw,
      title: htmlModeTitle(current.prompt, raw),
    });
    current = null;
  }

  for (const turn of props.turns) {
    if (turn.role === 'user') {
      flush();
      if (turn.htmlMode) {
        current = { id: turn.id, prompt: turn.htmlMode.prompt, parts: [] };
      }
      continue;
    }

    if (turn.role === 'assistant' && current) {
      const text = assistantText(turn);
      if (text) current.parts.push(text);
    }
  }

  flush();
  return entries;
});

const latestEntryId = computed(() => htmlEntries.value[htmlEntries.value.length - 1]?.id ?? null);
const selectedEntry = computed(() => {
  const current = selectedEntryId.value;
  if (current) {
    const found = htmlEntries.value.find((entry) => entry.id === current);
    if (found) return found;
  }
  return htmlEntries.value[htmlEntries.value.length - 1] ?? null;
});

watch(latestEntryId, (id) => {
  if (followLatest.value) selectedEntryId.value = id;
}, { immediate: true });

watch(htmlEntries, (entries) => {
  if (entries.length === 0) {
    selectedEntryId.value = null;
    followLatest.value = true;
    return;
  }
  if (!selectedEntryId.value || !entries.some((entry) => entry.id === selectedEntryId.value)) {
    selectedEntryId.value = entries[entries.length - 1]!.id;
    followLatest.value = true;
  }
});

const selectedHtml = computed(() => selectedEntry.value?.raw ?? '');
const selectedDocument = computed(() => createHtmlModeDocument(selectedHtml.value));
const selectedSource = computed(() => extractHtmlFromAssistantText(selectedHtml.value));
const suggestions = computed(() => collectHtmlModeSuggestions(selectedHtml.value));
const hasPreview = computed(() => selectedDocument.value.length > 0);
const busy = computed(() => props.sending || props.sessionLoading || (props.running && selectedEntry.value?.id === latestEntryId.value));
const frameKey = computed(() => `${selectedEntry.value?.id ?? 'empty'}:${frameRevision.value}`);

watch(selectedDocument, () => {
  if (frameRevisionTimer !== null) clearTimeout(frameRevisionTimer);
  frameRevisionTimer = setTimeout(() => {
    frameRevisionTimer = null;
    frameRevision.value += 1;
  }, 16);
}, { flush: 'post' });

const starterPrompts = computed(() => [
  { label: t('htmlMode.starterReport'), prompt: t('htmlMode.starterReportPrompt') },
  { label: t('htmlMode.starterTool'), prompt: t('htmlMode.starterToolPrompt') },
  { label: t('htmlMode.starterCompare'), prompt: t('htmlMode.starterComparePrompt') },
]);

function assistantText(turn: ChatTurn): string {
  const parts: string[] = [];
  const blocks = turn.blocks ?? fallbackBlocks(turn);
  for (const block of blocks) {
    if (block.kind === 'text' && block.text) parts.push(block.text);
  }
  return parts.join('\n\n').trim();
}

function fallbackBlocks(turn: ChatTurn): TurnBlock[] {
  return turn.text ? [{ kind: 'text', text: turn.text }] : [];
}

function wrapPrompt(text: string): string {
  return isHtmlModePrompt(text) ? text : buildHtmlModePrompt(text);
}

function submitHtmlPrompt(text: string, attachments: { fileId: string }[] = []): void {
  const prompt = text.trim() || t('htmlMode.attachmentPrompt');
  followLatest.value = true;
  emit('htmlSubmit', { text: wrapPrompt(prompt), attachments });
}

function handleComposerSubmit(payload: { text: string; attachments: { fileId: string }[] }): void {
  submitHtmlPrompt(payload.text, payload.attachments);
}

function handleComposerSteer(payload: { text: string; attachments: { fileId: string }[] }): void {
  const prompt = payload.text.trim() || t('htmlMode.attachmentPrompt');
  followLatest.value = true;
  emit('htmlSteer', { text: wrapPrompt(prompt), attachments: payload.attachments });
}

function selectEntry(id: string): void {
  selectedEntryId.value = id;
  followLatest.value = id === latestEntryId.value;
}

function regenerate(): void {
  const entry = selectedEntry.value;
  if (!entry) return;
  submitHtmlPrompt(t('htmlMode.regeneratePrompt', { prompt: entry.prompt }));
}

async function copyText(kind: string, value: string): Promise<void> {
  if (!value) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      fallbackCopy(value);
    }
    copied.value = kind;
    if (copiedTimer !== null) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedTimer = null;
      copied.value = null;
    }, 1400);
  } catch {
    // ignore clipboard errors
  }
}

function fallbackCopy(value: string): void {
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

function downloadHtml(): void {
  const doc = selectedDocument.value;
  if (!doc) return;
  const blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeFileName(selectedEntry.value?.title ?? 'kimi-html')}.html`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function safeFileName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'kimi-html';
}

function handleFrameMessage(event: MessageEvent): void {
  if (!frameRef.value || event.source !== frameRef.value.contentWindow) return;
  const data = event.data as { __kimiHtmlMode?: boolean; type?: string; text?: string } | null;
  if (!data?.__kimiHtmlMode || data.type !== 'send' || typeof data.text !== 'string') return;
  submitHtmlPrompt(data.text);
}

onMounted(() => {
  window.addEventListener('message', handleFrameMessage);
});

onUnmounted(() => {
  window.removeEventListener('message', handleFrameMessage);
  if (copiedTimer !== null) clearTimeout(copiedTimer);
  if (frameRevisionTimer !== null) clearTimeout(frameRevisionTimer);
});
</script>

<template>
  <section class="html-mode">
    <aside v-if="htmlEntries.length > 0" class="html-history" :aria-label="t('htmlMode.history')">
      <div class="hist-head">
        <span>{{ t('htmlMode.history') }}</span>
        <b>{{ htmlEntries.length }}</b>
      </div>
      <div class="hist-list">
        <button
          v-for="(entry, index) in htmlEntries"
          :key="entry.id"
          type="button"
          class="hist-item"
          :class="{ active: entry.id === selectedEntry?.id }"
          @click="selectEntry(entry.id)"
        >
          <span class="hist-index">{{ index + 1 }}</span>
          <span class="hist-main">
            <span class="hist-title">{{ entry.title }}</span>
            <span class="hist-prompt">{{ entry.prompt }}</span>
          </span>
        </button>
      </div>
    </aside>

    <main class="html-main">
      <header class="html-toolbar">
        <div class="html-toolbar-title">
          <b>{{ t('htmlMode.title') }}</b>
          <span v-if="selectedEntry">{{ selectedEntry.title }}</span>
        </div>
        <div class="html-toolbar-actions">
          <div class="seg" role="group" :aria-label="t('htmlMode.viewMode')">
            <button type="button" :class="{ on: viewMode === 'preview' }" @click="viewMode = 'preview'">{{ t('htmlMode.preview') }}</button>
            <button type="button" :class="{ on: viewMode === 'source' }" @click="viewMode = 'source'">{{ t('htmlMode.source') }}</button>
          </div>
          <div class="seg viewport-seg" role="group" :aria-label="t('htmlMode.viewport')">
            <button type="button" :class="{ on: viewport === 'desktop' }" @click="viewport = 'desktop'">{{ t('htmlMode.desktop') }}</button>
            <button type="button" :class="{ on: viewport === 'tablet' }" @click="viewport = 'tablet'">{{ t('htmlMode.tablet') }}</button>
            <button type="button" :class="{ on: viewport === 'mobile' }" @click="viewport = 'mobile'">{{ t('htmlMode.phone') }}</button>
          </div>
          <button type="button" class="tool-btn" :disabled="!selectedEntry" @click="regenerate">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2v3.8H9.2"/></svg>
            <span>{{ t('htmlMode.regenerate') }}</span>
          </button>
          <button type="button" class="tool-btn" :disabled="!selectedSource" @click="copyText('html', selectedSource)">
            <svg v-if="copied !== 'html'" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="9" height="9" rx="1.5"/><path d="M6 1h7a1 1 0 0 1 1 1v7"/></svg>
            <svg v-else viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4"/></svg>
            <span>{{ copied === 'html' ? t('htmlMode.copied') : t('htmlMode.copyHtml') }}</span>
          </button>
          <button type="button" class="tool-btn icon-only" :disabled="!selectedDocument" :title="t('htmlMode.download')" @click="downloadHtml">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v8"/><path d="M4.5 6.5 8 10l3.5-3.5"/><path d="M3 13.5h10"/></svg>
          </button>
        </div>
      </header>

      <div class="html-stage" :class="{ busy }">
        <div v-if="!selectedEntry" class="html-empty">
          <div class="empty-title">{{ t('htmlMode.emptyTitle') }}</div>
          <div class="starter-grid">
            <button
              v-for="item in starterPrompts"
              :key="item.label"
              type="button"
              class="starter"
              @click="submitHtmlPrompt(item.prompt)"
            >
              <span>{{ item.label }}</span>
            </button>
          </div>
        </div>

        <template v-else>
          <div v-if="viewMode === 'preview'" class="preview-shell" :class="`vp-${viewport}`">
            <iframe
              v-if="hasPreview"
              :key="frameKey"
              ref="frameRef"
              class="html-frame"
              title="HTML preview"
              sandbox="allow-scripts allow-forms"
              :srcdoc="selectedDocument"
            />
            <div v-else class="html-wait">
              <span class="dot-pulse" aria-hidden="true" />
              <span>{{ t('htmlMode.waiting') }}</span>
            </div>
          </div>
          <pre v-else class="source-view">{{ selectedSource }}</pre>
        </template>

        <div v-if="busy" class="html-progress" aria-hidden="true" />
      </div>

      <div v-if="suggestions.length > 0" class="suggestions">
        <button
          v-for="item in suggestions"
          :key="item.prompt"
          type="button"
          class="suggestion"
          :title="item.prompt"
          @click="submitHtmlPrompt(item.prompt)"
        >
          {{ item.label }}
        </button>
      </div>

      <Composer
        class="html-composer"
        :running="running"
        :queued="htmlQueued"
        :search-files="searchFiles"
        :upload-image="uploadImage"
        :status="status"
        :thinking="thinking"
        :plan-mode="planMode"
        :models="models"
        :placeholder="t('htmlMode.composerPlaceholder')"
        @submit="handleComposerSubmit"
        @steer="handleComposerSteer"
        @command="emit('command', $event)"
        @interrupt="emit('interrupt')"
        @unqueue="emit('unqueue', $event)"
        @edit-queued="emit('editQueued', $event)"
        @set-permission="emit('setPermission', $event)"
        @set-thinking="emit('setThinking', $event)"
        @toggle-plan="emit('togglePlan')"
        @compact="emit('compact')"
        @pick-model="emit('pickModel')"
        @select-model="emit('selectModel', $event)"
      />
    </main>
  </section>
</template>

<style scoped>
.html-mode {
  flex: 1;
  min-height: 0;
  display: flex;
  background: var(--bg);
  color: var(--text);
}

.html-history {
  width: 214px;
  flex: none;
  border-right: 1px solid var(--line);
  background: var(--panel);
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.hist-head {
  flex: none;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid var(--line);
  color: var(--dim);
  font-size: 12px;
}

.hist-head b {
  color: var(--blue2);
  font-size: 11px;
}

.hist-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hist-item {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}

.hist-item:hover {
  background: var(--bg);
  border-color: var(--line);
}

.hist-item.active {
  background: var(--bg);
  border-color: var(--bd);
  box-shadow: 0 0 0 2px var(--soft);
}

.hist-index {
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: 6px;
  display: grid;
  place-items: center;
  background: var(--panel2);
  color: var(--dim);
  font-size: 11px;
  font-weight: 700;
}

.hist-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.hist-title,
.hist-prompt {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hist-title {
  color: var(--ink);
  font-size: 12.5px;
  font-weight: 600;
}

.hist-prompt {
  color: var(--muted);
  font-size: 11px;
}

.html-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.html-toolbar {
  flex: none;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 10px 6px 14px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}

.html-toolbar-title {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.html-toolbar-title b {
  color: var(--ink);
  font-size: 13px;
}

.html-toolbar-title span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-size: 12px;
}

.html-toolbar-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

.seg {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg);
}

.seg button,
.tool-btn {
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 0;
  background: transparent;
  color: var(--dim);
  padding: 0 9px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.seg button + button {
  border-left: 1px solid var(--line);
}

.seg button:hover,
.tool-btn:hover:not(:disabled) {
  color: var(--ink);
  background: var(--panel2);
}

.seg button.on {
  color: var(--blue2);
  background: var(--soft);
  font-weight: 600;
}

.tool-btn {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg);
}

.tool-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.icon-only {
  width: 30px;
  padding: 0;
}

.html-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  justify-content: center;
  overflow: hidden;
  background: var(--panel2);
}

.preview-shell {
  flex: none;
  min-width: 0;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  background: #fff;
  transition: width 0.18s ease, height 0.18s ease, border-radius 0.18s ease, box-shadow 0.18s ease;
}

.preview-shell.vp-tablet,
.preview-shell.vp-mobile {
  align-self: center;
  height: calc(100% - 28px);
  border: 1px solid var(--line);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
}

.preview-shell.vp-tablet {
  width: calc(100% - 28px);
  max-width: 820px;
}

.preview-shell.vp-mobile {
  width: calc(100% - 28px);
  max-width: 390px;
}

.html-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background: #fff;
}

.source-view {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: auto;
  padding: 18px;
  background: var(--bg);
  color: var(--ink);
  border: 0;
  font: 12.5px/1.65 var(--mono);
  white-space: pre-wrap;
}

.html-empty,
.html-wait {
  width: 100%;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 24px;
  color: var(--muted);
}

.empty-title {
  color: var(--ink);
  font-size: 18px;
  font-weight: 600;
}

.starter-grid {
  width: min(680px, 100%);
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.starter {
  min-height: 58px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  text-align: left;
  cursor: pointer;
}

.starter:hover {
  border-color: var(--bd);
  color: var(--ink);
  background: var(--panel);
}

.html-progress {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 3px;
  overflow: hidden;
  pointer-events: none;
}

.html-progress::before {
  content: "";
  position: absolute;
  top: 0;
  left: -35%;
  width: 35%;
  height: 100%;
  background: linear-gradient(90deg, transparent, var(--blue), transparent);
  animation: html-slide 1.1s linear infinite;
}

@keyframes html-slide {
  to { left: 100%; }
}

.suggestions {
  flex: none;
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding: 8px 16px 0;
  background: var(--bg);
}

.suggestion {
  flex: none;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--bg);
  color: var(--blue2);
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
}

.suggestion:hover {
  border-color: var(--bd);
  background: var(--soft);
}

.html-composer {
  flex: none;
}

.dot-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--blue);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--blue) 35%, transparent);
  animation: pulse 1.2s ease-out infinite;
}

@keyframes pulse {
  to { box-shadow: 0 0 0 10px transparent; }
}

@media (max-width: 900px) {
  .html-history {
    display: none;
  }

  .html-toolbar {
    align-items: stretch;
    flex-direction: column;
    gap: 7px;
  }

  .html-toolbar-actions {
    overflow-x: auto;
    padding-bottom: 1px;
  }
}

@media (max-width: 640px) {
  .viewport-seg {
    display: none;
  }

  .tool-btn span {
    display: none;
  }

  .starter-grid {
    grid-template-columns: 1fr;
  }

  .preview-shell.vp-tablet,
  .preview-shell.vp-mobile {
    width: 100%;
    height: 100%;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
}
</style>
