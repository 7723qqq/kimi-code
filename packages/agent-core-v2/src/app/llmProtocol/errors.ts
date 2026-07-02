/**
 * `llmProtocol.errors` — LLM-request error surface.
 *
 * `ChatProviderError` is the common base for all wire-level failures.
 * Concrete subclasses: `APIConnectionError`, `APIStatusError`,
 * `APIContextOverflowError`, `APIEmptyResponseError`, `APITimeoutError`,
 * `APIProviderRateLimitError`.
 *
 * Predicates: `isRetryableGenerateError` (whether the loop should retry),
 * `isContextOverflowStatusError` (context-overflow signal that should trigger
 * compaction), `isProviderRateLimitError` (provider-side rate limit hit).
 *
 * Owned by v2 so downstream `instanceof` checks and predicate calls don't
 * cross the kosong boundary.
 */

export {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderRateLimitError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  isContextOverflowStatusError,
  isProviderRateLimitError,
  isRetryableGenerateError,
} from '@moonshot-ai/kosong';
