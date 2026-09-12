export { KimiHarness } from '#/kimi-harness';
export type { KimiHarnessRuntimeOptions } from '#/kimi-harness';
export { Session } from '#/session';
export { KimiAuthFacade } from '#/auth';
export { createKimiHarness, createKimiHarnessV2, SDKRpcClientV2 } from '#/sdk-rpc-client-v2';
export type { SDKRpcClientV2Options } from '#/sdk-rpc-client-v2';
export { createKimiHarnessNative, SDKRpcClientNative } from '#/native/sdk-rpc-client-native';
export type { SDKRpcClientNativeOptions } from '#/native/sdk-rpc-client-native';
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
export { ImageLimits } from '#/image-limits';
export { KimiForCodingProvider } from '#/kimi-code-model-provider';
export type { KimiForCodingProviderOptions } from '#/kimi-code-model-provider';
export { removeProviderFromConfig } from '#/v2/config-mapper';
export { validateConfig } from '#/config-local';

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

// Error primitives.
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
} from '#/error-protocol';

// Diagnostic logging — public surface only.
export {
  flushDiagnosticLogs,
  flushDiagnosticLogsSync,
  log,
  levelEnabled,
  LOG_LEVEL_RANK,
} from '#/logging';
export type { LogContext, LogLevel, LogPayload, Logger } from '#/logging';
export { resolveGlobalLogPath, resolveLoggingConfig } from '#/logging';
export {
  buildDaemonFileUrl,
  buildMediaPathTag,
  isDaemonFileUrl,
  parseDaemonFileUrl,
} from '#/media/mediaRef';
export { resolveKimiHome, resolveConfigPath } from '#/config-local';

// Host-side config → engine-param resolvers (env > config precedence, see
// #/native/native-llm-resolver). Shared so every host that builds engine
// session params resolves the knobs identically.
export {
  resolveSubagentTimeoutMs,
  resolveSwarmTimeoutMs,
  resolveMaxAttemptsPerStep,
  resolveMaxStepsPerTurn,
  resolveThinkingKeep,
  resolveImageReadByteBudget,
  resolveImageMaxEdgePx,
  resolveImageLimits,
  resolveBackgroundLimits,
  type BackgroundLimits,
  resolvePrintBackground,
  type PrintBackgroundSettings,
  PRINT_WAIT_CEILING_S_DEFAULT,
  resolveModelCapabilities,
  resolveWebSearchService,
  resolveWebFetchService,
  type WebServiceConfig,
} from '#/native/native-llm-resolver';

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
export { effectiveModelAlias, effectiveModelAliases } from '#/model-alias';
export { limitAgentReplayByTurns } from '#/config-helpers';
export { parseAgentFileText, resolveAgentPath, type AgentFileDefinition } from '#/agent-file';
// The synthesized `[models]` alias a `[secondary_model]` recipe with patch
// fields materializes at runtime — hosts filter it out of model pickers.
export { SECONDARY_DERIVED_MODEL_ALIAS } from '#/config-local';
export const PRIMARY_SUBAGENT_MODEL_CHOICE = 'primary';

// Process-wide HTTP proxy bootstrap — installed once at CLI startup so all
// outbound fetch honors HTTP_PROXY / HTTPS_PROXY / NO_PROXY.
export { installGlobalProxyDispatcher } from '#/proxy';

// Image compression — ingestion sites (e.g. the CLI's clipboard paste, the ACP
// adapter) shrink oversized images while constructing the content part, before
// it enters a prompt. Best effort: returns the original on any failure.
// Compression is never silent: buildImageCompressionCaption renders the note
// placed next to a compressed image, and persistOriginalImage keeps the
// pre-compression bytes readable (Read + region) for detail.
export {
  buildImageCompressionCaption,
  buildUnsupportedImageNotice,
  compressImageForModel,
  compressBase64ForModel,
  gateImageFormatParts,
  isModelAcceptedImageMime,
  normalizeImageMime,
  parseImageDataUrl,
  persistOriginalImage,
  sessionMediaOriginalsDir,
  IMAGE_BYTE_BUDGET,
  MAX_IMAGE_EDGE_PX,
} from '#/media';
export type {
  ImageCompressionTelemetry,
  StrictPropertyCheck,
  TelemetryEventName,
  TelemetryEventPayload,
  ExperimentalFeatureState,
  ExperimentalFlagMap,
  ExperimentalFlagSource,
} from '#/types';

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
export * from '#/marketplace';
export type * from '#/types';
