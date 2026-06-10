<!-- apps/kimi-web/src/components/ChatPane.vue -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ChatTurn, ApprovalBlock, TurnBlock } from '../types';

const { t } = useI18n();
import type { ApprovalDecision } from '../api/types';
import ToolCall from './ToolCall.vue';
import ApprovalCard from './ApprovalCard.vue';
import Markdown from './Markdown.vue';
import ThinkingBlock from './ThinkingBlock.vue';


const MOON_FRAMES = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
const MOON_INTERVAL_MS = 120;

const moonFrame = ref(0);
let moonInterval: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  moonInterval = setInterval(() => {
    moonFrame.value = (moonFrame.value + 1) % MOON_FRAMES.length;
  }, MOON_INTERVAL_MS);
});

onUnmounted(() => {
  if (moonInterval) {
    clearInterval(moonInterval);
    moonInterval = null;
  }
});

const props = withDefaults(
  defineProps<{
    turns: ChatTurn[];
    approvals?: { approvalId: string; block: ApprovalBlock; agentName?: string }[];
    /**
     * Bubble chat layout: render each turn as a chat bubble (user = right-aligned
     * soft-blue bubble, assistant = left-aligned plain text with no role label)
     * instead of the desktop `user@kimi $` / `kimi >` line-turns. Driven by the
     * Modern desktop theme OR a narrow (phone) viewport.
     */
    bubble?: boolean;
    /**
     * Backwards-compatible alias for `bubble` (the phone shell still passes
     * `mobile`). Either prop enables the bubble layout.
     */
    mobile?: boolean;
    /**
     * True while the active session is busy (activity !== idle). Used to mark the
     * last assistant turn as actively streaming so its Markdown animates the
     * smooth typewriter/fade reveal; all other turns render statically.
     */
    running?: boolean;
    /**
     * True immediately after the user hits send and before the assistant reply
     * starts streaming. Renders a moon-spinner placeholder at the end of the
     * transcript so the user knows the request is in flight.
     */
    sending?: boolean;
    /**
     * True while the session turns are being fetched (e.g. after switching to
     * a historical session). Shows a lightweight loading placeholder instead of
     * the empty-conversation state.
     */
    sessionLoading?: boolean;
    /**
     * Live compaction state of the session: a "compacting…" banner while the
     * daemon rewrites history, then a transient "compacted (X → Y tokens)" note
     * (auto-dismissed by the composable).
     */
    compaction?: { status: 'running' | 'completed'; tokensBefore?: number; tokensAfter?: number } | null;
    /**
     * @deprecated No longer used — Composer is rendered by ConversationPane.
     */
  }>(),
  { approvals: () => [], bubble: false, mobile: false, running: false, sending: false, compaction: null },
);

// Bubble layout is active on phones AND on the Modern desktop theme. ThinkingBlock
// / ToolCall use their soft "bubble" rendering in the same condition.
const childBubble = computed(() => props.bubble || props.mobile);

// The id of the turn that is actively streaming: the last assistant turn while
// the session is running. Its Markdown renders with `streaming` (final=false);
// every other turn renders statically.
const streamingTurnId = computed<string | null>(() => {
  if (!props.running || props.turns.length === 0) return null;
  const last = props.turns[props.turns.length - 1]!;
  return last.role === 'assistant' ? last.id : null;
});

const emit = defineEmits<{
  approvalDecide: [approvalId: string, response: { decision: ApprovalDecision; scope?: 'session'; feedback?: string }];
}>();

const compactionLabel = computed<string>(() => {
  const c = props.compaction;
  if (!c) return '';
  if (c.status === 'running') return t('conversation.compacting');
  if (typeof c.tokensBefore === 'number' && typeof c.tokensAfter === 'number') {
    return t('conversation.compacted', { before: c.tokensBefore, after: c.tokensAfter });
  }
  return t('conversation.compactedPlain');
});

// Per-turn copy button state (keyed by turn id)
const copiedTurn = ref<string | null>(null);



/** Assemble the full content of a turn for copying — follows the ordered
    blocks so thinking/text/tool output copy in the order they happened. */
function turnPlainText(turn: ChatTurn): string {
  const parts: string[] = [];
  for (const blk of turnBlocks(turn)) {
    if (blk.kind === 'thinking' && blk.thinking) parts.push(blk.thinking);
    else if (blk.kind === 'text' && blk.text) parts.push(blk.text);
    else if (blk.kind === 'tool' && blk.tool.output && blk.tool.output.length > 0) {
      parts.push(`[${blk.tool.name}]\n${blk.tool.output.join('\n')}`);
    }
  }
  return parts.join('\n\n');
}

function assistantRunEndingAt(index: number): ChatTurn[] {
  const run: ChatTurn[] = [];
  for (let i = index; i >= 0; i--) {
    const turn = props.turns[i];
    if (!turn || turn.role !== 'assistant') break;
    run.unshift(turn);
  }
  return run;
}

function isAssistantRunEnd(index: number): boolean {
  const turn = props.turns[index];
  if (!turn || turn.role !== 'assistant') return false;
  const next = props.turns[index + 1];
  return !next || next.role !== 'assistant';
}

function copyAssistantRun(index: number): void {
  const turn = props.turns[index];
  if (!turn) return;
  const text = assistantRunEndingAt(index)
    .map((t) => turnPlainText(t))
    .filter(Boolean)
    .join('\n\n');
  navigator.clipboard.writeText(text).then(() => {
    copiedTurn.value = turn.id;
    setTimeout(() => { copiedTurn.value = null; }, 1400);
  }).catch(() => {/* ignore */});
}

// Ordered render blocks for an assistant turn. messagesToTurns supplies `blocks`
// (thinking + text + tool cards in call order); fall back to deriving them from
// the aggregate fields for any turn built without blocks (e.g. unit tests).
function turnBlocks(turn: ChatTurn): TurnBlock[] {
  if (turn.blocks) return turn.blocks;
  const blocks: TurnBlock[] = [];
  if (turn.thinking) blocks.push({ kind: 'thinking', thinking: turn.thinking });
  if (turn.text) blocks.push({ kind: 'text', text: turn.text });
  for (const tool of turn.tools ?? []) blocks.push({ kind: 'tool', tool });
  return blocks;
}

/** Extract a file path from a tool argument string (JSON or plain).
    TODO: temporarily unused with turn-summary hidden. */
// function extractFilePath(arg: string): string | undefined {
//   try {
//     const d = JSON.parse(arg) as Record<string, unknown>;
//     const p =
//       (typeof d.path === 'string' ? d.path : undefined) ??
//       (typeof d.file_path === 'string' ? d.file_path : undefined) ??
//       (typeof d.filePath === 'string' ? d.filePath : undefined) ??
//       (typeof d.filename === 'string' ? d.filename : undefined) ??
//       (typeof d.dir === 'string' ? d.dir : undefined) ??
//       (typeof d.directory === 'string' ? d.directory : undefined) ??
//       (typeof d.cwd === 'string' ? d.cwd : undefined);
//     return p ? p.split('/').pop() ?? p : undefined;
//   } catch {
//     return undefined;
//   }
// }

/** Count tools and unique files touched in a turn.
    TODO: temporarily unused with turn-summary hidden. */
// function countToolsAndFiles(turn: ChatTurn): { toolCount: number; fileCount: number } {
//   let toolCount = 0;
//   const filePaths = new Set<string>();
//   for (const blk of turnBlocks(turn)) {
//     if (blk.kind !== 'tool') continue;
//     toolCount++;
//     const path = extractFilePath(blk.tool.arg);
//     if (path) filePaths.add(path);
//   }
//   return { toolCount, fileCount: filePaths.size };
// }

/** Turn-end summary: "已调用 3 个工具，修改 5 个文件".
    TODO: temporarily hidden — uncomment when turn-summary UI is ready. */
// function turnSummary(turn: ChatTurn): string {
//   const { toolCount, fileCount } = countToolsAndFiles(turn);
//   const parts: string[] = [];
//   if (toolCount > 0) parts.push(`已调用 ${toolCount} 个工具`);
//   if (fileCount > 0) parts.push(`修改 ${fileCount} 个文件`);
//   return parts.join('，');
// }
</script>

<template>
  <!-- ===================== MOBILE: chat bubbles ===================== -->
  <!-- Same ChatTurn data as desktop, rendered as bubbles. User turns are
       right-aligned soft-blue bubbles (no `user@kimi $` prefix, no line number);
       assistant turns are left-aligned plain text with NO role/name label,
       showing in order: thinking → message text → tool cards. -->
  <div v-if="childBubble" class="chat">
    <div v-if="sessionLoading" class="chat-loading">
      <span class="dot-pulse" aria-hidden="true" />
      <span class="chat-loading-text">{{ t('conversation.loading') }}</span>
    </div>
    <div v-else-if="turns.length === 0 && (!approvals || approvals.length === 0)" class="chat-empty" />

    <template v-for="(turn, ti) in turns" :key="turn.id">
      <!-- User turn → right-aligned soft-blue bubble -->
      <div v-if="turn.role === 'user'" class="u-bub">
        <!-- Image attachments -->
        <div v-if="turn.images && turn.images.length > 0" class="u-imgs">
          <img
            v-for="(img, ii) in turn.images"
            :key="ii"
            class="u-img"
            :src="img.url"
            :alt="img.alt || ''"
            loading="lazy"
          />
        </div>
        <!-- User input renders verbatim (pre-wrap), never through Markdown -->
        <div class="u-text">{{ turn.text }}</div>
      </div>

      <!-- Assistant turn → left-aligned, no name/role label. -->
      <div v-else class="a-msg">
        <template v-for="(blk, bi) in turnBlocks(turn)" :key="bi">
          <ThinkingBlock v-if="blk.kind === 'thinking'" :text="blk.thinking" :mobile="childBubble" :streaming="turn.id === streamingTurnId && bi === turnBlocks(turn).length - 1" />
          <div v-else-if="blk.kind === 'text' && blk.text" class="msg"><Markdown :text="blk.text" :streaming="turn.id === streamingTurnId && bi === turnBlocks(turn).length - 1" /></div>
          <ToolCall v-else-if="blk.kind === 'tool'" :tool="blk.tool" :mobile="childBubble" />
        </template>
        <!-- TODO: temporarily hidden turn-summary
        <div v-if="turn.id !== streamingTurnId && turnSummary(turn)" class="turn-summary">{{ turnSummary(turn) }}</div>
        -->
        <div v-if="turn.id !== streamingTurnId && isAssistantRunEnd(ti)" class="a-msg-ft">
          <button
            class="a-cpbtn"
            :title="t('filePreview.copy')"
            tabindex="-1"
            @click="copyAssistantRun(ti)"
          >
            <svg v-if="copiedTurn !== turn.id" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="9" height="9" rx="1.5"/>
              <path d="M6 1h7a1 1 0 0 1 1 1v7"/>
            </svg>
            <svg v-else viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="3,8 6.5,11.5 13,5"/>
            </svg>
            <span>{{ t('filePreview.copy') }}</span>
          </button>
        </div>
      </div>
    </template>

    <ApprovalCard
      v-for="a in approvals"
      :key="a.approvalId"
      :block="a.block"
      :agent-name="a.agentName"
      @decide="(response) => emit('approvalDecide', a.approvalId, response)"
    />

    <!-- Compaction banner — running ("compacting…") or transient done note -->
    <div v-if="compaction" class="compaction-note" :class="compaction.status">
      <span v-if="compaction.status === 'running'" class="dot-pulse" aria-hidden="true" />
      <span>{{ compactionLabel }}</span>
    </div>

    <!-- Sending placeholder — moon spinner while the request is in flight -->
    <div v-if="sending" class="sending-placeholder">
      <span class="moon-spin" aria-label="Sending…">{{ MOON_FRAMES[moonFrame] }}</span>
    </div>
  </div>

  <!-- ===================== DESKTOP: line-turns ===================== -->
  <div v-else class="term">
    <!-- Loading state: shown while fetching a historical session's turns -->
    <div v-if="sessionLoading" class="chat-loading">
      <span class="dot-pulse" aria-hidden="true" />
      <span class="chat-loading-text">{{ t('conversation.loading') }}</span>
    </div>
    <!-- Empty state: a fresh/empty session shows a blank pane (Composer lives in
         the dock, moved here by ConversationPane when workspaceEmpty). -->
    <div v-else-if="turns.length === 0 && (!approvals || approvals.length === 0)" class="chat-empty" />

    <template v-for="(turn, ti) in turns" :key="turn.id">
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

            <!-- Per-message copy button (shown on hover, only when turn is complete) -->
            <button v-if="turn.id !== streamingTurnId && isAssistantRunEnd(ti)" class="cpbtn" @click="copyAssistantRun(ti)" :title="t('filePreview.copy')" tabindex="-1">
              <svg v-if="copiedTurn !== turn.id" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="9" height="9" rx="1.5"/>
                <path d="M6 1h7a1 1 0 0 1 1 1v7"/>
              </svg>
              <svg v-else viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="3,8 6.5,11.5 13,5"/>
              </svg>
            </button>
          </div>

          <!-- User input renders verbatim (pre-wrap), never through Markdown -->
          <div v-if="turn.role === 'user'" class="u-text">{{ turn.text }}</div>

          <!-- Thinking + message text + tool cards, interleaved in original call order. -->
          <template v-else>
            <template v-for="(blk, bi) in turnBlocks(turn)" :key="bi">
              <ThinkingBlock v-if="blk.kind === 'thinking'" :text="blk.thinking" :streaming="turn.id === streamingTurnId && bi === turnBlocks(turn).length - 1" />
              <Markdown v-else-if="blk.kind === 'text' && blk.text" :text="blk.text" :streaming="turn.id === streamingTurnId && bi === turnBlocks(turn).length - 1" />
              <ToolCall v-else-if="blk.kind === 'tool'" :tool="blk.tool" />
            </template>
          </template>
          <!-- TODO: temporarily hidden turn-summary
        <div v-if="turn.id !== streamingTurnId && turnSummary(turn)" class="turn-summary">{{ turnSummary(turn) }}</div>
        -->
        </div>
      </div>
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

    <!-- Compaction banner — running ("compacting…") or transient done note -->
    <div v-if="compaction" class="compaction-note" :class="compaction.status">
      <span v-if="compaction.status === 'running'" class="dot-pulse" aria-hidden="true" />
      <span>{{ compactionLabel }}</span>
    </div>

    <!-- Sending placeholder — moon spinner while the request is in flight -->
    <div v-if="sending" class="ln sending-line">
      <span class="no">—</span>
      <div class="tx">
        <div class="role-row">
          <span class="pr">kimi</span>
          <span class="who"> &gt; </span>
        </div>
        <span class="moon-spin" aria-label="Sending…">{{ MOON_FRAMES[moonFrame] }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.term {
  padding: 14px 18px 10px;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.chat-empty {
  /* Fills the chat area and centers the hint vertically (parent grows via flex). */
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px 16px;
  color: var(--faint);
  text-align: center;
}
.chat-empty-text { font-size: 13px; }

.chat-loading {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px 16px;
  color: var(--muted);
}
.chat-loading-text { font-size: 13px; }
.dot-pulse {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--blue);
  animation: dot-pulse-anim 1.4s ease-in-out infinite;
}
@keyframes dot-pulse-anim {
  0%, 100% { opacity: 0.4; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1); }
}

.ln { display: flex; gap: 11px; margin-bottom: 10px; }
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
  display: inline-flex;
  align-items: center;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--faint);
  font-size: 13px;
  font-family: var(--mono);
  padding: 0 4px;
  opacity: 0;
  transition: opacity 0.1s;
  margin-left: 8px;
}
.ln:hover .cpbtn {
  opacity: 1;
}
.cpbtn:hover {
  color: var(--blue);
}

/* ===================== Mobile bubble layout ===================== */
.chat {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 16px 14px 20px;
  flex: 1;
  min-height: 0;
}
.chat .chat-empty { align-self: stretch; }

/* User message → right-aligned soft-blue bubble */
.u-bub {
  align-self: flex-end;
  max-width: 84%;
  background: var(--bluebg);
  border: 1px solid var(--blueln);
  color: var(--ink);
  border-radius: 16px 16px 5px 16px;
  padding: 10px 14px;
  font-size: 14px;
  line-height: 1.55;
}
/* User input is shown verbatim — preserve newlines, break long tokens. */
.u-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Compaction banner — "compacting…" while running, transient done note after. */
.compaction-note {
  display: flex;
  align-items: center;
  gap: 8px;
  align-self: flex-start;
  margin: 6px 0;
  font-size: 12.5px;
  font-family: var(--mono);
  color: var(--faint);
}
.compaction-note.completed { color: var(--ok); }

/* Assistant message → left-aligned plain column, no role label */
.a-msg {
  align-self: flex-start;
  max-width: 94%;
  width: 94%;
}
.turn-summary {
  color: var(--faint);
  font-size: 13px;
  font-family: var(--mono);
  margin-top: 8px;
  line-height: 1.4;
}
.a-msg-ft {
  display: flex;
  height: auto;
  margin-top: 10px;
  opacity: 0;
  overflow: visible;
  pointer-events: none;
  transition: opacity 0.1s;
}
.a-msg:hover .a-msg-ft,
.a-msg:focus-within .a-msg-ft {
  opacity: 1;
  pointer-events: auto;
}

.a-cpbtn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: var(--faint);
  cursor: pointer;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
}
.a-cpbtn:hover {
  background: var(--soft);
  color: var(--ink);
}
.a-cpbtn svg {
  flex: none;
}
/* Touch devices: always show copy button for easier tapping */
@media (hover: none) {
  .a-msg-ft {
    height: auto;
    margin-top: 10px;
    opacity: 1;
    pointer-events: auto;
  }
}
.a-msg .msg {
  font-size: 14px;
  line-height: 1.6;
  color: var(--ink);
  font-weight: 500;
}
.a-msg .msg :deep(p) { margin: 0; }
.a-msg .msg :deep(p + p) { margin-top: 8px; }
/* Each block gets 8px top spacing, except the very first child sits flush. */
.a-msg > .msg { margin-top: 12px; }
.a-msg > .msg:first-child { margin-top: 0; }
.a-msg :deep(code) {
  font-family: var(--mono);
  font-size: 13px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 1px 5px;
  color: var(--blue2);
}

.u-imgs {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.u-img {
  max-width: 100%;
  max-height: 200px;
  border-radius: 8px;
  object-fit: cover;
}

/* NOTE: Modern-theme chat/bubble styles live in src/style.css (global). Scoped
   `:global(html[data-theme=modern]) .u-bub` rules here did NOT win the cascade,
   so they were moved to the global sheet. */

/* ---- Moon spinner — shown while the prompt is in flight ---- */
.moon-spin {
  display: inline-block;
  font-size: 14px;
  line-height: 1;
  user-select: none;
}

/* Mobile bubble layout sending placeholder */
.sending-placeholder {
  align-self: flex-start;
  padding: 10px 14px;
}

/* Desktop line-turns sending placeholder */
.sending-line .tx {
  padding-top: 2px;
}

/* Mobile font bump (+2px) */
@media (max-width: 640px) {
  .u-bub .u-text,
  .a-msg .msg {
    font-size: 16px;
  }
  .userline .pr,
  .ai .pr,
  .who {
    font-size: 14.5px;
  }
  .ts {
    font-size: 13px;
  }
  .chat-empty-text,
  .chat-loading-text {
    font-size: 15px;
  }
}
</style>
