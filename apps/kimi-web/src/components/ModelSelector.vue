<!-- apps/kimi-web/src/components/ModelSelector.vue -->
<!-- Model switcher for the current session: lists the configured model
     catalog and switches the session's model via updateSession. Self-contained:
     pulls the catalog through getKimiWebApi, no shared client state. -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi } from '../api';
import type { AppModel } from '../api/types';
import { isDaemonApiError } from '../api/errors';
import Icon from './ui/Icon.vue';

const { t } = useI18n();

const props = defineProps<{
  /** Session whose model is switched. When absent the control is disabled. */
  sessionId?: string;
  /** Currently active model id, when known to the parent. */
  currentModel?: string;
}>();

const emit = defineEmits<{
  changed: [modelId: string];
}>();

const models = ref<AppModel[]>([]);
const open = ref(false);
const busy = ref(false);
const error = ref<string | undefined>(undefined);
const menuRef = ref<HTMLElement | null>(null);

const currentModelId = (): string | undefined =>
  props.currentModel !== undefined && props.currentModel.length > 0
    ? props.currentModel
    : undefined;

const activeModel = (): AppModel | undefined =>
  models.value.find((model) => model.id === currentModelId()) ?? models.value[0];

async function load(): Promise<void> {
  try {
    models.value = await getKimiWebApi().listModels();
  } catch (err) {
    error.value = isDaemonApiError(err) ? err.message : String(err);
  }
}

onMounted(() => {
  void load();
});

function onDocClick(e: MouseEvent): void {
  const target = e.target as Node;
  if (menuRef.value?.contains(target)) return;
  open.value = false;
}

function toggle(): void {
  if (props.sessionId === undefined) return;
  open.value = !open.value;
  if (open.value) {
    document.addEventListener('mousedown', onDocClick);
  } else {
    document.removeEventListener('mousedown', onDocClick);
  }
}

async function select(modelId: string): Promise<void> {
  open.value = false;
  document.removeEventListener('mousedown', onDocClick);
  if (props.sessionId === undefined || modelId === currentModelId()) return;
  busy.value = true;
  error.value = undefined;
  try {
    await getKimiWebApi().updateSession(props.sessionId, { model: modelId });
    emit('changed', modelId);
  } catch (err) {
    error.value = isDaemonApiError(err) ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="model-selector" ref="menuRef">
    <button
      type="button"
      class="ms-trigger"
      :disabled="sessionId === undefined || busy"
      :title="t('modelSelector.title')"
      @click.stop="toggle"
    >
      <Icon name="sliders" size="sm" />
      <span class="ms-label">{{ activeModel()?.displayName ?? activeModel()?.model ?? t('modelSelector.none') }}</span>
      <Icon name="chevron-down" size="sm" />
    </button>
    <div v-if="open" class="ms-menu">
      <div class="ms-menu-title">{{ t('modelSelector.available') }}</div>
      <button
        v-for="model in models"
        :key="model.id"
        type="button"
        class="ms-item"
        :class="{ active: model.id === currentModelId() }"
        @click="select(model.id)"
      >
        <span class="ms-item-name">{{ model.displayName ?? model.model }}</span>
        <span class="ms-item-id">{{ model.id }}</span>
      </button>
      <div v-if="models.length === 0" class="ms-empty">{{ t('modelSelector.empty') }}</div>
    </div>
    <div v-if="error" class="ms-error">{{ error }}</div>
  </div>
</template>

<style scoped>
.model-selector {
  position: relative;
  flex: none;
}
.ms-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  cursor: pointer;
}
.ms-trigger:disabled { opacity: 0.5; cursor: default; }
.ms-trigger:hover:not(:disabled) { border-color: var(--color-line-strong); color: var(--color-text); }
.ms-label {
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ms-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: var(--z-dropdown);
  min-width: 220px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--color-bg);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-popover);
  padding: 4px;
}
.ms-menu-title {
  padding: 4px 8px;
  font-size: var(--text-xs);
  color: var(--color-text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.ms-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--color-text);
  cursor: pointer;
  text-align: left;
}
.ms-item:hover { background: var(--color-surface-sunken); }
.ms-item.active { background: var(--color-accent-soft); }
.ms-item-name { font-size: var(--text-sm); font-weight: var(--weight-medium); }
.ms-item-id { font-size: var(--text-xs); color: var(--color-text-faint); font-family: var(--font-mono); }
.ms-empty { padding: 8px; font-size: var(--text-xs); color: var(--color-text-faint); }
.ms-error { margin-top: 3px; font-size: var(--text-xs); color: var(--color-danger); }
</style>
