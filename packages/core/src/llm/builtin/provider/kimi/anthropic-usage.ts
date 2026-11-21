import type { TokenUsage } from '#/usage';

/**
 * Raw Anthropic wire usage.
 *
 * `input_tokens` and the cache fields are SIBLINGS, not a total-and-parts
 * relation: a real capture reads `{"input_tokens":11,…,"cache_read_input_tokens":1434}`,
 * where the cache read alone dwarfs `input_tokens`. Subtracting the cache
 * fields from `input_tokens` is therefore not "removing double counting" but a
 * misread of the wire, and it drives the fresh-input counter to 0 on every
 * cache-hit turn.
 */
export interface AnthropicRawUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

/**
 * The single reading rule for Anthropic usage, field-for-field identical to the
 * v2 engine's `parseRawUsage`
 * (`agent-core-v2/src/human/llm/requester/bases/anthropic/format.ts`): every
 * field is copied verbatim, with no subtraction. `packages/kosong/test/cache-field-parity.test.ts`
 * fails if the two copies ever disagree again.
 */
export function extractAnthropicUsage(usage: AnthropicRawUsage): TokenUsage {
  return {
    inputOther: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    inputCacheRead: usage.cache_read_input_tokens ?? 0,
    inputCacheCreation: usage.cache_creation_input_tokens ?? 0,
  };
}
