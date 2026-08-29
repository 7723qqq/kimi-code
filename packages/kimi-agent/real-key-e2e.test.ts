/**
 * Real-provider end-to-end test for the kimi-agent Rust engine.
 *
 * Drives one real turn through `createRunTurnOverride` with `nativeLlm`
 * set to a live provider (MiniMax-M3 via the minimax-cn-coding-plan
 * anthropic endpoint), exercising the entire native-LLM pipeline:
 * anthropic SSE → run_turn → native tool sandbox → finish_reason mapping
 * → cache token accounting.
 *
 * Skipped unless `KIMI_E2E=1` is exported AND the runtime config has a
 * suitable anthropic/openai provider with a static apiKey. Both are
 * required: a configured provider alone would make every routine
 * `bun run test` — and CI — issue a real billed request. When opted in
 * this reads `~/.kimi-code/config.toml` and uses the same model that
 * powers the agent conversation.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { loadRuntimeConfigSafe } from '@moonshot-ai/kimi-code-sdk';

const HOME = process.env['KIMI_HOME'] ?? join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.kimi-code');
const CFG = join(HOME, 'config.toml');

type NativeLlmDef = {
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  model: string;
};

interface ResolvedProvider {
  alias: string;
  provider: string;
  model: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  /** Override the baseUrl when the provider's stored value doesn't match
   *  kimi-agent's URL construction (which appends `/messages` for anthropic
   *  or `/chat/completions` for openai with no version segment). */
  resolvedBaseUrl: string;
}

/** Find the first model whose provider has a static baseUrl + apiKey and whose
 *  resulting kimi-agent endpoint matches a known-good URL shape. When the
 *  stored baseUrl omits the `/v1` segment that the openai path expects, we
 *  resolve it locally so the test still exercises a real provider. */
function pickProvider(cfg: ReturnType<typeof loadRuntimeConfigSafe>): ResolvedProvider | null {
  const c = cfg.config;
  const alias = c.defaultModel;
  const m = c.models?.[alias];
  if (!m) return null;
  const p = c.providers?.[m.provider];
  if (!p) return null;
  if (!p.baseUrl || !p.apiKey) return null;
  const protocol: 'openai' | 'anthropic' = p.type === 'anthropic' ? 'anthropic' : 'openai';
  let resolvedBaseUrl = p.baseUrl;
  // kimi-agent's openai path appends `/chat/completions` without a `/v1`
  // segment, so the stored baseUrl must already include the version path
  // (e.g. `https://openrouter.ai/api/v1`). If it's bare like
  // `https://api.deepseek.com`, the request would hit the wrong path.
  if (protocol === 'openai' && !/\/v\d+($|\/)/.test(resolvedBaseUrl)) {
    return null;
  }
  // kimi-agent's anthropic path appends `/messages` to baseUrl with no
  // version segment. Reverse-proxy bases that embed a path component
  // (e.g. `…/anthropic`) do not match this expectation and 404. Probe
  // a `/v1` sibling — that's where most reverse proxies (including the
  // minimax anthropic mirror) actually serve the Messages API.
  if (protocol === 'anthropic' && !/^https?:\/\/[^/]+$/.test(resolvedBaseUrl)) {
    resolvedBaseUrl = `${resolvedBaseUrl.replace(/\/$/, '')}/v1`;
  }
  return {
    alias,
    provider: m.provider,
    model: m.model,
    protocol,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey,
    resolvedBaseUrl,
  };
}

function pickAnyProvider(cfg: ReturnType<typeof loadRuntimeConfigSafe>): ResolvedProvider | null {
  // Prefer the default model; otherwise walk models until we find a
  // provider whose stored baseUrl matches the engine's URL construction.
  const c = cfg.config;
  const order = [
    c.defaultModel,
    ...Object.keys(c.models ?? {}),
  ];
  for (const alias of order) {
    if (!alias) continue;
    const candidate = (() => {
      const m = c.models?.[alias];
      if (!m) return null;
      const p = c.providers?.[m.provider];
      if (!p) return null;
      if (!p.baseUrl || !p.apiKey) return null;
      const protocol: 'openai' | 'anthropic' = p.type === 'anthropic' ? 'anthropic' : 'openai';
      const resolvedBaseUrl = p.baseUrl;
      if (protocol === 'openai' && !/\/v\d+($|\/)/.test(resolvedBaseUrl)) return null;
      if (protocol === 'anthropic' && !/^https?:\/\/[^/]+$/.test(resolvedBaseUrl)) return null;
      return { alias, provider: m.provider, model: m.model, protocol, baseUrl: p.baseUrl, apiKey: p.apiKey, resolvedBaseUrl };
    })();
    if (candidate) return candidate;
  }
  return null;
}

const cfg = existsSync(CFG) ? loadRuntimeConfigSafe(CFG) : null;
const picked = cfg && cfg.fileError === undefined ? pickAnyProvider(cfg) : null;

// A live provider in the local config is NOT by itself consent to spend
// money: `bun run test` is run routinely and in CI, and this turn issues a
// real billed request. Opt in explicitly, matching the e2e convention
// elsewhere in the repo.
const optedIn = process.env['KIMI_E2E'] === '1';

describe.skipIf(!optedIn || !picked)('real-key E2E — native LLM via kimi-agent', () => {
  const provider = picked!;
  const maskedKey = `${provider.apiKey.slice(0, 6)}…${provider.apiKey.slice(-4)}`;

  it(
    `runs one Read turn through the Rust engine against ${provider.alias}`,
    { timeout: 60_000 },
    async () => {
    const { createRunTurnOverride } = await import('./rust-loop');

    const workspace = join(tmpdir(), `kimi-real-e2e-${Date.now()}`);
    mkdirSync(workspace, { recursive: true });
    const target = join(workspace, 'hello.txt');
    writeFileSync(target, 'hello from native test\n');

    const engine = createRunTurnOverride(
      undefined,
      workspace,
      {
        nativeTools: true,
        nativeLlm: () => ({
          protocol: provider.protocol,
          base_url: provider.resolvedBaseUrl,
          api_key: provider.apiKey,
          model: provider.model,
        }),
        shellPath: undefined,
      },
    );
    expect(engine).toBeDefined();

    const events: Array<{ type: string }> = [];
    const input = {
      turnId: Date.now(),
      signal: new AbortController().signal,
      llm: {
        modelName: provider.model,
        systemPrompt: 'You are a careful test driver. Use the Read tool when asked to inspect a file.',
      },
      async buildMessages() {
        return [
          {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: 'Read hello.txt and report its exact contents verbatim.' }],
          },
        ];
      },
      buildTools() {
        return [
          {
            name: 'Read',
            description: 'Read a file inside the workspace.',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        ] as Array<{ name: string; description: string; parameters: unknown }>;
      },
      async dispatchEvent(event: { type: string }) {
        events.push({ type: event.type });
      },
      async executeTool() {
        // host fallback path should not trigger for native Read
        return { output: 'UNREACHABLE host fallback', isError: true };
      },
      async checkToolPermission() {
        return { decision: 'allow' as const };
      },
    };

    const t0 = performance.now();
    const result = await (engine as (i: typeof input) => Promise<{
      stopReason: string;
      steps: number;
      usage: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number };
      telemetry?: { eventsEmitted: number; llmRetries: number };
    }>)(input);
    const elapsedMs = Math.round(performance.now() - t0);

    // Result sanity
    expect(result.stopReason).toMatch(/^(completed|truncated|other)$/);
    expect(result.steps).toBeGreaterThanOrEqual(1);

    // The provider must have actually been called (cache_read/creation or
    // input tokens non-zero; the host fallback must NOT have run).
    const sawContent = result.usage.inputOther > 0 || result.usage.inputCacheRead > 0;
    expect(sawContent).toBe(true);
    expect(result.usage.output).toBeGreaterThan(0);
    expect(events.some((e) => e.type === 'tool.call')).toBe(true);
    expect(events.some((e) => e.type === 'tool.result')).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      `[real-e2e] ${provider.alias} (${provider.protocol}) — ` +
        `stopReason=${result.stopReason} steps=${result.steps} ` +
        `usage{in=${result.usage.inputOther} out=${result.usage.output} ` +
        `cache_read=${result.usage.inputCacheRead} cache_creation=${result.usage.inputCacheCreation}} ` +
        `telemetry{events=${result.telemetry?.eventsEmitted} retries=${result.telemetry?.llmRetries}} ` +
        `latency=${elapsedMs}ms key=${maskedKey}`,
    );

    rmSync(workspace, { recursive: true, force: true });
  });
});
