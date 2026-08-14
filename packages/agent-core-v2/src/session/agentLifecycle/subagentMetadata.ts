/**
 * `agentLifecycle` domain — persisted subagent relationship labels.
 *
 * Provides the label helpers that record and read the requester → subagent
 * relationship without making the flat lifecycle registry interpret parentage
 * itself.
 */

import type { AgentMeta } from '#/session/sessionMetadata/sessionMetadata';

/**
 * Delegation-depth ceiling for subagent chains (ported from
 * deepseek-harness `subagent`'s delegation-depth accounting, MIT). A parent
 * spawns a child at depth + 1; spawning at or beyond this cap is rejected so
 * a recursive delegation loop cannot nest without bound.
 */
export const MAX_SUBAGENT_DEPTH = 8;

const SUBAGENT_DEPTH_LABEL = 'subagentDepth';

export function subagentLabels(
  parentAgentId: string,
  options: { readonly swarmItem?: string; readonly depth?: number } = {},
): Readonly<Record<string, string>> {
  const labels: Record<string, string> = { parentAgentId };
  if (options.swarmItem !== undefined) {
    labels['swarmItem'] = options.swarmItem;
  }
  if (options.depth !== undefined) {
    labels[SUBAGENT_DEPTH_LABEL] = String(options.depth);
  }
  return labels;
}

export function labelsFromAgentMeta(
  meta: AgentMeta,
): Readonly<Record<string, string>> | undefined {
  const labels: Record<string, string> = { ...meta.labels };
  const parentAgentId = subagentParentAgentId(meta);
  if (parentAgentId !== undefined) {
    labels['parentAgentId'] = parentAgentId;
  }
  const swarmItem = subagentSwarmItem(meta);
  if (swarmItem !== undefined) {
    labels['swarmItem'] = swarmItem;
  }
  return Object.keys(labels).length > 0 ? labels : undefined;
}

export function isSubagentMeta(meta: AgentMeta | undefined): boolean {
  if (meta === undefined) return false;
  if (subagentParentAgentId(meta) !== undefined) return true;
  return meta.type === 'sub';
}

export function subagentParentAgentId(meta: AgentMeta | undefined): string | undefined {
  if (meta === undefined) return undefined;
  return firstNonEmpty(meta.labels?.['parentAgentId'], meta.parentAgentId ?? undefined);
}

export function subagentSwarmItem(meta: AgentMeta | undefined): string | undefined {
  if (meta === undefined) return undefined;
  return firstNonEmpty(meta.labels?.['swarmItem'], meta.swarmItem);
}

/**
 * Read an agent's delegation depth from its persisted metadata, treating
 * absence (and malformed values) as top-level depth zero. The persisted
 * label is authoritative and monotone: a resumed child keeps its depth
 * instead of counting from zero as if it were top-level.
 */
export function subagentDepthOf(meta: AgentMeta | undefined): number {
  if (meta === undefined) return 0;
  const raw = meta.labels?.[SUBAGENT_DEPTH_LABEL];
  if (raw === undefined) return 0;
  const depth = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(depth) || depth < 0) return 0;
  return depth;
}

function firstNonEmpty(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0);
}
