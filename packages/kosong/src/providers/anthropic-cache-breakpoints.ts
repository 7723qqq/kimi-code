import type {
  ContentBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources/messages/messages.js';

/**
 * Cache-control breakpoint injection for the Anthropic Messages wire format.
 *
 * SHARED SINGLE SOURCE OF TRUTH: this module is imported by both the kosong
 * provider layer (`packages/kosong/src/providers/anthropic.ts`) and
 * agent-core-v2's vendored provider layer
 * (`packages/agent-core-v2/src/kosong/provider/bases/anthropic/anthropic.ts`).
 * Do NOT re-declare `CACHE_CONTROL` / `CACHEABLE_TYPES` /
 * `injectCacheControlOnLastBlock` in either caller — import them from here so
 * the breakpoint strategy can never drift between the two copies.
 */

export const CACHE_CONTROL = { type: 'ephemeral' as const };

export type CacheableBlock = ContentBlockParam & { cache_control?: { type: 'ephemeral' } };

/**
 * Content block types that support cache_control injection.
 */
export const CACHEABLE_TYPES = new Set([
  'text',
  'image',
  'document',
  'search_result',
  'tool_use',
  'tool_result',
  'server_tool_use',
  'web_search_tool_result',
]);

export function injectCacheControlOnLastBlock(messages: MessageParam[]): void {
  if (messages.length === 0) return;

  // Inject on the last message's last block (the "tail" breakpoint).
  const lastMessage = messages.at(-1);
  if (lastMessage !== undefined) {
    const content = lastMessage.content;
    if (Array.isArray(content) && content.length > 0) {
      const lastBlock = content.at(-1) as CacheableBlock | undefined;
      if (lastBlock !== undefined && CACHEABLE_TYPES.has(lastBlock.type)) {
        lastBlock.cache_control = CACHE_CONTROL;
      }
    }
  }

  // Inject on a stable "history" breakpoint: the last block of a message that
  // is NOT one of the last 2 messages. This creates a cache prefix covering
  // the stable conversation history, so when new messages are appended at the
  // end, the cache can still hit on the prefix — only the new tail is
  // processed fresh. Combined with the system and tool breakpoints this uses
  // all 4 Anthropic cache_control slots (system + tools + history + tail).
  if (messages.length >= 4) {
    const stableIndex = messages.length - 3;
    const stableMessage = messages[stableIndex];
    if (stableMessage !== undefined) {
      const content = stableMessage.content;
      if (Array.isArray(content) && content.length > 0) {
        const stableBlock = content.at(-1) as CacheableBlock | undefined;
        if (
          stableBlock !== undefined &&
          CACHEABLE_TYPES.has(stableBlock.type) &&
          stableBlock.cache_control === undefined
        ) {
          stableBlock.cache_control = CACHE_CONTROL;
        }
      }
    }
  }
}
