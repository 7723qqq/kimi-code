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

const ids = (...xs: string[]): ReadonlySet<string> => new Set(xs);

describe('mergeSnapshotMessages', () => {
  it('returns the snapshot verbatim when there is no live list', () => {
    const snapshot = [msg('a'), msg('b')];
    expect(mergeSnapshotMessages(snapshot, [], ids())).toBe(snapshot);
  });

  it('returns the snapshot verbatim when every live message is already in it', () => {
    const snapshot = [msg('a'), msg('b')];
    const live = [msg('a'), msg('b')];
    expect(mergeSnapshotMessages(snapshot, live, ids('a', 'b'))).toBe(snapshot);
  });

  it('appends live messages that arrived during the fetch (not in beforeIds, not in snapshot)', () => {
    const snapshot = [msg('a'), msg('b')];
    const live = [msg('a'), msg('b'), msg('c'), msg('d')];
    // a,b were present before the fetch; c,d arrived during it.
    expect(mergeSnapshotMessages(snapshot, live, ids('a', 'b')).map((m) => m.id)).toEqual([
      'a', 'b', 'c', 'd',
    ]);
  });

  it('does NOT re-append a pre-existing local-only message (optimistic bubble)', () => {
    // Local optimistic bubble keeps its msg_opt_* id; the snapshot carries the
    // daemon id. Both were present before the fetch.
    const snapshot = [msg('a'), msg('user_x')];
    const live = [msg('a'), msg('msg_opt_x')];
    expect(mergeSnapshotMessages(snapshot, live, ids('a', 'msg_opt_x')).map((m) => m.id)).toEqual([
      'a', 'user_x',
    ]);
  });

  it('does NOT re-append a message removed by an undo', () => {
    // The undone turn is still in the local list (and was present before the
    // fetch) but is no longer in the authoritative snapshot.
    const snapshot = [msg('a')];
    const live = [msg('a'), msg('undone')];
    expect(mergeSnapshotMessages(snapshot, live, ids('a', 'undone')).map((m) => m.id)).toEqual([
      'a',
    ]);
  });

  it('appends the whole live list when the snapshot is empty and all are new', () => {
    const live = [msg('x'), msg('y')];
    expect(mergeSnapshotMessages([], live, ids()).map((m) => m.id)).toEqual(['x', 'y']);
  });
});
