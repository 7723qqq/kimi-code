/**
 * TUI2 transcript grouping tests.
 *
 * MainShell folds consecutive same-`groupKey` tool-call entries into single
 * Read/Agent group rows (`groupTranscriptEntries`); these tests pin the fold
 * rules — adjacency, key equality, tool/payload consistency, and fallbacks.
 */

import { describe, expect, it } from 'vitest'

import {
  groupTranscriptEntries,
  type TranscriptDisplayItem,
} from '@/tui2/components/messages/transcript-groups'
import type { ToolCallBlockData, TranscriptEntry } from '@/tui2/types'

let seq = 0;

function toolEntry(name: string, groupKey?: string): TranscriptEntry {
  const data: ToolCallBlockData = { id: `tc-${++seq}`, name, args: {} };
  return {
    id: `e-${seq}`,
    kind: 'tool_call',
    turnId: 'turn-1',
    renderMode: 'plain',
    content: '',
    groupKey,
    toolCallData: data,
  };
}

function statusEntry(): TranscriptEntry {
  return {
    id: `e-${++seq}`,
    kind: 'status',
    renderMode: 'plain',
    content: 'ok',
  };
}

const groupKeysOf = (items: readonly TranscriptDisplayItem[]): (string | undefined)[] =>
  items.map((item) => (item.kind === 'group' ? item.groupKey : undefined));

describe('groupTranscriptEntries', () => {
  it('keeps entries without a groupKey as singles', () => {
    const items = groupTranscriptEntries([toolEntry('Read'), statusEntry(), toolEntry('Bash')]);
    expect(items.every((item) => item.kind === 'single')).toBe(true);
  });

  it('merges consecutive Read calls sharing a read: key', () => {
    const items = groupTranscriptEntries([
      toolEntry('Read', 'read:t1:2'),
      toolEntry('Read', 'read:t1:2'),
      toolEntry('Edit'),
    ]);
    expect(items).toHaveLength(2);
    const group = items[0];
    expect(group?.kind).toBe('group');
    if (group?.kind !== 'group') return;
    expect(group.tool).toBe('read');
    expect(group.members.map((m) => m.toolCall.name)).toEqual(['Read', 'Read']);
    expect(group.members[0]?.result).toBeUndefined();
  });

  it('merges consecutive Agent calls sharing an agent: key', () => {
    const items = groupTranscriptEntries([
      toolEntry('Agent', 'agent:t1:3'),
      toolEntry('Agent', 'agent:t1:3'),
      toolEntry('Agent', 'agent:t1:3'),
    ]);
    expect(items).toHaveLength(1);
    const group = items[0];
    if (group?.kind !== 'group') return;
    expect(group.tool).toBe('agent');
    expect(group.members).toHaveLength(3);
    expect(groupKeysOf(items)).toEqual(['agent:t1:3']);
  });

  it('does not merge across a different key or an intervening entry', () => {
    const items = groupTranscriptEntries([
      toolEntry('Read', 'read:t1:1'),
      toolEntry('Read', 'read:t1:2'),
    ]);
    expect(groupKeysOf(items)).toEqual([undefined, undefined]);

    const interrupted = groupTranscriptEntries([
      toolEntry('Read', 'read:t1:1'),
      statusEntry(),
      toolEntry('Read', 'read:t1:1'),
    ]);
    expect(interrupted.every((item) => item.kind === 'single')).toBe(true);
  });

  it('falls back to singles when payload contradicts the key', () => {
    // Read-prefixed key carrying an Agent call (and vice versa).
    const mismatched = groupTranscriptEntries([
      toolEntry('Agent', 'read:t1:1'),
      toolEntry('Agent', 'read:t1:1'),
    ]);
    expect(mismatched.every((item) => item.kind === 'single')).toBe(true);

    // tool_call entry without payload data can never join a group.
    const bare: TranscriptEntry = { ...toolEntry('Read', 'read:t1:1'), toolCallData: undefined };
    expect(groupTranscriptEntries([bare, bare])).toHaveLength(2);
  });

  it('carries result data through group members', () => {
    const withResult = toolEntry('Read', 'read:t1:1');
    withResult.toolCallData = {
      ...withResult.toolCallData!,
      result: { tool_call_id: withResult.toolCallData!.id, output: 'x' },
    };
    const items = groupTranscriptEntries([withResult]);
    const group = items[0];
    if (group?.kind !== 'group') return;
    expect(group.members[0]?.result?.output).toBe('x');
  });
});
