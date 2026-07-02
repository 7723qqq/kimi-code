/**
 * `llmProtocol.capability` — model-capability matrix.
 *
 * `ModelCapability` describes what a given model can accept and emit
 * (streaming, tool calls, thinking, media types, cache modes, etc.).
 * `UNKNOWN_CAPABILITY` is the sentinel value used when v2 can't statically
 * identify a model (e.g. user-configured custom endpoint); `isUnknownCapability`
 * is the corresponding predicate.
 *
 * v2 owns the type names; the concrete registry still lives in kosong for now
 * and is queried by `IModelResolver` during Model construction.
 */

export { isUnknownCapability, UNKNOWN_CAPABILITY } from '@moonshot-ai/kosong';
export type { ModelCapability } from '@moonshot-ai/kosong';
