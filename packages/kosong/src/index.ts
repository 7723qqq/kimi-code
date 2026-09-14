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

// Stream driver
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
