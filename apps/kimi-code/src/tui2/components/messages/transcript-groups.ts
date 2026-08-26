/**
 * TUI2 transcript grouping — merge consecutive tool-call entries that share
 * a `groupKey` into one display item.
 *
 * The streaming controller (`controllers/streaming-ui.ts`) stamps
 * `groupKey: 'read:<turn>:<step>'` / `'agent:<turn>:<step>'` onto Read /
 * Agent tool-call entries once a solo call is joined by a sibling in the
 * same step (mirrors v1's upgrade-solo-to-group flow). MainShell folds each
 * consecutive run of equal keys into a single group row rendered by
 * `ReadGroupView` / `AgentGroupView`. An orphaned run of one (its siblings
 * trimmed away, or a payload that contradicts the key's tool) falls back to
 * the plain single-entry rendering.
 *
 * Pure data — no JSX, no framework imports — so it stays unit-testable.
 *
 * Status: REAL (tui2). New file — no v1 counterpart.
 */

import type { ToolCallBlockData, ToolResultBlockData, TranscriptEntry } from '../../types';

/** One Read/Agent tool call inside a rendered group. */
export interface TranscriptGroupMember {
  readonly entryId: string;
  readonly toolCallId: string;
  readonly toolCall: ToolCallBlockData;
  readonly result?: ToolResultBlockData;
}

export type TranscriptDisplayItem =
  | { readonly kind: 'single'; readonly entry: TranscriptEntry }
  | {
      readonly kind: 'group';
      readonly groupKey: string;
      /** 'read' renders via ReadGroupView, 'agent' via AgentGroupView. */
      readonly tool: 'read' | 'agent';
      readonly members: readonly TranscriptGroupMember[];
    };

function groupMemberOf(entry: TranscriptEntry): TranscriptGroupMember | undefined {
  const data = entry.toolCallData;
  if (data === undefined) return undefined;
  return { entryId: entry.id, toolCallId: data.id, toolCall: data, result: data.result };
}

function groupToolOf(key: string, member: TranscriptGroupMember): 'read' | 'agent' | undefined {
  if (key.startsWith('read:')) return member.toolCall.name === 'Read' ? 'read' : undefined;
  if (key.startsWith('agent:')) return member.toolCall.name === 'Agent' ? 'agent' : undefined;
  return undefined;
}

/**
 * Fold `entries` into display items: every maximal run of ≥2 consecutive
 * `tool_call` entries sharing the same non-undefined `groupKey` becomes one
 * `group` item; everything else stays a `single`.
 */
export function groupTranscriptEntries(
  entries: readonly TranscriptEntry[],
): readonly TranscriptDisplayItem[] {
  const items: TranscriptDisplayItem[] = [];
  let currentKey: string | undefined;
  let currentTool: 'read' | 'agent' | undefined;
  let currentEntries: TranscriptEntry[] = [];
  let currentMembers: TranscriptGroupMember[] = [];

  const flush = (): void => {
    if (currentKey === undefined || currentTool === undefined) return;
    if (currentMembers.length >= 2) {
      items.push({
        kind: 'group',
        groupKey: currentKey,
        tool: currentTool,
        members: currentMembers,
      });
    } else {
      for (const entry of currentEntries) items.push({ kind: 'single', entry });
    }
    currentKey = undefined;
    currentTool = undefined;
    currentEntries = [];
    currentMembers = [];
  };

  for (const entry of entries) {
    const member =
      entry.kind === 'tool_call' && entry.groupKey !== undefined
        ? groupMemberOf(entry)
        : undefined;
    const tool = member !== undefined ? groupToolOf(entry.groupKey ?? '', member) : undefined;
    // Same key ⇒ same prefix ⇒ same tool; just extend the running group.
    if (member !== undefined && tool !== undefined && entry.groupKey === currentKey) {
      currentEntries.push(entry);
      currentMembers.push(member);
      continue;
    }
    flush();
    if (member !== undefined && tool !== undefined) {
      currentKey = entry.groupKey;
      currentTool = tool;
      currentEntries = [entry];
      currentMembers = [member];
      continue;
    }
    items.push({ kind: 'single', entry });
  }
  flush();
  return items;
}
