import type {
  ContentBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources/messages/messages.js';
import {
  applyCacheBreakpoints,
  CACHE_CONTROL,
  CACHEABLE_BLOCK_TYPES,
  type CacheBreakpointContent,
} from '@moonshot-ai/runtime-shared/cache-breakpoints';

/**
 * Cache-control breakpoint injection for the Anthropic Messages wire format.
 *
 * The rule itself lives in `@moonshot-ai/runtime-shared/cache-breakpoints`, so
 * this legacy provider and the v2 requester cannot drift. What stays here is
 * only the SDK-shaped adapter: `MessageParam.content` may be a plain string,
 * which has no blocks to mark.
 */

export { CACHE_CONTROL, CACHEABLE_BLOCK_TYPES };

export function injectCacheControlOnLastBlock(messages: MessageParam[]): void {
  applyCacheBreakpoints(messages.map((message) => contentOf(message)));
}

function contentOf(message: MessageParam): CacheBreakpointContent {
  const content: string | ContentBlockParam[] = message.content;
  if (!Array.isArray(content)) return undefined;
  return content as readonly ContentBlockParam[] as CacheBreakpointContent;
}
