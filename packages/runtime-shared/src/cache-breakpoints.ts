/**
 * Cache-control breakpoint placement for the Anthropic Messages wire format.
 *
 * The legacy kosong provider and the v2 requester both delegate here, so the
 * two copies that used to drift are gone. Placement assumes the wire history
 * grows by `historyGap` messages between consecutive requests: the assistant
 * reply plus one merged user turn. The stable breakpoint therefore sits
 * `historyGap + 1` messages back, which is exactly where the previous
 * request's tail breakpoint landed — the next request reads through it and
 * only writes the new delta. The extra message of margin keeps the stable
 * prefix alive when the tail message's content is retroactively merged (a
 * steering message appended to a user turn grows that message instead of
 * adding one).
 */

export const CACHE_CONTROL = { type: 'ephemeral' as const };

export const CACHEABLE_BLOCK_TYPES: readonly string[] = [
  'text',
  'image',
  'document',
  'search_result',
  'tool_use',
  'tool_result',
  'server_tool_use',
  'web_search_tool_result',
];

const CACHEABLE_TYPES: ReadonlySet<string> = new Set(CACHEABLE_BLOCK_TYPES);

export interface CacheBreakpointBlock {
  type: string;
  cache_control?: { type: 'ephemeral' } | null;
}

export type CacheBreakpointContent = readonly CacheBreakpointBlock[] | undefined;

export function applyCacheBreakpoints(
  contents: readonly CacheBreakpointContent[],
  historyGap = 2,
): void {
  const tail = contents.at(-1);
  if (tail !== undefined) markLastBlock(tail);
  if (contents.length < historyGap + 2) return;
  const stable = contents[contents.length - historyGap - 1];
  if (stable !== undefined) markLastBlock(stable, true);
}

function markLastBlock(content: readonly CacheBreakpointBlock[], keepExisting = false): void {
  const block = content.at(-1);
  if (block === undefined || !CACHEABLE_TYPES.has(block.type)) return;
  if (keepExisting && block.cache_control !== undefined) return;
  block.cache_control = CACHE_CONTROL;
}
