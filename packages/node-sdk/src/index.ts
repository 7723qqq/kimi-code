export { KimiHarness } from '#/kimi-harness';
export type { KimiHarnessRuntimeOptions } from '#/kimi-harness';
export { Session } from '#/session';
export { KimiAuthFacade } from '#/auth';
export { createKimiHarness, createKimiHarnessV2, SDKRpcClientV2 } from '#/sdk-rpc-client-v2';
export type { SDKRpcClientV2Options } from '#/sdk-rpc-client-v2';
export {
  createKimiConfigRpc,
  KimiConfigRpcClient,
  type KimiConfigRpc,
  type KimiConfigValidationIssue,
  type KimiConfigValidationPathSegment,
  type ResolveKimiConfigPathInput,
  type ValidateKimiConfigTomlInput,
} from '#/config-rpc';
export { SDKRpcClientBase } from '#/rpc';
export { KimiForCodingProvider } from '#/kimi-code-model-provider';
export type { KimiForCodingProviderOptions } from '#/kimi-code-model-provider';
export { removeProviderFromConfig } from '#/v2/config-mapper';

export {
  applyCatalogProvider,
  catalogBaseUrl,
  catalogModelToAlias,
  catalogProviderModels,
  CatalogFetchError,
  DEFAULT_CATALOG_URL,
  fetchCatalog,
  inferWireType,
  loadBuiltInCatalog,
  resolveCatalogImport,
} from '#/catalog';
export type {
  ApplyCatalogProviderOptions,
  Catalog,
  CatalogImportInvalidReason,
  CatalogImportResolution,
  CatalogModel,
  CatalogProviderEntry,
  FetchCatalogOptions,
} from '#/catalog';

// Locale — forwarded from kimi-i18n so hosts never import the i18n package directly.
export { setLocale, getLocale } from '@moonshot-ai/kimi-i18n';
export type { Locale } from '@moonshot-ai/kimi-i18n';

// Error primitives — localized legacy copies (see #/legacy) so the SDK keeps
// its public `KimiError` / `ErrorCodes` contract without importing agent-core.
export {
  ErrorCodes,
  KimiError,
  type KimiErrorCode,
  type KimiErrorInfo,
  type KimiErrorOptions,
  type KimiErrorPayload,
  KIMI_ERROR_INFO,
  fromKimiErrorPayload,
  isKimiError,
  resolveErrorTitle,
  toKimiErrorPayload,
} from '#/legacy';

// Diagnostic logging — public surface only. The implementation is a localized
// port (see #/legacy/logging); `resolveGlobalLogPath` / `resolveLoggingConfig`
// come from the v2 engine's log config (identical shape and values).
export {
  flushDiagnosticLogs,
  flushDiagnosticLogsSync,
  log,
  levelEnabled,
  LOG_LEVEL_RANK,
} from '#/legacy';
export type { LogContext, LogLevel, LogPayload, Logger } from '#/legacy';
export { resolveGlobalLogPath, resolveLoggingConfig } from '@moonshot-ai/agent-core-v2';
export { resolveKimiHome, resolveConfigPath } from '#/config-local';

// Host-side config helpers — the localized v1 config-document layer (see
// #/config-local), used by hosts (e.g. the CLI's server telemetry bootstrap)
// that need to inspect config without spinning up a full engine.
export {
  loadRuntimeConfigSafe,
  readConfigFile,
  readConfigFileForUpdate,
  writeConfigFile,
  type RuntimeConfigLoadResult,
} from '#/config-local';
export { effectiveModelAlias, effectiveModelAliases } from '#/legacy';
export { limitAgentReplayByTurns } from '#/legacy';
export { parseAgentFileText, resolveAgentPath } from '@moonshot-ai/agent-core-v2';
// The synthesized `[models]` alias a `[secondary_model]` recipe with patch
// fields materializes at runtime — hosts filter it out of model pickers.
export { SECONDARY_DERIVED_MODEL_ALIAS } from '#/config-local';

// Process-wide HTTP proxy bootstrap — installed once at CLI startup so all
// outbound fetch honors HTTP_PROXY / HTTPS_PROXY / NO_PROXY.
export { installGlobalProxyDispatcher } from '@moonshot-ai/agent-core-v2/_base/utils/proxy';

// Image compression — ingestion sites (e.g. the CLI's clipboard paste, the ACP
// adapter) shrink oversized images while constructing the content part, before
// it enters a prompt. Best effort: returns the original on any failure.
// Compression is never silent: buildImageCompressionCaption renders the note
// placed next to a compressed image, and persistOriginalImage keeps the
// pre-compression bytes readable (ReadMediaFile + region) for detail.
export {
  buildImageCompressionCaption,
  buildUnsupportedImageNotice,
  compressImageForModel,
  compressBase64ForModel,
  compressImageContentParts,
  cropImageForModel,
  gateImageFormatParts,
  isModelAcceptedImageMime,
  normalizeImageMime,
  parseImageDataUrl,
  persistOriginalImage,
  sessionMediaOriginalsDir,
  IMAGE_BYTE_BUDGET,
  MAX_IMAGE_EDGE_PX,
} from '@moonshot-ai/agent-core-v2';
export { ImageLimits } from '@moonshot-ai/agent-core-v2';
export type {
  CompressImageOptions,
  CompressImageResult,
  CompressBase64Result,
  ImageCompressionCaptionInput,
  ImageCompressionTelemetry,
} from '@moonshot-ai/agent-core-v2';

// Experimental feature flags — types only. Resolved values come from
// `KimiHarness.getExperimentalFeatures()` over RPC, not from a re-exported runtime value.
export type {
  ExperimentalFeatureState,
  ExperimentalFlagMap,
  ExperimentalFlagSource,
} from '@moonshot-ai/agent-core-v2';

export type {
  KimiAuthCompleteFeedbackUploadInput,
  KimiAuthCompleteFeedbackUploadPart,
  KimiAuthCreateFeedbackUploadUrlInput,
  KimiAuthCreateFeedbackUploadUrlOk,
  KimiAuthCreateFeedbackUploadUrlResult,
  KimiAuthFeedbackUploadPart,
  KimiAuthLoginResult,
  KimiAuthLogoutResult,
  KimiAuthSubmitFeedbackInput,
} from '#/auth';

export * from '#/events';
export type * from '#/types';
