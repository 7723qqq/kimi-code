// apps/kimi-web/src/lib/mergeSnapshotMessages.ts
import type { AppMessage } from '../api/types';

/**
 * Merge a freshly fetched session snapshot with the messages that may have been
 * appended by live events while the snapshot was in flight.
 *
 * `snapshot` is the authoritative server view up to `asOfSeq`; everything in it
 * is kept in server order. `live` is the current in-memory list, which can
 * contain messages with `seq > asOfSeq` that arrived during the fetch — those
 * are appended (deduped by id) after the snapshot so they are not lost when the
 * snapshot replaces the in-memory list.
 *
 * Ordering relies on the caller: `snapshot` must be seq-ordered and every
 * live-only message must sort after it. This holds on the sync path, where any
 * live-only message has `seq > asOfSeq`.
 */
export function mergeSnapshotMessages(snapshot: AppMessage[], live: AppMessage[]): AppMessage[] {
  if (live.length === 0) return snapshot;
  const snapshotIds = new Set(snapshot.map((m) => m.id));
  const tail = live.filter((m) => !snapshotIds.has(m.id));
  if (tail.length === 0) return snapshot;
  return [...snapshot, ...tail];
}
