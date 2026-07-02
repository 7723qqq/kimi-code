/**
 * `llmProtocol.usage` — token usage accounting surface.
 *
 * `TokenUsage` is the four-field accumulator (`inputOther | output |
 * inputCacheRead | inputCacheCreation`). Helpers: `emptyUsage` (zero value),
 * `addUsage` (fold two usages), `grandTotal` / `inputTotal` (roll-ups).
 * v2 owns this surface so usage-accounting code across domains no longer
 * touches kosong directly.
 */

export { addUsage, emptyUsage, grandTotal, inputTotal } from '@moonshot-ai/kosong';
export type { TokenUsage } from '@moonshot-ai/kosong';
