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
