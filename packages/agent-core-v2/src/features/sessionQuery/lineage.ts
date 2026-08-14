/**
 * `sessionQuery` domain — lineage tracing over a logical corpus.
 *
 * Builds the parent→children map from `parentSessionId` records and walks it
 * for one target: the ancestor chain outward from the immediate parent, and
 * the complete descendant trees rooted at the target's direct children. A
 * parent id missing from the corpus terminates the ancestor walk with
 * `complete: false`.
 *
 * Ported from deepseek-harness `session-query` lineage semantics (MIT).
 */

import type { SessionLineageNode, SessionLineageTrace, SessionRecord } from './types';

/**
 * Trace one session's known ancestry and complete descendant trees.
 * @param records - the detached logical corpus (every record once).
 * @param targetId - session to trace.
 * @returns the trace; the target itself must be present in `records`.
 */
export function traceLineage(
  records: readonly SessionRecord[],
  targetId: string,
): SessionLineageTrace {
  const byId = new Map(records.map((record) => [record.id, record]));
  const target = byId.get(targetId);
  if (target === undefined) {
    throw new Error(`session "${targetId}" not found in the logical corpus`);
  }

  const ancestors: SessionRecord[] = [];
  let cursor = target.parentSessionId;
  let complete = true;
  let unresolvedParentId: string | undefined;
  while (cursor !== undefined && cursor !== null) {
    const parent = byId.get(cursor);
    if (parent === undefined) {
      complete = false;
      unresolvedParentId = cursor;
      break;
    }
    ancestors.push(parent);
    cursor = parent.parentSessionId;
  }

  const children = new Map<string, SessionRecord[]>();
  for (const record of records) {
    if (record.parentSessionId === undefined || record.parentSessionId === null) continue;
    const list = children.get(record.parentSessionId);
    if (list === undefined) {
      children.set(record.parentSessionId, [record]);
    } else {
      list.push(record);
    }
  }

  const descendants = buildDescendants(children, targetId);

  if (complete) {
    return {
      target,
      ancestors,
      descendants,
      complete: true,
      root: ancestors.at(-1) ?? target,
    };
  }
  return {
    target,
    ancestors,
    descendants,
    complete: false,
    unresolvedParentId: unresolvedParentId as string,
  };
}

function buildDescendants(
  children: ReadonlyMap<string, SessionRecord[]>,
  parentId: string,
): SessionLineageNode[] {
  const direct = children.get(parentId) ?? [];
  return direct.map((child) => ({
    session: child,
    descendants: buildDescendants(children, child.id),
  }));
}
