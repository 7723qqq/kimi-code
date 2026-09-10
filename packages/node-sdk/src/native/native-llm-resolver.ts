import { existsSync } from 'node:fs';

import type { KimiConfig } from '#/config-local';
import { ErrorCodes, KimiError } from '#/error-protocol';

// The engine's transports own these headers (openai/anthropic auth, the
// anthropic-version pin, the google api-key); reqwest appends rather than
// replaces, so a user customHeader with one of these names would ship a second
// value and break the credential. Mirrors rust-engine.ts's AUTH_HEADERS — the
// two native-LLM resolvers must agree, or the same provider resolves to
// different headers depending on which entry point built the session.
const AUTH_HEADERS = new Set(['authorization', 'x-api-key', 'anthropic-version', 'x-goog-api-key']);

export interface JsNativeLlmConfig {
  protocol: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  customHeaders?: Record<string, string>;
  reasoningEffort?: string;
  thinkingBudget?: number;
  /** OAuth-managed auth: the transport fetches bearer tokens via `host/auth_token`. */
  authProvider?: string;
  /**
   * Moonshot preserved-thinking passthrough (`thinking.keep`): sent as
   * `thinking.keep` on the kimi/openai body and as a `clear_thinking_20251015`
   * context-management edit on anthropic. Only carried while thinking is on.
   */
  thinkingKeep?: string;
}

export interface PolicySnapshotDto {
  mode: 'manual' | 'auto' | 'yolo' | 'plan';
  deny_rules: string[];
  ask_rules: string[];
  allow_rules: string[];
  session_approvals: string[];
  git_cwd?: string;
  /** The user's global `[tools]` switch, enforced engine-side. */
  tools_filter?: { enabled: string[]; disabled: string[] };
  pre_tool_hooks: Array<{
    event: string;
    matcher: string;
    command: string;
    timeout?: number;
    cwd?: string;
    env?: Record<string, string>;
  }>;
}

export function normalizeBaseUrl(protocol: string, baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  if (protocol === 'google' || protocol === 'google-genai' || protocol === 'gemini') {
    return trimmed;
  }
  if (protocol === 'openai' || protocol === 'openai_responses' || protocol === 'openai-responses') {
    return /\/v\d+($|\/)/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  }
  return /\/v\d+($|\/)/.test(trimmed) || /^https?:\/\/[^/]+$/.test(trimmed)
    ? trimmed
    : `${trimmed}/v1`;
}

export function resolveNativeLlm(config: KimiConfig): JsNativeLlmConfig | undefined {
  const defaultModelAlias = config.defaultModel;
  return defaultModelAlias === undefined
    ? undefined
    : resolveNativeLlmForAlias(config, defaultModelAlias);
}

/**
 * Resolve one `[models]` alias into a native transport config — the shared
 * path for the session's own model and every `[secondary_model]` pool entry.
 * `effortOverride` is the pool section's `default_effort`, which outranks the
 * bound entry's own `default_effort` but not an explicit `thinking.enabled =
 * false` (v2 `resolveSubagentThinking`).
 */
export function resolveNativeLlmForAlias(
  config: KimiConfig,
  alias: string,
  effortOverride?: string,
): JsNativeLlmConfig | undefined {
  const modelConfig = config.models?.[alias];
  const providerName = modelConfig?.provider ?? config.agent?.nativeLlmProvider;
  if (!providerName) return undefined;

  const provider = config.providers?.[providerName];
  if (!provider || !provider.baseUrl) return undefined;

  const typeStr = String(provider.type ?? '');
  const protocol =
    typeStr === 'anthropic'
      ? 'anthropic'
      : typeStr === 'google' || typeStr === 'gemini' || typeStr === 'google-genai'
        ? 'google'
        : typeStr === 'openai_responses' || typeStr === 'openai-responses'
          ? 'openai_responses'
          : typeStr === 'openai' || typeStr === 'kimi'
            ? 'openai'
            : undefined;
  if (!protocol) return undefined;

  // Static key or OAuth-managed auth (managed logins write `oauth` with an
  // empty `apiKey`); a provider with neither cannot authenticate natively.
  const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey : '';
  const hasOAuth = provider.oauth !== undefined;
  if (apiKey.length === 0 && !hasOAuth) return undefined;

  let model = modelConfig?.model ?? provider.defaultModel;
  if (!model && config.models) {
    const aliasEntry = Object.entries(config.models).find(
      ([, entry]) => entry.provider === providerName,
    );
    if (aliasEntry) model = aliasEntry[1].model;
  }
  if (!model) return undefined;

  const customHeaders = Object.fromEntries(
    Object.entries(provider.customHeaders ?? {}).filter(
      ([key]) => !AUTH_HEADERS.has(key.toLowerCase()),
    ),
  );

  let reasoningEffort: string | undefined;
  let thinkingBudget: number | undefined;

  const thinkingConfig = config.thinking;
  const modelEffort = effortOverride ?? modelConfig?.defaultEffort ?? thinkingConfig?.effort;

  if (
    thinkingConfig?.enabled !== false &&
    modelEffort &&
    modelEffort !== 'off' &&
    modelEffort !== 'none'
  ) {
    if (protocol === 'anthropic') {
      // Mirror rust-engine.ts exactly: high/on → 32000, an explicit numeric
      // effort is used verbatim, anything else falls back to 32000. The old
      // 16384/32768 split silently halved the high-tier reasoning budget versus
      // the CLI's own resolver.
      if (modelEffort === 'low') thinkingBudget = 1024;
      else if (modelEffort === 'medium') thinkingBudget = 4096;
      else if (modelEffort === 'high' || modelEffort === 'on') thinkingBudget = 32000;
      else {
        const parsed = Number.parseInt(modelEffort, 10);
        thinkingBudget = !Number.isNaN(parsed) && parsed > 0 ? parsed : 32000;
      }
    } else {
      reasoningEffort = modelEffort;
    }
  }

  return {
    protocol,
    baseUrl: normalizeBaseUrl(protocol, provider.baseUrl),
    apiKey,
    model,
    maxTokens: modelConfig?.maxOutputSize ?? provider.maxTokens,
    customHeaders: Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
    reasoningEffort,
    thinkingBudget,
    authProvider: hasOAuth ? providerName : undefined,
    thinkingKeep: resolveThinkingKeep(config),
  };
}

export function buildPolicySnapshot(config: KimiConfig, workDir: string): PolicySnapshotDto {
  const mode = (config.yolo === true ? 'yolo' : (config.defaultPermissionMode ?? 'manual')) as
    | 'manual'
    | 'auto'
    | 'yolo'
    | 'plan';
  const rules = config.permission?.rules ?? [];
  const hooks = config.hooks ?? [];
  const tools = config.tools;
  const toolsFilter =
    tools === undefined || (tools.enabled === undefined && tools.disabled === undefined)
      ? undefined
      : { enabled: tools.enabled ?? [], disabled: tools.disabled ?? [] };

  return {
    mode,
    deny_rules: rules
      .filter((r) => r.decision === 'deny' && typeof r.pattern === 'string')
      .map((r) => r.pattern),
    ask_rules: rules
      .filter((r) => r.decision === 'ask' && typeof r.pattern === 'string')
      .map((r) => r.pattern),
    allow_rules: rules
      .filter((r) => r.decision === 'allow' && typeof r.pattern === 'string')
      .map((r) => r.pattern),
    session_approvals: [],
    git_cwd: workDir,
    tools_filter: toolsFilter,
    pre_tool_hooks: hooks
      .filter((h) => typeof h.command === 'string')
      .map((h) => ({
        event: h.event ?? '',
        matcher: h.matcher ?? '',
        command: h.command ?? '',
        timeout: h.timeout,
        cwd: h.cwd,
        env: h.env,
      })),
  };
}

export function resolveGithubCredentials(config: KimiConfig): {
  githubToken?: string;
  githubBaseUrl?: string;
} {
  return {
    githubToken: config.github?.token ?? process.env['GITHUB_TOKEN'],
    githubBaseUrl: config.github?.baseUrl,
  };
}

/** The reserved alias that always binds the caller's own model. */
export const PRIMARY_SUBAGENT_MODEL_CHOICE = 'primary';

/** One `[secondary_model.models]` pool entry in the engine's wire shape. */
export interface SecondaryModelEntryWire {
  alias: string;
  hint: string;
  llm: Record<string, unknown>;
}

/** The `[secondary_model]` pool in the engine's wire shape. */
export interface SecondaryModelPoolWire {
  force: boolean;
  defaultModel: string;
  callerModelAlias?: string;
  models: SecondaryModelEntryWire[];
}

/** The engine reads snake_case `NativeLlmConfig`; the JS view is camelCase. */
function nativeLlmWire(config: JsNativeLlmConfig): Record<string, unknown> {
  return {
    protocol: config.protocol,
    base_url: config.baseUrl,
    api_key: config.apiKey,
    model: config.model,
    max_tokens: config.maxTokens,
    custom_headers: config.customHeaders,
    reasoning_effort: config.reasoningEffort,
    thinking_budget: config.thinkingBudget,
    auth_provider: config.authProvider,
    thinking_keep: config.thinkingKeep,
  };
}

/**
 * Resolve `[secondary_model]` into the engine's subagent model pool (v2
 * `resolveSubagentModelPool` + `assertValidSubagentModelConfig`).
 *
 * Returns `undefined` when the feature is disabled or the section configures
 * no pool. A malformed section throws `config.invalid` naming the offending
 * entry, so the session fails loudly at startup instead of silently ignoring
 * the user's configuration. `KIMI_SECONDARY_MODEL` / `KIMI_SECONDARY_EFFORT`
 * override the recipe in memory only, matching the config-local overlay.
 */
export function resolveSecondaryModelPool(
  config: KimiConfig,
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): SecondaryModelPoolWire | undefined {
  if (!enabled) return undefined;
  const section = config.secondaryModel;
  if (section === undefined) return undefined;

  const envModel = nonBlank(env['KIMI_SECONDARY_MODEL']);
  const envEffort = nonBlank(env['KIMI_SECONDARY_EFFORT']);
  const defaultModel = envModel ?? section.defaultModel ?? section.model;
  const defaultEffort = envEffort ?? section.defaultEffort;
  const force = section.force === true;
  const table = section.models;
  const hints = new Map<string, string>();

  // `force` only pins the choice the pool table would offer; the two keys are
  // mutually exclusive and force still needs something to bind (v2
  // `assertValidSubagentModelConfig`'s ordering: force checks first).
  if (force && table !== undefined) {
    throw invalidConfig(
      '[secondary_model].force cannot be combined with [secondary_model.models]: the pool table only exists to offer the main agent a choice, and force removes that choice',
    );
  }
  if (table === undefined) {
    if (defaultModel === undefined) {
      if (force) {
        throw invalidConfig(
          '[secondary_model].default_model is required when [secondary_model].force is set',
        );
      }
      // A section with no pool keys (patch-only recipe) stays inert.
      return undefined;
    }
    hints.set(defaultModel, '');
  } else {
    for (const [alias, hint] of Object.entries(table)) hints.set(alias, hint ?? '');
    if (defaultModel === undefined) {
      throw invalidConfig(
        '[secondary_model].default_model is required when [secondary_model.models] is configured',
      );
    }
    if (!hints.has(defaultModel)) {
      throw invalidConfig(
        `[secondary_model].default_model "${defaultModel}" is not a [secondary_model.models] key. Available models: ${[...hints.keys()].join(', ')}.`,
      );
    }
  }
  if (hints.has(PRIMARY_SUBAGENT_MODEL_CHOICE)) {
    throw invalidConfig(
      `[secondary_model.models] key "${PRIMARY_SUBAGENT_MODEL_CHOICE}" is reserved: it always binds the caller's own model. Rename the pool entry.`,
    );
  }

  const models = [...hints.entries()].map(([alias, hint]) => {
    const llm = resolveNativeLlmForAlias(config, alias, defaultEffort);
    if (llm === undefined) {
      throw invalidConfig(
        `[secondary_model.models] entry "${alias}" could not be resolved: add it to [models] with a provider that has credentials.`,
      );
    }
    return { alias, hint, llm: nativeLlmWire(llm) };
  });

  return {
    force,
    defaultModel,
    callerModelAlias: config.defaultModel,
    models,
  };
}

function invalidConfig(message: string): KimiError {
  return new KimiError(ErrorCodes.CONFIG_INVALID, message);
}

// ── Config → engine-param resolvers (Wave 2) ───────────────────────────────
// Precedence per value: environment variable > owning config section, matching
// the documented config contract (config-files.md). Invalid values are
// ignored so a bad entry degrades to the next source instead of failing the
// session. The config params are structural subsets so every host that
// resolves engine session params (the SDK's own buildHandle, the CLI's
// rust-engine adapter) shares one implementation.

function positiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Per-subagent (`Agent`) timeout in ms; `0` = no timeout. */
export function resolveSubagentTimeoutMs(config: {
  subagent?: { timeoutMs?: number };
}): number | undefined {
  return nonNegativeInt(process.env['KIMI_SUBAGENT_TIMEOUT_MS']) ?? config.subagent?.timeoutMs;
}

/** Per-`AgentSwarm` subagent timeout in ms, independent of `[subagent]`. */
export function resolveSwarmTimeoutMs(config: {
  swarm?: { timeoutMs?: number };
}): number | undefined {
  return nonNegativeInt(process.env['KIMI_CODE_SWARM_TIMEOUT_MS']) ?? config.swarm?.timeoutMs;
}

/**
 * Maximum total attempts for a failing step (v2 `loopControl.max_attempts_per_step`).
 * The deprecated `KIMI_LOOP_MAX_RETRIES_PER_STEP` is honored when the renamed
 * variable is unset; `kimi doctor` owns the deprecation warning.
 */
export function resolveMaxAttemptsPerStep(config: {
  loopControl?: { maxAttemptsPerStep?: number; maxRetriesPerStep?: number };
}): number | undefined {
  return (
    nonNegativeInt(process.env['KIMI_LOOP_MAX_ATTEMPTS_PER_STEP']) ??
    nonNegativeInt(process.env['KIMI_LOOP_MAX_RETRIES_PER_STEP']) ??
    config.loopControl?.maxAttemptsPerStep ??
    config.loopControl?.maxRetriesPerStep
  );
}

/**
 * Per-turn step cap (`loopControl.maxStepsPerTurn`; env
 * `KIMI_LOOP_MAX_STEPS_PER_TURN` wins). `0` and unset both mean unlimited
 * (v2 `loopService.ts` only enforces a positive cap), so both resolve to
 * `undefined` and the engine keeps its own default.
 */
export function resolveMaxStepsPerTurn(config: {
  loopControl?: { maxStepsPerTurn?: number };
}): number | undefined {
  const raw =
    nonNegativeInt(process.env['KIMI_LOOP_MAX_STEPS_PER_TURN']) ??
    config.loopControl?.maxStepsPerTurn;
  return raw === undefined || raw === 0 ? undefined : raw;
}

const THINKING_KEEP_OFF_VALUES = new Set(['false', '0', 'no', 'off', 'none', 'null']);

/**
 * Moonshot preserved-thinking passthrough (`thinking.keep`): env
 * `KIMI_MODEL_THINKING_KEEP` > `[thinking].keep`. An off-value resolves to
 * `undefined` (no keep on the wire). Unset stays `undefined` — unlike the
 * host-proxy path's "all" default, the native wire keeps bodies unchanged
 * until the user configures keep.
 */
export function resolveThinkingKeep(config: { thinking?: { keep?: string } }): string | undefined {
  const raw = process.env['KIMI_MODEL_THINKING_KEEP'] ?? config.thinking?.keep;
  const value = raw?.trim();
  if (value === undefined || value.length === 0) return undefined;
  if (THINKING_KEEP_OFF_VALUES.has(value.toLowerCase())) return undefined;
  return value;
}

/** Raw-byte budget for model-initiated image reads (env > config). */
export function resolveImageReadByteBudget(config: {
  image?: { readByteBudget?: number };
}): number | undefined {
  return positiveInt(process.env['KIMI_IMAGE_READ_BYTE_BUDGET']) ?? config.image?.readByteBudget;
}

/** One `[services.moonshot_*]` entry (base URL + credential + extra headers). */
export interface WebServiceConfig {
  baseUrl: string;
  apiKey?: string;
  customHeaders?: Record<string, string>;
}

interface MoonshotServiceConfigShape {
  baseUrl?: string;
  apiKey?: string;
  customHeaders?: Record<string, string>;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Resolve one `[services.moonshot_*]` entry with its `KIMI_WEB_*` env overlay
 * (env wins). An env base URL is a credential boundary: persisted api keys,
 * OAuth refs, and custom headers from config.toml never cross into an
 * env-selected endpoint (mirrors the v2 `isolateEnvServiceCredentials`
 * semantics).
 */
function resolveWebService(
  service: MoonshotServiceConfigShape | undefined,
  baseUrlEnv: string,
  apiKeyEnv: string,
): WebServiceConfig | undefined {
  const envBaseUrl = nonBlank(process.env[baseUrlEnv]);
  const envApiKey = nonBlank(process.env[apiKeyEnv]);
  if (envBaseUrl !== undefined) {
    return { baseUrl: envBaseUrl, apiKey: envApiKey };
  }
  const baseUrl = nonBlank(service?.baseUrl);
  if (baseUrl === undefined) return undefined;
  const customHeaders = service?.customHeaders;
  return {
    baseUrl,
    apiKey: envApiKey ?? nonBlank(service?.apiKey),
    customHeaders:
      customHeaders !== undefined && Object.keys(customHeaders).length > 0
        ? customHeaders
        : undefined,
  };
}

/** `[services.moonshot_search]` / `KIMI_WEB_SEARCH_*` → native WebSearch backend. */
export function resolveWebSearchService(config: {
  services?: { moonshotSearch?: MoonshotServiceConfigShape };
}): WebServiceConfig | undefined {
  return resolveWebService(
    config.services?.moonshotSearch,
    'KIMI_WEB_SEARCH_BASE_URL',
    'KIMI_WEB_SEARCH_API_KEY',
  );
}

/** `[services.moonshot_fetch]` / `KIMI_WEB_FETCH_*` → native FetchURL backend. */
export function resolveWebFetchService(config: {
  services?: { moonshotFetch?: MoonshotServiceConfigShape };
}): WebServiceConfig | undefined {
  return resolveWebService(
    config.services?.moonshotFetch,
    'KIMI_WEB_FETCH_BASE_URL',
    'KIMI_WEB_FETCH_API_KEY',
  );
}

export function probeShellPath(): string | undefined {
  const envShell = process.env['KIMI_SHELL_PATH'];
  if (envShell) {
    return envShell;
  }
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'];
    const candidates = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
      localAppData ? `${localAppData}\\Programs\\Git\\bin\\bash.exe` : undefined,
    ].filter(Boolean) as string[];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }
  return process.env['SHELL'] ?? '/bin/bash';
}
