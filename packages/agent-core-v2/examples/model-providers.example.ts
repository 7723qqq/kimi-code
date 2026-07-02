/**
 * Scenario: the **Provider / Platform / Protocol / Model** slice, driven from
 * a real `~/.kimi-code/config.toml` and its credentials, and exercised through
 * the new `IModelResolver` → `Model` god-object path introduced in the
 * "Model god-object and protocol domains" change.
 *
 * Goals of this example:
 *  1. **Sandbox the real config.** At runtime, copy `~/.kimi-code/config.toml`
 *     and `~/.kimi-code/credentials/` into the per-run `KIMI_CODE_HOME` the
 *     example harness provisions (`.vitest-results/kimi-code-{ts}/`). The real
 *     home is never read or written directly — even an OAuth token refresh
 *     lands in the sandbox copy.
 *  2. **List everything.** Enumerate every `[providers.*]`, `[platforms.*]`,
 *     supported `Protocol`, and `[models.*]` entry, then resolve each Model id
 *     through `IModelResolver` and report whether it produces a runnable
 *     `Model` (protocol, base URL, auth mode) — a concrete compatibility
 *     matrix for the new god-object resolver.
 *  3. **Ping every Model.** Send a "ping" → expect a streamed response
 *     against **every** Model that resolved (bounded concurrency, per-request
 *     timeout), and report which ones actually answer — an end-to-end reachability
 *     check for the whole configured catalogue, not just the default model.
 *
 * All Services come from `src/`; nothing here defines a new Service.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import '#/index';

import { type Scope, type ScopeSeed } from '#/_base/di/scope';
import { bootstrap } from '#/app/bootstrap';
import { IConfigService } from '#/app/config';
import { createUserMessage, isContentPart, type TokenUsage } from '#/app/llmProtocol';
import { IModelResolver, IModelService, type Model, type ModelConfig } from '#/app/model';
import { IPlatformService } from '#/app/platform';
import { IProviderService, type ProviderConfig } from '#/app/provider';
import { IProtocolAdapterRegistry } from '#/app/protocol';
import { ILogOptions, resolveLoggingConfig } from '#/app/log/logConfig';

const PER_REQUEST_TIMEOUT_MS = 30_000;
const PING_CONCURRENCY = 4;
const ALL_MODELS_TEST_TIMEOUT_MS = 300_000;

interface ModelReport {
  readonly id: string;
  readonly name?: string;
  readonly protocol?: string;
  readonly baseUrl?: string;
  readonly authMode: string;
  readonly resolved: boolean;
  readonly error?: string;
}

describe('model / provider / platform / protocol slice (resolved from a sandboxed ~/.kimi-code)', () => {
  let app: Scope | undefined;
  let sandboxHome = '';
  let configCopied = false;
  let credentialsCopied = 0;
  let reports: readonly ModelReport[] = [];
  let useRealHome = false;

  beforeAll(() => {
    useRealHome = process.env['KIMI_CODE_EXAMPLE_USE_REAL_HOME'] === '1';
    sandboxHome = useRealHome ? join(homedir(), '.kimi-code') : resolveSandboxHome();
    if (useRealHome) {
      // Run directly against the real home so OAuth token refresh can read AND
      // write back the real credentials. Read-only for config — this example
      // never calls IConfigService.set/replace.
      configCopied = true;
      credentialsCopied = 0;
    } else {
      const mirror = mirrorRealKimiHome(sandboxHome);
      configCopied = mirror.configCopied;
      credentialsCopied = mirror.credentialsCopied;
    }

    const logSeed: ScopeSeed = [
      [ILogOptions, resolveLoggingConfig({ homeDir: sandboxHome, env: process.env })],
    ];
    app = bootstrap({ homeDir: sandboxHome }, logSeed).app;
  });

  afterAll(() => app?.dispose());

  test('lists every Provider / Platform / Protocol and resolves every Model', async () => {
    const host = requireApp(app);
    const config = host.accessor.get(IConfigService);
    await config.ready;

    const providers = host.accessor.get(IProviderService);
    const platforms = host.accessor.get(IPlatformService);
    const models = host.accessor.get(IModelService);
    const resolver = host.accessor.get(IModelResolver);
    const protocols = host.accessor.get(IProtocolAdapterRegistry);

    // Touch each registry so its config section is registered before we read.
    const providerMap = providers.list();
    const platformMap = platforms.list();
    const modelMap = models.list();
    const supportedProtocols = protocols.supportedProtocols();

    console.log(`\nhome:                ${sandboxHome}${useRealHome ? ' (REAL ~/.kimi-code)' : ' (sandbox copy)'}`);
    console.log(`config.toml copied:  ${useRealHome ? 'n/a (using real)' : configCopied}`);
    console.log(`credentials copied:  ${useRealHome ? 'n/a (using real)' : credentialsCopied}`);
    console.log(`\nsupported protocols: ${supportedProtocols.join(', ') || '(none)'}`);

    console.log(`\n[providers.*] (${Object.keys(providerMap).length}):`);
    for (const [id, p] of Object.entries(providerMap)) {
      console.log(`  - ${id}: type=${p.type ?? '-'} baseUrl=${p.baseUrl ?? '-'} auth=${providerAuthMode(p)} platform=${p.platformId ?? '-'}`);
    }

    console.log(`\n[platforms.*] (${Object.keys(platformMap).length}):`);
    if (Object.keys(platformMap).length === 0) console.log('  (none configured)');
    for (const [id, pl] of Object.entries(platformMap)) {
      const auth = pl.auth?.apiKey !== undefined ? 'apiKey' : pl.auth?.oauth !== undefined ? 'oauth' : pl.auth?.env !== undefined ? 'env' : '-';
      console.log(`  - ${id}: auth=${auth} displayName=${pl.displayName ?? '-'}`);
    }

    reports = Object.entries(modelMap).map(([id, m]) => resolveOne(id, m, providerMap, resolver));

    console.log(`\n[models.*] (${reports.length}) — resolve compatibility:`);
    for (const r of reports) {
      const head = r.resolved ? 'OK ' : 'FAIL';
      const detail = r.resolved
        ? `protocol=${r.protocol} baseUrl=${r.baseUrl} auth=${r.authMode} name=${r.name}`
        : `auth=${r.authMode} error=${r.error}`;
      console.log(`  [${head}] ${r.id} → ${detail}`);
    }

    // The example is meaningful even on a machine without the real config: it
    // simply reports an empty registry instead of failing.
    if (!configCopied) {
      console.log('\n(no ~/.kimi-code/config.toml found — reporting an empty registry)');
      return;
    }

    expect(Object.keys(providerMap).length).toBeGreaterThan(0);
    expect(reports.length).toBeGreaterThan(0);
    // Every configured Model must at least resolve into a god-object; a
    // resolution failure here is a real compatibility regression.
    const failures = reports.filter((r) => !r.resolved);
    expect(
      failures,
      `models that failed to resolve: ${failures.map((f) => `${f.id}(${f.error})`).join(', ')}`,
    ).toEqual([]);
  });

  test('sends a ping → pong request through EVERY resolvable Model', async () => {
    const host = requireApp(app);
    if (!configCopied || reports.length === 0) {
      console.log('skipped: no ~/.kimi-code/config.toml or no models configured');
      return;
    }

    const resolver = host.accessor.get(IModelResolver);
    const candidates = reports.filter((r) => r.resolved);
    if (candidates.length === 0) {
      console.log('skipped: no resolvable models');
      return;
    }

    console.log(
      `\npinging ${candidates.length} resolvable models ` +
        `(concurrency=${PING_CONCURRENCY}, per-request timeout=${PER_REQUEST_TIMEOUT_MS}ms):`,
    );

    const outcomes = await mapPool(candidates, PING_CONCURRENCY, async (report) => {
      const model = resolver.resolve(report.id);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT_MS);
      try {
        const result = await collectResponse(model, controller.signal);
        return {
          report,
          ok: true as const,
          text: result.text,
          finishReason: result.finishReason,
        };
      } catch (error) {
        return {
          report,
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timer);
      }
    });

    for (const o of outcomes) {
      if (o.ok) {
        console.log(
          `  [OK  ] ${o.report.id} → ${JSON.stringify(truncate(o.text, 40))} ` +
            `(finish=${o.finishReason ?? '-'})`,
        );
      } else {
        console.log(`  [FAIL] ${o.report.id} → ${truncate(o.error, 140)}`);
      }
    }

    const passed = outcomes.filter((o) => o.ok).length;
    console.log(`\nping-pong summary: ${passed}/${outcomes.length} models responded.`);

    const failed = outcomes.filter((o) => !o.ok);
    expect(
      failed,
      `models that failed to respond: ${failed.map((f) => `${f.report.id}(${f.error})`).join(', ')}`,
    ).toEqual([]);
  }, ALL_MODELS_TEST_TIMEOUT_MS);
});

function resolveOne(
  id: string,
  model: ModelConfig,
  providers: Readonly<Record<string, ProviderConfig>>,
  resolver: IModelResolver,
): ModelReport {
  const authMode = modelAuthMode(model, providers);
  try {
    const resolved = resolver.resolve(id);
    return {
      id,
      name: resolved.name,
      protocol: resolved.protocol,
      baseUrl: resolved.baseUrl,
      authMode,
      resolved: true,
    };
  } catch (error) {
    return {
      id,
      name: model.name ?? model.model,
      authMode,
      resolved: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Mirror the resolver's auth-precedence to label where each Model's
 *  credential comes from, without ever reading the secret itself. */
function modelAuthMode(
  model: ModelConfig,
  providers: Readonly<Record<string, ProviderConfig>>,
): string {
  if (model.apiKey !== undefined && model.apiKey.length > 0) return 'model.apiKey';
  if (model.oauth !== undefined) return 'model.oauth';
  const providerId = model.providerId ?? model.provider;
  const provider = providerId === undefined ? undefined : providers[providerId];
  const platformId = provider?.platformId;
  if (platformId !== undefined && platformId !== '__unknown__') {
    return `platform(${platformId})`;
  }
  if (provider?.apiKey !== undefined && provider.apiKey.length > 0) return 'provider.apiKey';
  if (provider?.oauth !== undefined) return 'provider.oauth';
  return 'none';
}

function providerAuthMode(provider: ProviderConfig): string {
  if (provider.apiKey !== undefined && provider.apiKey.length > 0) return 'apiKey';
  if (provider.oauth !== undefined) return 'oauth';
  if (provider.platformId !== undefined) return `platform(${provider.platformId})`;
  if (provider.env !== undefined) return 'env';
  return 'none';
}

async function collectResponse(
  model: Model,
  signal: AbortSignal,
): Promise<{ text: string; finishReason?: string; usage?: TokenUsage }> {
  let text = '';
  let think = '';
  let finishReason: string | undefined;
  let usage: TokenUsage | undefined;

  const stream = model.request(
    {
      systemPrompt:
        'You are a connectivity check. The user will say "ping". Reply with the single word: pong',
      tools: [],
      messages: [createUserMessage('ping')],
    },
    signal,
  );

  for await (const event of stream) {
    if (event.type === 'part') {
      const part = event.part;
      if (isContentPart(part) && part.type === 'text') text += part.text;
      else if (isContentPart(part) && part.type === 'think') think += part.think;
    } else if (event.type === 'usage') {
      usage = event.usage;
    } else if (event.type === 'finish') {
      finishReason = event.rawFinishReason ?? event.providerFinishReason;
    }
  }
  // Thinking models may put the answer in `think`; surface whichever carried
  // content so the report shows what came back.
  return { text: text.trim().length > 0 ? text : think, finishReason, usage };
}

/** Run `fn` over `items` with at most `size` in flight, preserving order. */
async function mapPool<T, R>(
  items: readonly T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

function truncate(s: string, max: number): string {
  const oneLine = s.replaceAll(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function resolveSandboxHome(): string {
  const fromEnv = process.env['KIMI_CODE_HOME'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  // Fallback for running this file outside the example harness: mirror into a
  // fresh temp dir so the real home is still never touched.
  const dir = join(homedir(), '.kimi-code-example-sandbox');
  mkdirSync(dir, { recursive: true });
  process.env['KIMI_CODE_HOME'] = dir;
  return dir;
}

/** Copy `~/.kimi-code/config.toml` and `~/.kimi-code/credentials/*` into the
 *  sandbox home. Never reads credential contents — only copies bytes. */
function mirrorRealKimiHome(sandboxHome: string): {
  configCopied: boolean;
  credentialsCopied: number;
} {
  const realHome = join(homedir(), '.kimi-code');
  let configCopied = false;
  const srcConfig = join(realHome, 'config.toml');
  if (existsSync(srcConfig)) {
    copyFileSync(srcConfig, join(sandboxHome, 'config.toml'));
    configCopied = true;
  }

  let credentialsCopied = 0;
  const srcCreds = join(realHome, 'credentials');
  if (existsSync(srcCreds) && statSync(srcCreds).isDirectory()) {
    const dstCreds = join(sandboxHome, 'credentials');
    mkdirSync(dstCreds, { recursive: true });
    for (const entry of readdirSync(srcCreds)) {
      const src = join(srcCreds, entry);
      if (statSync(src).isFile()) {
        copyFileSync(src, join(dstCreds, entry));
        credentialsCopied++;
      }
    }
  }
  return { configCopied, credentialsCopied };
}

function requireApp(app: Scope | undefined): Scope {
  if (app === undefined) throw new Error('App scope was not initialized in beforeAll');
  return app;
}
