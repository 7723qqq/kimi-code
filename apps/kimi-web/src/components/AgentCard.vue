<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AgentMember } from '../types';

const props = defineProps<{ member: AgentMember; compact?: boolean }>();

const expanded = ref(false);
const hasDetail = computed(() => Boolean(props.member.summary || props.member.suspendedReason));

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
        <span class="agent-name">{{ member.name }}</span>
        <span v-if="member.subagentType" class="agent-type">{{ member.subagentType }}</span>
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
      <div v-if="member.summary" class="agent-summary">{{ member.summary }}</div>
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
  align-items: baseline;
  gap: 7px;
}
.agent-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 650;
}
.agent-type {
  flex: none;
  color: var(--muted);
  font-family: var(--mono);
  font-size: 11px;
}
.agent-phase {
  flex: none;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 1px 7px;
  color: var(--dim);
  background: var(--bg);
  font-family: var(--mono);
  font-size: 10.5px;
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
  font-size: 12px;
  line-height: 1.5;
}
.agent-reason {
  color: var(--warn);
  margin-bottom: 4px;
}
.agent-summary {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
