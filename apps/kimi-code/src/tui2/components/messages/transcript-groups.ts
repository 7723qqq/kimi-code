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

// ---------------------------------------------------------------------------
// Identity-stable grouping (SolidJS `<For>` friendliness)
// ---------------------------------------------------------------------------

/**
 * A stateful grouper whose display items keep their identity across calls
 * when the underlying entries did not change.
 *
 * The streaming path replaces the transcript array wholesale on every
 * progress event, so a plain `groupTranscriptEntries` call produces fresh
 * wrapper objects each time and Solid's referential `<For>` diff tears down
 * and rebuilds every mounted message row. Transaction entries are treated as
 * immutable snapshots (patches replace the object), which makes the entry
 * reference itself a sound cache key:
 *
 * - `single` wrappers live in a `WeakMap` keyed by entry — patched or
 *   trimmed entries age out automatically.
 * - `group` items are cached per run key and rebuilt only when one of the
 *   member entry references changed.
 */
export interface TranscriptGrouper {
  group(entries: readonly TranscriptEntry[]): readonly TranscriptDisplayItem[];
}

export function createTranscriptGrouper(): TranscriptGrouper {
  const singles = new WeakMap<TranscriptEntry, TranscriptDisplayItem>();
  const groups = new Map<
    string,
    {
      readonly item: Extract<TranscriptDisplayItem, { kind: 'group' }>;
      readonly sources: readonly TranscriptEntry[];
    }
  >();

  const singleOf = (entry: TranscriptEntry): TranscriptDisplayItem => {
    let item = singles.get(entry);
    if (item === undefined) {
      item = { kind: 'single', entry };
      singles.set(entry, item);
    }
    return item;
  };

  return {
    group(entries) {
      const items: TranscriptDisplayItem[] = [];
      let currentKey: string | undefined;
      let currentTool: 'read' | 'agent' | undefined;
      let currentEntries: TranscriptEntry[] = [];
      let currentMembers: TranscriptGroupMember[] = [];

      const flush = (): void => {
        if (currentKey === undefined || currentTool === undefined) return;
        if (currentMembers.length >= 2) {
          const sources = [...currentEntries];
          const cached = groups.get(currentKey);
          const unchanged =
            cached !== undefined &&
            cached.sources.length === sources.length &&
            cached.sources.every((source, index) => source === sources[index]);
          if (unchanged) {
            items.push(cached!.item);
          } else {
            const item = {
              kind: 'group' as const,
              groupKey: currentKey,
              tool: currentTool,
              members: currentMembers,
            };
            groups.set(currentKey, { item, sources });
            items.push(item);
          }
        } else {
          for (const entry of currentEntries) items.push(singleOf(entry));
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
        items.push(singleOf(entry));
      }
      flush();

      // Age out group caches whose run disappeared entirely (below the 2
      // member threshold or merged into another key) so the map mirrors the
      // visible groups.
      const liveKeys = new Set<string>();
      for (const item of items) {
        if (item.kind === 'group') liveKeys.add(item.groupKey);
      }
      for (const key of groups.keys()) {
        // Deleting during Map iteration is well-defined: unvisited deleted
        // keys are skipped.
        if (!liveKeys.has(key)) groups.delete(key);
      }
      return items;
    },
  };
}
