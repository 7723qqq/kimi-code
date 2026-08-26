/**
 * TUI2 transcript grouping tests.
 *
 * MainShell folds consecutive same-`groupKey` tool-call entries into single
 * Read/Agent group rows (`groupTranscriptEntries`); these tests pin the fold
 * rules — adjacency, key equality, tool/payload consistency, and fallbacks.
 */

import { describe, expect, it } from 'vitest'

import {
  createTranscriptGrouper,
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

describe('createTranscriptGrouper', () => {
  it('reuses single wrappers for unchanged entry references across calls', () => {
    const grouper = createTranscriptGrouper();
    const a = toolEntry('Bash');
    const b = statusEntry();
    const first = grouper.group([a, b]);

    // Same entries → same wrapper references (Solid <For> keeps rows mounted).
    const second = grouper.group([a, b, toolEntry('Bash')]);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it('invalidates a single wrapper when the entry is replaced by a patch', () => {
    const grouper = createTranscriptGrouper();
    const original = toolEntry('Bash');
    grouper.group([original]);
    const patched = { ...original, expanded: true };

    const items = grouper.group([patched]);
    expect(items).toHaveLength(1);
    if (items[0]?.kind !== 'single') return;
    expect(items[0].entry).toBe(patched);
  });

  it('keeps the group item while its member entry references are stable', () => {
    const grouper = createTranscriptGrouper();
    const g1 = toolEntry('Read', 'read:t1:1');
    const g2 = toolEntry('Read', 'read:t1:1');
    const first = grouper.group([g1, g2]);
    expect(first[0]?.kind).toBe('group');

    const second = grouper.group([g1, g2, toolEntry('Read', 'read:t1:2')]);
    expect(second[0]).toBe(first[0]);
  });

  it('rebuilds the group item when any member entry changes', () => {
    const grouper = createTranscriptGrouper();
    const g1 = toolEntry('Read', 'read:t1:1');
    const g2 = toolEntry('Read', 'read:t1:1');
    const first = grouper.group([g1, g2]);

    const patched = {
      ...g1,
      toolCallData: { ...g1.toolCallData!, result: undefined },
    };
    const second = grouper.group([patched, g2]);
    expect(second[0]?.kind).toBe('group');
    expect(second[0]).not.toBe(first[0]);
    if (second[0]?.kind !== 'group') return;
    expect(second[0].members.map((m) => m.entryId)).toEqual([patched.id, g2.id]);
  });

  it('rebuilds rather than resurrects after a run drops below the threshold', () => {
    const grouper = createTranscriptGrouper();
    const g1 = toolEntry('Read', 'read:t1:1');
    const g2 = toolEntry('Read', 'read:t1:1');
    const first = grouper.group([g1, g2]);
    expect(first[0]?.kind).toBe('group');

    // Down to one member → flushed as singles, cache aged out.
    const alone = grouper.group([g1]);
    expect(alone.every((item) => item.kind === 'single')).toBe(true);

    // Regrowing with a different second member must build from the current
    // entries, not resurrect the stale cached group.
    const fresh2 = toolEntry('Read', 'read:t1:1');
    const again = grouper.group([g1, fresh2]);
    if (again[0]?.kind !== 'group') return expect.fail('expected a group');
    expect(again[0].members.map((m) => m.entryId)).toEqual([g1.id, fresh2.id]);
  });
});
