import { existsSync } from 'node:fs';

import type { KimiConfig, ModelAlias } from '#/config-local';
import { ErrorCodes, KimiError } from '#/error-protocol';
import { effectiveModelAlias } from '#/model-alias';

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
  /**
   * Name of the environment variable the transport reads the credential from
   * at request time (`[providers.*].apiKeyEnv`). Set only when the provider
   * carries neither a static key nor an OAuth binding — with a static key the
   * key itself travels, and an OAuth binding rides `authProvider` instead.
   */
  apiKeyEnv?: string;
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
  /**
   * Route an anthropic-protocol model through the beta Messages API
   * (`[models.<alias>].betaApi`): the transport posts to
   * `/v1/messages?beta=true` instead of the standard endpoint.
   */
  betaApi?: boolean;
  /**
   * The alias's declared capabilities (`[models.<alias>].capabilities`) after
   * the `overrides` merge. `undefined`/empty means the file declares none —
   * the engine's image-read gate then allows image reads.
   */
  capabilities?: string[];
  /**
   * The alias's own system prompt (`[models.<alias>].systemPrompt`).
   */
  systemPrompt?: string;
  /**
   * Declared prompt/input cap when below the total window
   * (`[models.<alias>].maxInputSize`).
   */
  maxInputSize?: number;
  /**
   * Explicit adaptive-thinking support, overriding the model-name version
   * inference (`[models.<alias>].adaptiveThinking`).
   */
  adaptiveThinking?: boolean;
  /**
   * The wire field carrying reasoning content (`[models.<alias>].reasoningKey`).
   */
  reasoningKey?: string;
  /**
   * The effort value that encodes "thinking off" on the wire
   * (`[models.<alias>].offEffort`).
   */
  offEffort?: string;
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

/** A trailing API version segment (`/v1`, `/v1beta`, `/v2alpha`, …). */
const API_VERSION_SEGMENT = /\/v\d+[a-z]*($|\/)/i;

export function normalizeBaseUrl(protocol: string, baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  if (protocol === 'google' || protocol === 'google-genai' || protocol === 'gemini') {
    // The GenerateContent API always carries a version segment, and the
    // documented contract is "give the host root only — the client appends the
    // API version segment itself" (kosong CHANGELOG #1269, mirrored by
    // `packages/kimi-agent/src/llm/google_genai.rs`). The native transport
    // builds `{base}/models/{model}:streamGenerateContent`, so a bare host root
    // otherwise requests a path that is not an API route at all — a
    // Gemini-compatible relay answers it from its catch-all and the SSE decoder
    // then sees nothing.
    return API_VERSION_SEGMENT.test(trimmed) ? trimmed : `${trimmed}/v1beta`;
  }
  if (protocol === 'openai' || protocol === 'openai_responses' || protocol === 'openai-responses') {
    return /\/v\d+($|\/)/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  }
  return /\/v\d+($|\/)/.test(trimmed) || /^https?:\/\/[^/]+$/.test(trimmed)
    ? trimmed
    : `${trimmed}/v1`;
}

export function resolveNativeLlm(
  config: KimiConfig,
  defaultHeaders?: Record<string, string>,
): JsNativeLlmConfig | undefined {
  const defaultModelAlias = config.defaultModel;
  return defaultModelAlias === undefined
    ? undefined
    : resolveNativeLlmForAlias(config, defaultModelAlias, undefined, defaultHeaders);
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
  defaultHeaders?: Record<string, string>,
): JsNativeLlmConfig | undefined {
  const modelConfig = lookupModelAlias(config, alias);
  // v2 `providerNameFromFlatModel`: `providerId` is an alias for `provider`.
  const providerName =
    modelConfig?.providerId ?? modelConfig?.provider ?? config.agent?.nativeLlmProvider;
  if (!providerName) return undefined;

  const provider = config.providers?.[providerName];
  const typeStr = String(provider?.type ?? '');
  // A declared alias endpoint wins: gateway providers serve one alias over a
  // different path than the provider default (`[models.<alias>].baseUrl`).
  //
  // Google's endpoint is a constant, so a provider without `base_url` still
  // resolves natively — its OAuth token rides the `auth_provider` token
  // channel below — instead of silently falling back to the host LLM proxy.
  const rawBaseUrl =
    modelConfig?.baseUrl ??
    provider?.baseUrl ??
    (typeStr === 'google' || typeStr === 'google-genai' || typeStr === 'gemini'
      ? 'https://generativelanguage.googleapis.com'
      : undefined);
  if (!provider || !rawBaseUrl) return undefined;
  // The alias declares its own wire protocol (`[models.<alias>].protocol`:
  // "anthropic" | "openai_responses"); the provider type is the fallback, and
  // everything else is Chat Completions.
  const protocol =
    modelConfig?.protocol ??
    (typeStr === 'anthropic'
      ? 'anthropic'
      : typeStr === 'google' || typeStr === 'gemini' || typeStr === 'google-genai'
        ? 'google'
        : typeStr === 'openai_responses' || typeStr === 'openai-responses'
          ? 'openai_responses'
          : typeStr === 'openai' || typeStr === 'kimi'
            ? 'openai'
            : undefined);
  if (!protocol) return undefined;

  // The `overrides` merge the TUI's footer / model picker already read, so the
  // wire and the UI cannot disagree about an alias's caps, effort, or output
  // budget (v2 `effectiveRecordOf` + `withAnthropicProfile`).
  const effective =
    modelConfig === undefined ? undefined : effectiveModelAlias(modelConfig, provider.type);

  // Credential derivation, mirrored from the Rust authority
  // (`config/mod.rs::extract_native_llm`): the standalone CLI resolves the
  // provider through this same ladder, so any divergence here is a silent
  // behaviour split between the TUI and that path. Exactly one channel
  // travels — per-model over provider-level, and a static key over an OAuth
  // binding at each level — with the mutual exclusivity the transport's
  // `credential()` enforces (`api_key_env` only ever accompanies an empty
  // `api_key` and no `auth_provider`).
  //
  // An env-bound provider (neither static key nor OAuth) resolves at startup
  // and reads its credential from the named variable per request; without any
  // channel at all the model cannot serve a request and does not resolve.
  //
  // One deliberate difference: the *model* key is tested for blankness here
  // (`nonBlank`, the fork's pre-existing rule), where Rust tests for
  // emptiness. The two agree on every real key and differ only on a
  // whitespace-only one, which Rust would send as the credential verbatim.
  // The provider key uses the same non-empty test as Rust.
  const modelApiKey = nonBlank(modelConfig?.apiKey);
  const modelOAuth = modelConfig?.oauth;
  const providerApiKey = typeof provider.apiKey === 'string' ? provider.apiKey : '';
  const providerOAuth = provider.oauth;
  // Rust's env name is filtered for emptiness, not for blankness
  // (`filter(|e| !e.is_empty())`), and only in the env-only branch: the
  // static-key branch clones the provider's name through verbatim.
  const providerApiKeyEnv = provider.apiKeyEnv;

  let apiKey = '';
  let authProvider: string | undefined;
  let apiKeyEnv: string | undefined;
  if (modelApiKey !== undefined) {
    apiKey = modelApiKey;
  } else if (modelOAuth !== undefined) {
    authProvider = providerName;
  } else if (providerApiKey.length > 0) {
    apiKey = providerApiKey;
    apiKeyEnv = providerApiKeyEnv;
  } else if (providerOAuth !== undefined) {
    authProvider = providerName;
  } else if (providerApiKeyEnv !== undefined && providerApiKeyEnv.length > 0) {
    apiKeyEnv = providerApiKeyEnv;
  } else {
    return undefined;
  }

  // v2 `buildModel`: the name sent to the provider is the record's `name`
  // first, then `model` — never the alias.
  let model = effective?.name ?? effective?.model ?? provider.defaultModel;
  if (!model && config.models) {
    const aliasEntry = Object.entries(config.models).find(
      ([, entry]) => (entry.providerId ?? entry.provider) === providerName,
    );
    if (aliasEntry) model = aliasEntry[1].name ?? aliasEntry[1].model;
  }
  if (!model) return undefined;

  const customHeaders = {
    ...defaultHeaders,
    ...Object.fromEntries(
      Object.entries(provider.customHeaders ?? {}).filter(
        ([key]) => !AUTH_HEADERS.has(key.toLowerCase()),
      ),
    ),
  };

  let reasoningEffort: string | undefined;
  let thinkingBudget: number | undefined;

  const thinkingConfig = config.thinking;
  const modelEffort = effortOverride ?? effective?.defaultEffort ?? thinkingConfig?.effort;

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

  // The engine's image-read gate reads the *declared* set (v2
  // `effectiveRecordOf`: `overrides.capabilities ?? capabilities`), so the
  // anthropic profile's injected `thinking` capability — a UI affordance —
  // must not travel here.
  const capabilities = modelConfig?.overrides?.capabilities ?? modelConfig?.capabilities;

  return {
    protocol,
    baseUrl: normalizeBaseUrl(protocol, rawBaseUrl),
    apiKey,
    model,
    maxTokens: effective?.maxOutputSize ?? provider.maxTokens,
    customHeaders: Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
    reasoningEffort,
    thinkingBudget,
    authProvider,
    apiKeyEnv,
    thinkingKeep: resolveThinkingKeep(config),
    betaApi: modelConfig?.betaApi === true ? true : undefined,
    capabilities:
      capabilities !== undefined && capabilities.length > 0 ? [...capabilities] : undefined,
    systemPrompt: modelConfig?.systemPrompt,
    maxInputSize: effective?.maxInputSize,
    adaptiveThinking: effective?.adaptiveThinking,
    reasoningKey: effective?.reasoningKey,
    offEffort: effective?.offEffort,
  };
}

/**
 * Resolve one `[models]` key to its entry. v2's `findByName` also matches a
 * record's `aliases`, so an entry can be reached by any name it declares —
 * `default_model` may point at an alias rather than the table key.
 */
export function lookupModelAlias(config: KimiConfig, alias: string): ModelAlias | undefined {
  const direct = config.models?.[alias];
  if (direct !== undefined) return direct;
  return Object.values(config.models ?? {}).find((entry) => entry.aliases?.includes(alias));
}

/**
 * The context window a `[models]` key resolves to, `overrides` applied. Every
 * caller that needs the window must go through this: indexing `config.models`
 * directly misses both an `aliases` name and an `overrides.maxContextSize`,
 * so the session would report a 0-token window for a model it can run.
 */
export function resolveModelContextWindow(
  config: KimiConfig,
  alias: string | undefined,
): number {
  if (alias === undefined) return 0;
  const entry = lookupModelAlias(config, alias);
  if (entry === undefined) return 0;
  return effectiveModelAlias(entry).maxContextSize ?? 0;
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
    api_key_env: config.apiKeyEnv,
    model: config.model,
    max_tokens: config.maxTokens,
    custom_headers: config.customHeaders,
    reasoning_effort: config.reasoningEffort,
    thinking_budget: config.thinkingBudget,
    auth_provider: config.authProvider,
    thinking_keep: config.thinkingKeep,
    beta_api: config.betaApi ?? false,
    capabilities: config.capabilities,
    system_prompt: config.systemPrompt,
    max_input_size: config.maxInputSize,
    adaptive_thinking: config.adaptiveThinking,
    reasoning_key: config.reasoningKey,
    off_effort: config.offEffort,
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
  defaultHeaders?: Record<string, string>,
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
    const llm = resolveNativeLlmForAlias(config, alias, defaultEffort, defaultHeaders);
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

/** A config number that must be an integer ≥ `min` (otherwise `undefined`). */
function integerAtLeast(value: number | undefined, min: number): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= min ? value : undefined;
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

/** Longest-edge ceiling (px) for model-initiated image reads (env > config). */
export function resolveImageMaxEdgePx(config: {
  image?: { maxEdgePx?: number };
}): number | undefined {
  return positiveInt(process.env['KIMI_IMAGE_MAX_EDGE_PX']) ?? config.image?.maxEdgePx;
}

/** `[image]` limits for model-initiated reads, ready for the engine params. */
export function resolveImageLimits(config: {
  image?: { readByteBudget?: number; maxEdgePx?: number };
}): { readByteBudget?: number; maxEdgePx?: number } | undefined {
  const readByteBudget = resolveImageReadByteBudget(config);
  const maxEdgePx = resolveImageMaxEdgePx(config);
  if (readByteBudget === undefined && maxEdgePx === undefined) return undefined;
  return { readByteBudget, maxEdgePx };
}

/** `[background]` knobs the Rust engine applies to its task runner + Bash tool. */
export interface BackgroundLimits {
  /** `[background].kill_grace_period_ms`: cooperative-stop grace. */
  readonly killGracePeriodMs?: number;
  /** `[background].max_running_tasks`: concurrent-task cap. */
  readonly maxRunningTasks?: number;
  /** `[background].bash_auto_background_on_timeout`. */
  readonly bashAutoBackgroundOnTimeout?: boolean;
  /** `[background].bash_task_timeout_s`; `0` means "no timeout". */
  readonly bashTaskTimeoutS?: number;
}

/**
 * `[background]` limits for the engine session params (the engine applies them
 * to the task runner it builds). The concurrency cap honors
 * `KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS` (env > config, matching the
 * Rust-side `KimiConfig::resolve_background_max_running_tasks`); the rest pass
 * through. A non-positive grace period or cap is not meaningful and resolves to
 * `undefined` (engine default), while `bashTaskTimeoutS = 0` is kept — it means
 * "no timeout", not "unset".
 */
export function resolveBackgroundLimits(config: {
  background?: {
    killGracePeriodMs?: number;
    maxRunningTasks?: number;
    bashAutoBackgroundOnTimeout?: boolean;
    bashTaskTimeoutS?: number;
  };
}): BackgroundLimits | undefined {
  const section = config.background;
  const killGracePeriodMs = integerAtLeast(section?.killGracePeriodMs, 1);
  const envCap = nonNegativeInt(process.env['KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS']);
  const maxRunningTasks =
    (envCap !== undefined && envCap > 0 ? envCap : undefined) ??
    integerAtLeast(section?.maxRunningTasks, 1);
  const bashTaskTimeoutS = integerAtLeast(section?.bashTaskTimeoutS, 0);
  const bashAutoBackgroundOnTimeout = section?.bashAutoBackgroundOnTimeout;
  if (
    killGracePeriodMs === undefined &&
    maxRunningTasks === undefined &&
    bashTaskTimeoutS === undefined &&
    bashAutoBackgroundOnTimeout === undefined
  ) {
    return undefined;
  }
  return { killGracePeriodMs, maxRunningTasks, bashAutoBackgroundOnTimeout, bashTaskTimeoutS };
}

/** `[background]` print knobs the engine settles a `kimi -p` session with. */
export interface PrintBackgroundSettings {
  /** `[background].print_background_mode`; the engine owns what it means. */
  readonly mode: string;
  /** `[background].print_wait_ceiling_s`: bound on the engine's settle wait. */
  readonly ceilingS: number;
  /** `[background].print_max_turns`: cap on the engine's steer turns. */
  readonly maxTurns: number;
}

/**
 * The documented `print_background_mode` values. The engine owns how each one
 * behaves (`PrintBackgroundMode` in `kimi-agent/src/session/mod.rs`); the host
 * only picks which one to hand over, so an unknown value degrades to the
 * documented default rather than failing the run.
 */
const PRINT_BACKGROUND_MODES = ['exit', 'drain', 'steer'] as const;

/** Documented default of `[background].print_wait_ceiling_s` (~24.8 days). */
export const PRINT_WAIT_CEILING_S_DEFAULT = 2_147_483;

/** Documented default of `[background].print_max_turns`. */
export const PRINT_MAX_TURNS_DEFAULT = 100_000;

/** Truthiness table of `KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT` (env-vars.md). */
function envFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

/**
 * `[background]` print knobs for the engine session params.
 *
 * The host resolves only *which* values apply — the engine owns what they do:
 * it holds the turn receipt while the session's background tasks are still
 * running (`settle_print_background`), so no host-side wait loop exists.
 * Precedence (config-files.md § background): an explicit `print_background_mode`
 * wins; otherwise `keep_alive_on_exit` — the env var first, then the config
 * field — maps a truthy value to `"drain"`; anything else keeps the documented
 * default `"steer"`, including an explicit `keep_alive_on_exit = false`, which
 * is the field's own default and so cannot mean "exit".
 */
export function resolvePrintBackground(config: {
  background?: {
    printBackgroundMode?: string;
    printWaitCeilingS?: number;
    printMaxTurns?: number;
    keepAliveOnExit?: boolean;
  };
}): PrintBackgroundSettings {
  const section = config.background;
  const declared = PRINT_BACKGROUND_MODES.find((mode) => mode === section?.printBackgroundMode);
  const keepAlive =
    envFlag(process.env['KIMI_CODE_BACKGROUND_KEEP_ALIVE_ON_EXIT']) ?? section?.keepAliveOnExit;
  return {
    mode: declared ?? (keepAlive === true ? 'drain' : 'steer'),
    ceilingS: integerAtLeast(section?.printWaitCeilingS, 1) ?? PRINT_WAIT_CEILING_S_DEFAULT,
    maxTurns: integerAtLeast(section?.printMaxTurns, 1) ?? PRINT_MAX_TURNS_DEFAULT,
  };
}

/**
 * The declared capabilities of one `[models]` alias (default: the config's
 * default model). `undefined` means the file declares none — the engine
 * treats the model as unknown and allows image reads.
 */
export function resolveModelCapabilities(
  config: KimiConfig,
  alias?: string,
): string[] | undefined {
  const key = alias ?? config.defaultModel;
  if (key === undefined) return undefined;
  const capabilities = lookupModelAlias(config, key)?.capabilities;
  return capabilities !== undefined && capabilities.length > 0 ? [...capabilities] : undefined;
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
