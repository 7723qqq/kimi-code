// Message types
export {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  extractText,
  isContentPart,
  isToolCall,
  isToolCallPart,
  mergeInPlace,
} from './message';
export type {
  AudioURLPart,
  ContentPart,
  ImageURLPart,
  Message,
  Role,
  StreamedMessagePart,
  TextPart,
  ThinkPart,
  ToolCall,
  ToolCallPart,
  VideoURLPart,
} from './message';

// Provider interfaces
export * from './provider';
/**
 * @deprecated The engine (agent-core-v2) composes providers through its
 * protocol-adapter registry instead of this factory; kept for the standalone
 * provider surface and tests.
 */
export { createProvider, getModelCapability } from './providers';
export type { ProviderConfig, ProviderType } from './providers';
/**
 * @deprecated Legacy standalone Kimi provider class. The engine
 * (agent-core-v2) uses the trait-composed providers built from the shared
 * kosong contract layer; kept for the standalone `createProvider` surface.
 */
export { KimiChatProvider } from './providers/kimi';
export type { ExtraBody, GenerationKwargs, KimiOptions, ThinkingConfig } from './providers/kimi';
/**
 * @deprecated Import from `@moonshot-ai/kosong/providers/kimi-errors` instead
 * (the engine consumes the subpath).
 */
export { classifyKimiQuotaError } from './providers/kimi-errors';

// Model capability matrix
export { UNKNOWN_CAPABILITY } from './capability';
/**
 * @deprecated Kept for tests; `UNKNOWN_CAPABILITY` identity checks are the
 * supported way to detect the unknown marker.
 */
export { isUnknownCapability } from './capability';
export type { ModelCapability } from './capability';

// Astron (xunfei coding plan) model definitions
export {
  ASTRON_DEFAULT_BASE_URL,
  ASTRON_MODEL_DEFS,
  ASTRON_PROVIDER_KEY,
  ASTRON_REASONING_EFFORT_MODEL_IDS,
} from './providers/astron-models';
export type { AstronModelDef } from './providers/astron-models';

// Model catalog (models.dev-style) metadata
export {
  catalogBaseUrl,
  catalogModelToCapability,
  catalogProviderModels,
  inferWireType,
  resolveCatalogImport,
} from './catalog';
export type {
  Catalog,
  CatalogModel,
  CatalogModelEntry,
  CatalogProviderEntry,
  CatalogImportInvalidReason,
  CatalogImportResolution,
} from './catalog';

// HTTP client
/**
 * @deprecated No production consumer; the engine and node-sdk use their own
 * HTTP layers. Kept for the standalone provider surface and tests.
 */
export { createSharedAgent, createSharedFetch, loadSystemCAs } from './http/undici-agent';
export { generate } from './generate';
export type { GenerateCallbacks, GenerateResult } from './generate';

// Tool wire schema
export type { Tool } from './tool';

// Token usage
export { addUsage, emptyUsage, grandTotal, inputTotal } from './usage';
export type { TokenUsage } from './usage';

// Errors
export {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderOverloadedError,
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIRequestTooLargeError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  VideoUploadUnsupportedError,
  classifyApiError,
  classifyBaseApiError,
  createAbortError,
  isAbortError,
  isContextOverflowErrorCode,
  isContextOverflowStatusError,
  isImageFormatError,
  isProviderOverloadStatusError,
  isProviderRateLimitError,
  isRecoverableRequestStructureError,
  isRequestTooLargeStatusError,
  isRetryableGenerateError,
  isToolExchangeAdjacencyError,
  normalizeAPIStatusError,
  parseRetryAfterMs,
  parseTraceId,
  sanitizeStatusErrorMessage,
  throwIfAbortError,
} from './errors';

/**
 * Concrete provider adapters stay off the root barrel because their SDK type
 * graphs pollute downstream declaration bundles. Import them from subpaths:
 * `@moonshot-ai/kosong/providers/kimi`,
 * `@moonshot-ai/kosong/providers/openai-legacy`, etc.
 */
