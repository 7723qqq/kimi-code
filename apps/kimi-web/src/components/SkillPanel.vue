<!-- apps/kimi-web/src/components/SkillPanel.vue -->
<!-- Skill browser for the current session: lists the session's skill catalog
     and lets the model-facing skill be activated with optional args.
     Self-contained: pulls skills through getKimiWebApi, no shared client
     state. -->
<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { getKimiWebApi } from '../api';
import type { AppSkill } from '../api/types';
import { isDaemonApiError } from '../api/errors';
import Icon from './ui/Icon.vue';

const { t } = useI18n();

const props = defineProps<{
  /** Session whose skills are listed and activated. */
  sessionId?: string;
}>();

const skills = ref<AppSkill[]>([]);
const open = ref(false);
const busy = ref(false);
const error = ref<string | undefined>(undefined);

async function load(): Promise<void> {
  if (props.sessionId === undefined) return;
  try {
    skills.value = await getKimiWebApi().listSkills(props.sessionId);
  } catch (err) {
    error.value = isDaemonApiError(err) ? err.message : String(err);
  }
}

onMounted(() => {
  void load();
});

function toggle(): void {
  open.value = !open.value;
  if (open.value) void load();
}

async function activate(name: string): Promise<void> {
  if (props.sessionId === undefined) return;
  busy.value = true;
  error.value = undefined;
  try {
    await getKimiWebApi().activateSkill(props.sessionId, name);
  } catch (err) {
    error.value = isDaemonApiError(err) ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="skill-panel">
    <button type="button" class="sp-trigger" :disabled="sessionId === undefined" @click="toggle">
      <Icon name="settings" size="sm" />
      <span class="sp-label">{{ t('skillPanel.title') }}</span>
      <span v-if="skills.length > 0" class="sp-count">{{ skills.length }}</span>
      <Icon :name="open ? 'chevron-up' : 'chevron-down'" size="sm" />
    </button>
    <div v-if="open" class="sp-body">
      <div v-if="skills.length === 0" class="sp-empty">{{ t('skillPanel.empty') }}</div>
      <div v-for="skill in skills" :key="skill.name" class="sp-item">
        <div class="sp-item-head">
          <span class="sp-item-name">{{ skill.name }}</span>
          <span class="sp-item-source">{{ skill.source }}</span>
        </div>
        <div class="sp-item-desc">{{ skill.description }}</div>
        <button
          type="button"
          class="sp-activate"
          :disabled="busy"
          @click="activate(skill.name)"
        >
          {{ t('skillPanel.activate') }}
        </button>
      </div>
      <div v-if="error" class="sp-error">{{ error }}</div>
    </div>
  </div>
</template>

<style scoped>
.skill-panel {
  flex: none;
  position: relative;
}
.sp-trigger {
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
.sp-trigger:disabled { opacity: 0.5; cursor: default; }
.sp-trigger:hover:not(:disabled) { border-color: var(--color-line-strong); color: var(--color-text); }
.sp-count {
  padding: 0 5px;
  border-radius: 999px;
  background: var(--color-accent-soft);
  color: var(--color-accent-hover);
  font-size: calc(var(--text-xs) - 1px);
}
.sp-body {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 0;
  z-index: var(--z-dropdown);
  width: 320px;
  max-height: 360px;
  overflow-y: auto;
  background: var(--color-bg);
  border: 1px solid var(--color-line);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-popover);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sp-empty { padding: 8px; font-size: var(--text-xs); color: var(--color-text-faint); }
.sp-item {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-sm);
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sp-item-head { display: flex; align-items: center; gap: 6px; }
.sp-item-name { font-size: var(--text-sm); font-weight: var(--weight-medium); color: var(--color-text); }
.sp-item-source {
  font-size: calc(var(--text-xs) - 1px);
  color: var(--color-text-faint);
  border: 1px solid var(--color-line);
  border-radius: 999px;
  padding: 0 5px;
}
.sp-item-desc {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.sp-activate {
  align-self: flex-start;
  border: 1px solid var(--color-line-strong);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-size: var(--text-xs);
  padding: 2px 8px;
  cursor: pointer;
}
.sp-activate:hover:not(:disabled) { color: var(--color-accent-hover); border-color: var(--color-accent); }
.sp-error { font-size: var(--text-xs); color: var(--color-danger); }
</style>
