/**
 * `contextMemory` domain (L4) — wire Model (`ContextModel`) and the wire-protocol
 * 1.4 Ops `context.append_message` (`contextAppendMessage`) / `context.clear`
 * (`contextClear`) / `context.apply_compaction` (`contextApplyCompaction`) /
 * `context.undo` (`contextUndo`) for the per-agent conversation history, plus the
 * legacy `context.splice` (`contextSplice`) Op and the `contextBlobSelector` that
 * drives blob offload for persisted message parts.
 *
 * Declares the history as `ContextMessage[]` (initial `[]`); every Op's `apply`
 * is a pure array transform that returns a NEW reference on change and the SAME
 * reference on a no-op (so the wire's reference-equality gate stays quiet), and
 * carries no non-determinism — message ids are stamped at the dispatch call site
 * (`AgentContextMemoryService.append`), never inside `apply`.
 *
 * The live write path emits the 1.4 Ops (`append_message` / `clear` /
 * `apply_compaction` / `undo`); assistant and tool messages are persisted already
 * folded (the loop appends whole messages, not raw loop events), so on-disk
 * records use the 1.4 type names without reintroducing a stateful loop-event
 * fold. `context.splice` (the pre-1.4 primitive) stays registered so
 * sessions written at wire protocol 1.5 still replay (newer-version passthrough,
 * no migration) and for the few internal single-delete mutations that have no 1.4
 * spelling.
 *
 * Blob handling uses two complementary mechanisms:
 * - `contextBlobSelector` (record-level): offloads oversized content parts to
 *   blob storage on append, replacing data URIs with `blobref:` references.
 * - `ContextModel.rehydrate` (model-level): after replay, traverses the
 *   surviving final state and rehydrates `blobref:` URLs back to inline data
 *   URIs — skipping I/O for data that was compacted away during the session.
 *
 * The selector is seeded into the Agent wire by `agentLifecycle`.
 */

import type { ContentPart } from '#/app/llmProtocol';
import { defineModel, defineOp, type WireBlobSelector } from '#/wire';

import type { ContextMessage } from './types';

export const ContextModel = defineModel<ContextMessage[]>('contextMemory', () => [], {
  rehydrate: async (state, rehydrateParts) => {
    let changed = false;
    const result: ContextMessage[] = [];
    for (const msg of state) {
      const parts = await rehydrateParts(msg.content);
      if (parts !== msg.content) {
        changed = true;
        result.push({ ...msg, content: [...parts] as ContentPart[] });
      } else {
        result.push(msg);
      }
    }
    return changed ? result : state;
  },
});

export interface ContextSplicePayload {
  readonly start: number;
  readonly deleteCount: number;
  readonly messages: readonly ContextMessage[];
  readonly tokens?: number;
}

/** @deprecated Legacy 1.5 record type; kept for replay of old sessions and rare internal single-deletes. */
export const contextSplice = defineOp(ContextModel, 'context.splice', {
  apply: (state, p: ContextSplicePayload): ContextMessage[] => {
    if (p.deleteCount === 0 && p.messages.length === 0) return state;
    const next = state.slice();
    next.splice(p.start, p.deleteCount, ...p.messages);
    return next;
  },
});

export interface ContextMessagePayload {
  readonly message: ContextMessage;
}

export const contextAppendMessage = defineOp(ContextModel, 'context.append_message', {
  apply: (state, p: ContextMessagePayload): ContextMessage[] => [...state, p.message],
});

export const contextClear = defineOp(ContextModel, 'context.clear', {
  apply: (state): ContextMessage[] => (state.length === 0 ? state : []),
});

export interface ContextCompactionPayload {
  readonly count: number;
  readonly summary: ContextMessage;
}

export const contextApplyCompaction = defineOp(ContextModel, 'context.apply_compaction', {
  apply: (state, p: ContextCompactionPayload): ContextMessage[] => [
    p.summary,
    ...state.slice(p.count),
  ],
});

export interface ContextUndoPayload {
  readonly count: number;
}

export interface UndoCut {
  readonly cutIndex: number;
  readonly removedCount: number;
  readonly stoppedAtCompaction: boolean;
}

/**
 * Locate the trailing cut for an undo of `count` real-user prompts: the oldest
 * index of the Nth-from-tail real-user prompt (skipping `injection` messages and
 * stopping at a `compaction_summary` boundary). `removedCount` is how many
 * real-user prompts were found; `cutIndex` is where the trailing exchange begins
 * (everything from there to the end is removed), or `-1` when none was found.
 * Shared by the `context.undo` reducer and the live service so dispatch and
 * replay produce identical state.
 */
export function computeUndoCut(state: readonly ContextMessage[], count: number): UndoCut {
  let remaining = count;
  let cutIndex = -1;
  let removedCount = 0;
  let stoppedAtCompaction = false;
  for (let i = state.length - 1; i >= 0 && remaining > 0; i--) {
    const message = state[i];
    if (message === undefined || message.origin?.kind === 'injection') continue;
    if (message.origin?.kind === 'compaction_summary') {
      stoppedAtCompaction = true;
      break;
    }
    if (isRealUserPrompt(message)) {
      remaining--;
      removedCount++;
      cutIndex = i;
    }
  }
  return { cutIndex, removedCount, stoppedAtCompaction };
}

export const contextUndo = defineOp(ContextModel, 'context.undo', {
  apply: (state, p: ContextUndoPayload): ContextMessage[] => {
    if (p.count <= 0 || state.length === 0) return state;
    const { cutIndex, removedCount } = computeUndoCut(state, p.count);
    if (cutIndex < 0 || removedCount < p.count) return state;
    return state.slice(0, cutIndex);
  },
});

function isRealUserPrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  return (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
}

export const contextBlobSelector: WireBlobSelector = (record) => {
  if (record.type === 'context.splice') {
    const messages = record['messages'];
    if (!Array.isArray(messages)) return [];
    return (messages as readonly ContextMessage[]).map((message, index) => ({
      parts: message.content,
      replace: (current, parts) => ({
        ...current,
        messages: (current['messages'] as readonly ContextMessage[]).map((item, itemIndex) =>
          itemIndex === index ? { ...item, content: [...parts] } : item,
        ),
      }),
    }));
  }
  if (record.type === 'context.append_message') {
    const message = record['message'] as ContextMessage | undefined;
    if (message === undefined) return [];
    return [
      {
        parts: message.content,
        replace: (current, parts) => ({
          ...current,
          message: { ...(current['message'] as ContextMessage), content: [...parts] },
        }),
      },
    ];
  }
  return [];
};
