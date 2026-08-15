/**
 * `sessionQuery` domain — model text rendering for the `session_query` tool.
 *
 * Ported from deepseek-harness `tool-session-query/src/presentation.ts`
 * (MIT), trimmed to the three supported operations and without the upstream
 * surface tier.
 */

import type { SessionEventSearchHit, SessionSearchHit } from './events';
import type { SessionLineageNode, SessionLineageTrace } from './types';

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

export function formatEmptySessionSearch(): string {
  return 'No matching sessions found.';
}

/** Render a cross-session search page for the model. */
export function formatSessionSearch(items: readonly SessionSearchHit[], capped: boolean): string {
  if (items.length === 0) return formatEmptySessionSearch();
  const lines = [`Session search results (${items.length}):`];
  for (const [index, hit] of items.entries()) {
    const availability =
      [hit.live ? 'live' : undefined, hit.persisted ? 'persisted' : undefined]
        .filter((value): value is string => value !== undefined)
        .join(', ') || 'unavailable';
    lines.push(
      '',
      `${index + 1}. Session ${hit.id} — ${hit.cwd ?? '(no cwd)'}`,
      `   Created: ${formatTime(hit.createdAt)}`,
      `   Parent: ${hit.parentSessionId ?? 'root'}`,
      `   Availability: ${availability}`,
      `   Best match: seq ${hit.bestMatch.seq} | ${hit.bestMatch.type} | ${formatTime(hit.bestMatch.time)}`,
      `   Snippet: ${hit.bestMatch.snippet}`,
    );
  }
  if (capped) {
    lines.push(
      '',
      'Result cap reached. Narrow the query or add filters to find additional matches.',
    );
  }
  return lines.join('\n');
}

/** Render a within-session event search page for the model. */
export function formatEventSearch(
  sessionId: string,
  items: readonly SessionEventSearchHit[],
  capped: boolean,
): string {
  if (items.length === 0) return `No matching events in session ${sessionId}.`;
  const lines = [`Event search results for session ${sessionId} (${items.length}):`];
  for (const [index, hit] of items.entries()) {
    lines.push(
      '',
      `${index + 1}. seq ${hit.seq} | ${hit.type} | ${formatTime(hit.time)}`,
      `   Snippet: ${hit.snippet}`,
    );
  }
  if (capped) {
    lines.push(
      '',
      'Result cap reached. Narrow the query or add filters to find additional matches.',
    );
  }
  return lines.join('\n');
}

/** Render a lineage trace for the model. */
export function formatSessionTrace(trace: SessionLineageTrace): string {
  const lines = [`Session ${trace.target.id}:`];
  const ancestry = trace.ancestors.map((record) => record.id).toReversed();
  const chain = trace.complete
    ? [...ancestry, trace.root.id]
    : [...ancestry, trace.unresolvedParentId];
  const boundary = trace.complete ? 'complete' : 'incomplete';
  lines.push(`   Ancestors: ${chain.join(' → ')} (${boundary})`);
  lines.push(`   Descendants: ${formatDescendants(trace.descendants, 1)}`);
  return lines.join('\n');
}

function formatDescendants(nodes: readonly SessionLineageNode[], depth: number): string {
  if (nodes.length === 0) return '(none)';
  const parts: string[] = [];
  for (const node of nodes) {
    parts.push(
      `\n${'   '.repeat(depth)}${node.session.id}${node.descendants.length > 0 ? formatDescendants(node.descendants, depth + 1) : ''}`,
    );
  }
  return parts.join('');
}
