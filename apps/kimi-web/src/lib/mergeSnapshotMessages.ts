// apps/kimi-web/src/lib/mergeSnapshotMessages.ts
import type { AppMessage } from '../api/types';

/**
 * Merge a freshly fetched session snapshot with the messages that arrived from
 * live events *while the snapshot was in flight*.
 *
 * `snapshot` is the authoritative server view up to `asOfSeq`; everything in it
 * is kept in server order. `live` is the current in-memory list. `beforeIds` is
 * the set of message ids that were already present *before* the fetch started.
 *
 * Only messages that are both **new since the fetch started** (not in
 * `beforeIds`) and **not already in the snapshot** are appended after the
 * snapshot. This preserves genuine in-flight live messages (so a resync does not
 * briefly drop them) without re-adding messages that are locally absent from the
 * snapshot for other reasons — e.g. optimistic user bubbles (which keep their
 * `msg_opt_*` id while the snapshot carries the daemon id) or turns removed by
 * an undo. Both of those are in `beforeIds`, so they are correctly dropped.
 *
 * Ordering relies on the caller: `snapshot` must be seq-ordered and every
 * appended message must sort after it. This holds on the sync path, where any
 * newly-arrived live message has `seq > asOfSeq`.
 */
export function mergeSnapshotMessages(
  snapshot: AppMessage[],
  live: AppMessage[],
  beforeIds: ReadonlySet<string>,
): AppMessage[] {
  if (live.length === 0) return snapshot;
  const snapshotIds = new Set(snapshot.map((m) => m.id));
  const tail = live.filter((m) => !beforeIds.has(m.id) && !snapshotIds.has(m.id));
  if (tail.length === 0) return snapshot;
  return [...snapshot, ...tail];
}
