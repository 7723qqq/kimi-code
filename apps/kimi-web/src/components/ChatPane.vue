<!-- apps/kimi-web/src/components/ChatPane.vue -->
<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatTurn, ApprovalBlock } from '../types';

const { t } = useI18n();
import type { ApprovalDecision } from '../api/types';
import ToolCall from './ToolCall.vue';
import ApprovalCard from './ApprovalCard.vue';
import Markdown from './Markdown.vue';
import ThinkingBlock from './ThinkingBlock.vue';

withDefaults(
  defineProps<{
    turns: ChatTurn[];
    approvals?: { approvalId: string; block: ApprovalBlock; agentName?: string }[];
  }>(),
  { approvals: () => [] },
);

const emit = defineEmits<{
  approvalDecide: [approvalId: string, response: { decision: ApprovalDecision; scope?: 'session'; feedback?: string }];
}>();

// Per-turn copy button state (keyed by turn id)
const copiedTurn = ref<string | null>(null);

function copyTurn(turn: ChatTurn) {
  navigator.clipboard.writeText(turn.text).then(() => {
    copiedTurn.value = turn.id;
    setTimeout(() => { copiedTurn.value = null; }, 1400);
  }).catch(() => {/* ignore */});
}
</script>

<template>
  <div class="term">
    <!-- Empty state: a fresh/empty session shows a hint instead of a blank pane -->
    <div v-if="turns.length === 0 && (!approvals || approvals.length === 0)" class="chat-empty">
      <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
      </svg>
      <div class="chat-empty-text">{{ t('composer.emptyConversation') }}</div>
    </div>

    <template v-for="turn in turns" :key="turn.id">
      <div class="ln" :class="turn.role === 'user' ? 'userline' : 'ai'">
        <!-- Line-number gutter -->
        <span class="no">{{ turn.no }}</span>

        <div class="tx">
          <!-- Role prefix -->
          <div class="role-row">
            <template v-if="turn.role === 'user'">
              <span class="pr">user@kimi</span>
              <span class="who"> $ </span>
            </template>
            <template v-else>
              <span class="pr">kimi</span>
              <span class="who"> &gt; </span>
            </template>

            <!-- Per-message copy button (shown on hover) -->
            <button class="cpbtn" @click="copyTurn(turn)" :title="t('filePreview.copy')" tabindex="-1">
              {{ copiedTurn === turn.id ? '✓' : '⧉' }}
            </button>
          </div>

          <!-- Thinking block (before the message text) -->
          <ThinkingBlock v-if="turn.thinking" :text="turn.thinking" />

          <!-- Message text rendered as Markdown -->
          <Markdown :text="turn.text" />
        </div>
      </div>

      <!-- Tool cards -->
      <ToolCall v-for="tool in turn.tools" :key="tool.id" :tool="tool" />
    </template>

    <!-- Pending approvals as standalone interrupt cards (do not depend on a
         matching tool_use being loaded in the transcript) -->
    <ApprovalCard
      v-for="a in approvals"
      :key="a.approvalId"
      :block="a.block"
      :agent-name="a.agentName"
      @decide="(response) => emit('approvalDecide', a.approvalId, response)"
    />
  </div>
</template>

<style scoped>
.term { padding: 14px 18px 10px; }
.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 64px 16px;
  color: var(--faint);
  text-align: center;
}
.chat-empty-text { font-size: 13px; }
.ln { display: flex; gap: 11px; margin-bottom: 6px; }
.no {
  color: var(--faint);
  width: 22px;
  text-align: right;
  flex: none;
  user-select: none;
  font-size: 11px;
  padding-top: 2px;
}
.tx { flex: 1; min-width: 0; }

/* Role prefix row */
.role-row {
  display: flex;
  align-items: center;
  gap: 0;
  margin-bottom: 2px;
  position: relative;
}
.userline .pr { color: var(--blue2); font-weight: 700; font-size: 12.5px; }
.ai .pr { color: var(--ok); font-weight: 700; font-size: 12.5px; }
.who { color: var(--muted); font-size: 12.5px; }

/* Copy button: hidden by default, shown on hover of .ln */
.cpbtn {
  margin-left: auto;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--faint);
  font-size: 13px;
  font-family: var(--mono);
  padding: 0 4px;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.1s;
}
.ln:hover .cpbtn {
  opacity: 1;
}
.cpbtn:hover {
  color: var(--blue);
}
</style>
