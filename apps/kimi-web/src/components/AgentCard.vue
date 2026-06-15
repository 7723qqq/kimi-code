<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AgentMember } from '../types';

const props = defineProps<{ member: AgentMember; compact?: boolean }>();

const expanded = ref(false);
const progressLines = computed(() =>
  (props.member.outputLines ?? [])
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-8),
);
const latestProgress = computed(() => progressLines.value.at(-1));
const hasDetail = computed(() =>
  Boolean(props.member.summary || props.member.suspendedReason || props.member.prompt || progressLines.value.length > 0),
);

function phaseLabel(phase: AgentMember['phase']): string {
  switch (phase) {
    case 'queued': return 'Queued';
    case 'working': return 'Working';
    case 'suspended': return 'Suspended';
    case 'completed': return 'Completed';
    case 'failed': return 'Failed';
  }
}

function toggle(): void {
  if (hasDetail.value) expanded.value = !expanded.value;
}
</script>

<template>
  <div class="agent-card" :class="[`phase-${member.phase}`, { compact }]">
    <button class="agent-head" type="button" :disabled="!hasDetail" @click="toggle">
      <span class="agent-dot" aria-hidden="true"></span>
      <span class="agent-main">
        <span class="agent-title-row">
          <span class="agent-name">{{ member.name }}</span>
          <span v-if="member.subagentType" class="agent-type">{{ member.subagentType }}</span>
        </span>
        <span v-if="latestProgress && (member.phase === 'queued' || member.phase === 'working' || member.phase === 'suspended')" class="agent-live">
          {{ latestProgress }}
        </span>
      </span>
      <span class="agent-phase">{{ phaseLabel(member.phase) }}</span>
      <svg
        v-if="hasDetail"
        class="agent-chevron"
        :class="{ open: expanded }"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M6 4l4 4-4 4" />
      </svg>
    </button>
    <div v-if="hasDetail && expanded" class="agent-detail">
      <div v-if="member.suspendedReason" class="agent-reason">{{ member.suspendedReason }}</div>
      <div v-if="member.prompt" class="agent-field">
        <span class="agent-field-label">Task</span>
        <div class="agent-field-body">{{ member.prompt }}</div>
      </div>
      <div v-if="progressLines.length > 0" class="agent-field">
        <span class="agent-field-label">Progress</span>
        <div class="agent-field-body agent-progress">
          <span v-for="(line, index) in progressLines" :key="index">{{ line }}</span>
        </div>
      </div>
      <div v-if="member.summary" class="agent-field">
        <span class="agent-field-label">Result</span>
        <div class="agent-field-body agent-summary">{{ member.summary }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agent-card {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  overflow: hidden;
}
.agent-card.compact {
  border-radius: 6px;
}
.agent-head {
  width: 100%;
  min-height: 38px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: none;
  background: transparent;
  color: var(--ink);
  font: inherit;
  text-align: left;
}
.agent-head:not(:disabled) {
  cursor: pointer;
}
.agent-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--blue);
  flex: none;
}
.phase-completed .agent-dot { background: var(--ok); }
.phase-failed .agent-dot { background: var(--err); }
.phase-suspended .agent-dot { background: var(--warn); }
.phase-queued .agent-dot { background: var(--muted); }
.agent-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.agent-title-row {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.agent-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--ui-font-size-sm);
  font-weight: 650;
}
.agent-type {
  flex: none;
  color: var(--muted);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 3px);
}
.agent-live {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--muted);
  font-family: var(--mono);
  font-size: calc(var(--ui-font-size) - 2.5px);
}
.agent-phase {
  flex: none;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 1px 7px;
  color: var(--dim);
  background: var(--bg);
  font-family: var(--mono);
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
}
.agent-chevron {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--muted);
  transition: transform 0.12s;
}
.agent-chevron.open {
  transform: rotate(90deg);
}
.agent-detail {
  border-top: 1px solid var(--line);
  padding: 8px 10px 10px 26px;
  color: var(--dim);
  font-size: var(--ui-font-size-xs);
  line-height: 1.5;
}
.agent-reason {
  color: var(--warn);
  margin-bottom: 4px;
}
.agent-field + .agent-field {
  margin-top: 8px;
}
.agent-field-label {
  display: block;
  color: var(--muted);
  font-family: var(--mono);
  font-size: max(9px, calc(var(--ui-font-size) - 3.5px));
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: 2px;
}
.agent-field-body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.agent-summary {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.agent-progress {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-family: var(--mono);
  color: var(--text);
}
</style>
