import { describe, expect, it } from 'vitest';
import type { AppMessage } from '../src/api/types';
import { mergeSnapshotMessages } from '../src/lib/mergeSnapshotMessages';

function msg(id: string): AppMessage {
  return {
    id,
    sessionId: 's1',
    role: 'user',
    content: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('mergeSnapshotMessages', () => {
  it('returns the snapshot verbatim when there is no live list', () => {
    const snapshot = [msg('a'), msg('b')];
    expect(mergeSnapshotMessages(snapshot, [])).toBe(snapshot);
  });

  it('returns the snapshot verbatim when every live message is already in it', () => {
    const snapshot = [msg('a'), msg('b')];
    const live = [msg('a'), msg('b')];
    expect(mergeSnapshotMessages(snapshot, live)).toBe(snapshot);
  });

  it('appends live messages that are not in the snapshot, in order', () => {
    const snapshot = [msg('a'), msg('b')];
    const live = [msg('a'), msg('b'), msg('c'), msg('d')];
    expect(mergeSnapshotMessages(snapshot, live).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('dedups by id and keeps only the live-only tail', () => {
    const snapshot = [msg('a'), msg('b')];
    const live = [msg('b'), msg('c')];
    expect(mergeSnapshotMessages(snapshot, live).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('appends the whole live list when the snapshot is empty', () => {
    const live = [msg('x'), msg('y')];
    expect(mergeSnapshotMessages([], live).map((m) => m.id)).toEqual(['x', 'y']);
  });
});
