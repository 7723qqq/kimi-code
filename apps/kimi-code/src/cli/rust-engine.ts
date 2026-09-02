/**
 * Rust agent engine integration (v2).
 *
 * Wires the Rust agent engine (kimi-agent) based on the `agent.engine`
 * gate. The gate is rust-only: the TS agent engine is explicitly disabled
 * for the duration of the rust migration, so a missing or broken rust
 * bundle is a startup error, never a silent fallback to the JS loop.
 * `agent.engine = "js"` is ignored (with a warning) — there is no opt-out.
 *
 * MultiLLM support: when `agent.multiLlm` lists provider names, those
 * providers are extracted from the config and passed to the Rust engine
 * as concurrent LLM providers ("first past the post").
 */
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadRuntimeConfigSafe, resolveConfigPath, resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';
import type { TurnEngine } from '@moonshot-ai/agent-core-v2';

import { patchEngineExecution, setEngineExecution } from '#/utils/engine-execution';

interface LlmProviderDef {
  name: string;
  model: string;
  system_prompt: string;
}

/** Headers the native transport sets itself; a provider must not add a second value. */
const AUTH_HEADERS = new Set(['authorization', 'x-api-key', 'anthropic-version']);

interface NativeLlmDef {
  protocol: 'openai' | 'anthropic';
  base_url: string;
  api_key: string;
  model: string;
  max_tokens?: number;
  custom_headers?: Record<string, string>;
}

/** A native-transport candidate: either a usable definition, or why it is not. */
interface NativeLlmResolution {
  def?: NativeLlmDef;
  reason?: string;
}

interface RustEngineConfig {
  defaultModel?: string;
  providers?: Record<
    string,
    {
      defaultModel?: string;
      type?: string;
      apiKey?: string;
      baseUrl?: string;
      customHeaders?: Record<string, string>;
    }
  >;
  models?: Record<string, { provider?: string; model?: string; systemPrompt?: string }>;
  agent?: {
    multiLlm?: string[];
    nativeLlmProvider?: string;
    nativeTools?: boolean;
    rustSelfContained?: boolean;
  };
}

let rustTurnEngine: TurnEngine | undefined;

/**
 * Extract MultiLLM provider definitions from the kimi config.
 * Uses `config.agent.multiLlm` to select which providers to include.
 */
function extractMultiLlmProviders(
  config: RustEngineConfig,
  defaultSystemPrompt?: string,
): LlmProviderDef[] | undefined {
  const providerNames = config.agent?.multiLlm;
  if (!providerNames || providerNames.length === 0) return undefined;
  if (!config.providers) return undefined;

  const providers: LlmProviderDef[] = [];

  for (const name of providerNames) {
    const providerConfig = config.providers[name];
    if (!providerConfig) continue;

    // Resolve the model: use provider's defaultModel, or find the first model
    // alias that references this provider
    let model = providerConfig.defaultModel;
    let systemPrompt = defaultSystemPrompt ?? '';
    if (config.models) {
      const alias = Object.entries(config.models).find(([, m]) => m.provider === name);
      if (alias) {
        model ??= alias[1].model;
        // Per-model system prompt wins over the default when present.
        if (alias[1].systemPrompt) systemPrompt = alias[1].systemPrompt;
      }
    }
    model ??= 'default';

    providers.push({
      name,
      model,
      system_prompt: systemPrompt,
    });
  }

  return providers.length > 0 ? providers : undefined;
}

/**
 * Extract the native HTTP LLM transport config from the kimi config.
 *
 * The provider is derived from the **current default model** (not from
 * `agent.nativeLlmProvider`) so that when the user switches models in the
 * TUI — e.g. from a model on `provider A` to one on `provider B` — the
 * Rust engine calls the correct provider endpoint on the next turn.
 *
 * `agent.nativeLlmProvider` is kept as a fallback: when the default model's
 * provider is not suitable for native transport (e.g. OAuth-managed, missing
 * static key), the named provider is tried instead.
 *
 * Only static-key `openai`/`kimi` (Chat Completions) and `anthropic`
 * (Messages) providers are supported; anything else falls back to the host
 * proxy, and the returned reason says why.
 */
function extractNativeLlm(config: RustEngineConfig): NativeLlmResolution {
  const tried: NativeLlmResolution[] = [];

  // 1) Try the current default model's provider.
  const defaultModelAlias = config.defaultModel;
  const modelConfig = defaultModelAlias === undefined ? undefined : config.models?.[defaultModelAlias];
  const providerName = modelConfig?.provider;
  if (providerName !== undefined) {
    const resolution = tryResolveNativeLlm(config, providerName, modelConfig?.model);
    if (resolution.def !== undefined) return resolution;
    tried.push(resolution);
  }

  // 2) Fall back to agent.nativeLlmProvider (legacy behaviour).
  const legacyName = config.agent?.nativeLlmProvider;
  if (legacyName !== undefined) {
    const resolution = tryResolveNativeLlm(config, legacyName);
    if (resolution.def !== undefined) return resolution;
    tried.push(resolution);
  }

  return tried[0] ?? { reason: 'the default model has no provider configured' };
}

/**
 * Resolve a single provider into a `NativeLlmDef`. Returns a reason when the
 * provider is missing, has an unsupported type, or lacks a static
 * `baseUrl`/`apiKey` — in which case the caller can try the next candidate.
 */
function tryResolveNativeLlm(
  config: RustEngineConfig,
  providerName: string,
  explicitModel?: string,
): NativeLlmResolution {
  const provider = config.providers?.[providerName];
  if (!provider) {
    return { reason: `provider "${providerName}" is not configured` };
  }

  const protocol =
    provider.type === 'anthropic'
      ? 'anthropic'
      : provider.type === 'openai' || provider.type === 'kimi'
        ? 'openai'
        : undefined;
  if (protocol === undefined) {
    return {
      reason: `provider "${providerName}" type "${provider.type ?? 'unknown'}" has no native transport`,
    };
  }
  if (!provider.baseUrl || !provider.apiKey) {
    return {
      reason: `provider "${providerName}" has no static baseUrl + apiKey for the native transport`,
    };
  }

  // Use the explicit model from the model alias, or fall back to the
  // provider's defaultModel, or the first model referencing this provider.
  let model = explicitModel ?? provider.defaultModel;
  if (!model && config.models) {
    const alias = Object.entries(config.models).find(([, m]) => m.provider === providerName);
    if (alias) model = alias[1].model;
  }
  if (!model) {
    return { reason: `provider "${providerName}" has no resolvable model` };
  }

  const customHeaders = Object.fromEntries(
    // reqwest appends headers instead of replacing them, so a custom
    // authorization / x-api-key would ship as a second value and the provider
    // would see a broken credential. The engine owns these three.
    Object.entries(provider.customHeaders ?? {}).filter(
      ([key]) => !AUTH_HEADERS.has(key.toLowerCase()),
    ),
  );

  return {
    def: {
      protocol,
      base_url: normalizeBaseUrl(protocol, provider.baseUrl),
      api_key: provider.apiKey,
      model,
      custom_headers: Object.keys(customHeaders).length > 0 ? customHeaders : undefined,
    },
  };
}

/**
 * Adapt provider `baseUrl` values to the URL shape the kimi-agent engine
 * expects.
 *
 * - `anthropic`: the engine appends `/messages` to `baseUrl` with no
 *   version segment. Reverse proxies that embed a path component (e.g.
 *   `…/anthropic`) must expose Messages at `…/anthropic/v1/messages`; we
 *   inject the `/v1` sibling here. Bare-host base URLs (e.g.
 *   `https://api.anthropic.com`) are passed through unchanged.
 * - `openai`: the engine appends `/chat/completions` with no version
 *   segment, so the stored base URL must already include the version
 *   path (`…/v1`). When the URL is bare (`https://api.example.com`) we
 *   append `/v1`. URLs that already end in `/vN` (including `/v1`) are
 *   passed through.
 */
export function normalizeBaseUrl(protocol: 'openai' | 'anthropic', baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  if (protocol === 'openai') {
    return /\/v\d+($|\/)/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  }
  // anthropic
  return /\/v\d+($|\/)/.test(trimmed) || /^https?:\/\/[^/]+$/.test(trimmed)
    ? trimmed
    : `${trimmed}/v1`;
}

/**
 * Bundle-presence guard for the rust-first default. True when the engine
 * bundle is present (napi addon or the bundled stdio CLI). Mirrors
 * `rust-loop`'s `isRustEngineAvailable` against the same candidate paths,
 * but stays dependency-free — importing rust-loop drags the whole
 * agent-core-v2 graph in, which is several seconds on a cold test worker.
 * Only existence checks, never loads: a missing bundle is a startup error,
 * never a JS fallback — the gate is rust-only for the migration.
 */
function isEngineLoadable(): boolean {
  const root = resolve(import.meta.dirname, '..', '..', '..', '..');
  const ext = process.platform === 'win32' ? '.exe' : '';
  const arch = `${process.platform}-${process.arch}`;
  const stdioCandidates = [
    join(root, 'packages/kimi-agent/target/release', `kimi-agent-cli${ext}`),
    join(root, 'packages/kimi-agent/target/debug', `kimi-agent-cli${ext}`),
    join(root, 'dist-native/bin', arch, `kimi-agent-cli${ext}`),
  ];
  try {
    for (const candidate of stdioCandidates) {
      if (existsSync(candidate)) return true;
    }
  } catch {
    // ignore and fall through to the addon check
  }
  try {
    return readdirSync(join(root, 'packages/kimi-agent')).some(
      (entry) => entry.startsWith('kimi_agent') && entry.endsWith('.node'),
    );
  } catch {
    return false;
  }
}

/**
 * Wire the Rust agent engine. The gate is rust-only: the TS engine is
 * disabled for the duration of the rust migration, so this either returns
 * the engine or throws (the callers exit on the error) — it never returns
 * `undefined` today, but the optional signature keeps the harness wiring
 * (`engineOverride !== undefined` spread) honest.
 *
 * When `agent.multiLlm` is configured, extracts matching providers
 * and passes them to the Rust engine for concurrent MultiLLM execution.
 */
export async function maybeLoadRustEngine(
  homeDir?: string,
  configPath?: string,
): Promise<TurnEngine | undefined> {
  return resolveRustEngine(homeDir, configPath);
}

async function resolveRustEngine(
  homeDir?: string,
  configPath?: string,
): Promise<TurnEngine | undefined> {
  // Lazy-init: once loaded, cache the result
  if (rustTurnEngine !== undefined) return rustTurnEngine;

  const resolvedHome = resolveKimiHome(homeDir);
  const resolvedConfig = resolveConfigPath({ homeDir: resolvedHome, configPath });
  const loaded = loadRuntimeConfigSafe(resolvedConfig);
  // An unreadable config cannot express an engine preference, so the gate
  // treats it as unset — and unset means the rust engine (below).
  const agentConfig = loaded.fileError === undefined ? loaded.config.agent : undefined;

  // Engine gate — rust-only, no opt-out during the migration:
  // - agent.engine = "js"    → ignored (warned): the TS engine stays disabled.
  // - agent.engine = "rust"  → rust engine required.
  // - unset (default)        → rust engine required.
  // A missing or broken rust bundle is a startup error, never a silent JS
  // fallback.
  if (agentConfig?.engine === 'js') {
    console.warn(
      '[kimi-agent] `[agent] engine = "js"` is ignored — the TS agent engine is disabled for the rust migration.',
    );
  }
  if (!isEngineLoadable()) {
    throw new Error(
      '[kimi-agent] Rust engine bundle not found — the TS agent engine is disabled. ' +
        'Build the native bundle (start-native.bat / `make rust-build`).',
    );
  }
  // Wired but unrun: the gate is rust-only and the bundle is loadable, so the
  // TS engine is off from here — without guessing a transport yet.
  setEngineExecution({ rust: true });

  // Extract MultiLLM providers and native execution options when configured.
  // `nativeLlm` is resolved **dynamically** on each turn so that when the user
  // switches models in the TUI (which writes a new `default_model` to
  // config.toml), the Rust engine follows to the new model's provider instead
  // of forever calling the provider that was active at startup.
  const providers = extractMultiLlmProviders(loaded.config);
  // P21 D-1: nativeTools defaults to true for native sandboxed tool speedup.
  const nativeTools = agentConfig?.nativeTools !== false;
  // rustSelfContained (P26 批 1): opt-in switch that forces the Rust
  // engine to fail fast if no native LLM transport is configured,
  // instead of silently falling back to host/llm_chat. Default false
  // preserves the existing host-proxy fallback for backwards compat.
  const rustSelfContained = agentConfig?.rustSelfContained === true;
  // Native Bash must run under the same shell the host Bash tool documents
  // (bash everywhere, Git Bash on Windows) — probe it once for the engine.
  let shellPath: string | undefined;
  try {
    const os = await import('node:os');
    const fsPromises = await import('node:fs/promises');
    const { probeHostEnvironment } = await import('@moonshot-ai/agent-core-v2');
    const env = await probeHostEnvironment({
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      homeDir: os.homedir(),
      env: process.env,
      isFile: async (p) => {
        try {
          return (await fsPromises.stat(p)).isFile();
        } catch {
          return false;
        }
      },
      execFileText: async (file, args, timeoutMs) => {
        const { execFile } = await import('node:child_process');
        return new Promise((resolve) => {
          execFile(file, [...args], { timeout: timeoutMs }, (error, stdout) => {
            resolve(error === undefined || error === null ? String(stdout) : undefined);
          });
        });
      },
    });
    shellPath = env.shellPath;
  } catch {
    // Without a probed shell the engine keeps native Bash on the host.
    shellPath = undefined;
  }

  // Dynamic import of the Rust adapter via the workspace package. The gate
  // above already established the bundle is loadable, so a failure here is a
  // broken install — surfaced, never silently traded for the TS loop.
  const { createRunTurnOverride, activeEngineMode } = await import('@moonshot-ai/kimi-agent/rust-loop');
  if (typeof createRunTurnOverride !== 'function') {
    throw new Error(
      '[kimi-agent] rust adapter module has no createRunTurnOverride — broken install; the TS agent engine is disabled.',
    );
  }
  // The workspace root anchors the Read-prediction fast-path and the
  // native tool sandbox; the session working directory is the workspace.
  const engine = createRunTurnOverride(providers ?? undefined, process.cwd(), {
    nativeLlm: () => {
      // Re-read the config file fresh so model switches in the TUI
      // (which update `default_model` in config.toml) are reflected.
      const reloaded = loadRuntimeConfigSafe(resolvedConfig);
      if (reloaded.fileError !== undefined) return;
      const resolution = extractNativeLlm(reloaded.config);
      patchEngineExecution({ llmFallbackReason: resolution.reason });
      return resolution.def;
    },
    nativeTools,
    rustSelfContained,
    shellPath,
    getGithubCredentials: () => {
      // Re-read the config file fresh so token rotation in config.toml is
      // reflected on the next turn. Env fallbacks (GITHUB_TOKEN / GH_TOKEN
      // / GITHUB_API_URL) are applied Rust-side — only the config values
      // cross the boundary here.
      const reloaded = loadRuntimeConfigSafe(resolvedConfig);
      if (reloaded.fileError !== undefined) return undefined;
      const github = reloaded.config.github;
      const token = github?.token;
      const baseUrl = github?.baseUrl;
      if (token === undefined && baseUrl === undefined) return undefined;
      return { token, baseUrl };
    },
    onEngineUnavailable: (detail) => {
      patchEngineExecution({ transport: 'dead', llmFallbackReason: detail });
    },
    onTurnResult: (result) => {
      // The transport is read, never resolved: a status-backed observation
      // must not spawn the stdio child process.
      setEngineExecution({
        rust: true,
        transport: activeEngineMode(),
        llmTransport: result.telemetry?.llmTransport,
        nativeToolCalls: result.telemetry?.nativeToolCallCount,
      });
    },
    getPolicySnapshot: () => {
      const reloaded = loadRuntimeConfigSafe(resolvedConfig);
      if (reloaded.fileError !== undefined) return;
      const cfg = reloaded.config as Record<string, unknown>;
      const perm = cfg['permission'] as Record<string, unknown> | undefined;
      const agent = cfg['agent'] as Record<string, unknown> | undefined;
      const mode = (agent?.['yolo'] === true
        ? 'yolo'
        : (perm?.['mode'] as string) ?? 'manual') as 'manual' | 'auto' | 'yolo';
      const rules = (perm?.['rules'] as Array<{ decision?: string; pattern?: string }>) ?? [];
      const hooks = (cfg['hooks'] as
        | Array<{ event?: string; matcher?: string; command?: string; timeout?: number }>
        | undefined) ?? [];
      return {
        mode,
        deny_rules: rules
          .filter((r) => r.decision === 'deny' && typeof r.pattern === 'string')
          .map((r) => r.pattern!),
        ask_rules: rules
          .filter((r) => r.decision === 'ask' && typeof r.pattern === 'string')
          .map((r) => r.pattern!),
        allow_rules: rules
          .filter((r) => r.decision === 'allow' && typeof r.pattern === 'string')
          .map((r) => r.pattern!),
        // G-6 #6: user-configured external hooks ride the snapshot so the
        // engine can run PreToolUse hooks before native tool calls.
        pre_tool_hooks: hooks
          .filter((h) => typeof h.command === 'string')
          .map((h) => ({
            event: h.event ?? '',
            matcher: h.matcher ?? '',
            command: h.command ?? '',
            timeout: h.timeout,
          })),
      };
    },
  });
  if (engine === undefined) {
    // The gate verified the bundle is loadable, so both transports failing
    // at init means the install is broken — surfaced, never a JS fallback.
    throw new Error(
      '[kimi-agent] rust engine failed to initialize (napi addon unloadable and stdio CLI failed to start) — the TS agent engine is disabled.',
    );
  }
  rustTurnEngine = engine;
  return rustTurnEngine;
}
