import { existsSync } from 'node:fs';
import type { KimiConfig } from '#/config-local';

// The engine's transports own these headers (openai/anthropic auth, the
// anthropic-version pin, the google api-key); reqwest appends rather than
// replaces, so a user customHeader with one of these names would ship a second
// value and break the credential. Mirrors rust-engine.ts's AUTH_HEADERS — the
// two native-LLM resolvers must agree, or the same provider resolves to
// different headers depending on which entry point built the session.
const AUTH_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'anthropic-version',
  'x-goog-api-key',
]);

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
  pre_tool_hooks: Array<{
    event: string;
    matcher: string;
    command: string;
    timeout?: number;
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
  const modelConfig =
    defaultModelAlias === undefined ? undefined : config.models?.[defaultModelAlias];
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
    const alias = Object.entries(config.models).find(([, m]) => m.provider === providerName);
    if (alias) model = alias[1].model;
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
  const modelEffort = modelConfig?.defaultEffort ?? thinkingConfig?.effort;

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
  const mode = (config.yolo === true
    ? 'yolo'
    : config.defaultPermissionMode ?? 'manual') as 'manual' | 'auto' | 'yolo' | 'plan';
  const rules = config.permission?.rules ?? [];
  const hooks = config.hooks ?? [];

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
    pre_tool_hooks: hooks
      .filter((h) => typeof h.command === 'string')
      .map((h) => ({
        event: h.event ?? '',
        matcher: h.matcher ?? '',
        command: h.command ?? '',
        timeout: h.timeout,
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
  return (
    nonNegativeInt(process.env['KIMI_CODE_SWARM_TIMEOUT_MS']) ?? config.swarm?.timeoutMs
  );
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
  return (
    positiveInt(process.env['KIMI_IMAGE_READ_BYTE_BUDGET']) ?? config.image?.readByteBudget
  );
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
