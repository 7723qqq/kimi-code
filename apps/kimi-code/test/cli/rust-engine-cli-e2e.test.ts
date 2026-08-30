/**
 * Real CLI consumer-path integration: `maybeLoadRustEngine` is the function
 * `apps/kimi-code/src/cli/{run-shell,run-v2-print}.ts` call to wire the Rust
 * engine into the loop. This test builds a temp config that selects
 * `agent.engine = "rust"` from the user's own default provider, drives one
 * turn, and asserts a result comes back through the full consumer wiring
 * (config → maybeLoadRustEngine → createRunTurnOverride → adapter → engine).
 *
 * Skipped unless `KIMI_E2E=1` is exported AND a loadable napi addon AND a
 * static-key provider exist. A configured provider alone is not consent to
 * spend money: this turn issues a real billed request, and the suite runs
 * routinely and in CI.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { shutdownRustEngine } from '@moonshot-ai/kimi-agent/rust-loop';

const kimiAgentDir = resolve(import.meta.dirname, '../../../../packages/kimi-agent');

const hasNativeAddon = (() => {
  // The napi build emits a platform-suffixed name (kimi_agent.<os>-<arch>.node),
  // so glob the package root instead of pinning one filename.
  try {
    return readdirSync(kimiAgentDir).some(
      (entry) => entry.endsWith('.node') && entry.startsWith('kimi_agent'),
    );
  } catch {
    return false;
  }
})();

interface HostedModel {
  provider: string;
  type: string;
  apiKey: string;
  baseUrl: string;
  alias: string;
  model: string;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function modelBlock(text: string, alias: string): string | undefined {
  return text.match(
    new RegExp(`\\[models\\."?${escapeRe(alias)}"?\\]([\\s\\S]*?)(?=\\n\\[|$)`),
  )?.[1];
}

/** Pull the session's own default model out of the user's config so the test
 *  drives a live provider without committing any credentials to the repo.
 *  Only static-key openai/kimi providers qualify — OAuth-managed providers
 *  have no key to write into the temp config. */
function readHostedModel(): HostedModel | undefined {
  const userHome = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
  const cfgPath = join(userHome, '.kimi-code', 'config.toml');
  if (!existsSync(cfgPath)) return undefined;
  const text = readFileSync(cfgPath, 'utf8');
  const alias = text.match(/^default_model\s*=\s*"([^"]+)"/m)?.[1];
  if (!alias) return undefined;
  const modelSection = modelBlock(text, alias);
  const provider = modelSection?.match(/^provider\s*=\s*"([^"]+)"/m)?.[1];
  const model = modelSection?.match(/^model\s*=\s*"([^"]+)"/m)?.[1];
  if (!provider || !model) return undefined;
  const providerBlock = text.match(
    new RegExp(`\\[providers\\."?${escapeRe(provider)}"?\\]([\\s\\S]*?)(?=\\n\\[|$)`),
  )?.[1];
  if (!providerBlock) return undefined;
  const type = providerBlock.match(/^type\s*=\s*"([^"]+)"/m)?.[1];
  const apiKey = providerBlock.match(/^api_key\s*=\s*"([^"]+)"/m)?.[1];
  const baseUrl = providerBlock.match(/^base_url\s*=\s*"([^"]+)"/m)?.[1];
  if (!apiKey || !baseUrl) return undefined;
  if (type !== 'openai' && type !== 'kimi') return undefined;
  return { provider, type, apiKey, baseUrl, alias, model };
}

const hosted = readHostedModel();
const optedIn = process.env['KIMI_E2E'] === '1';

describe.skipIf(!optedIn || !hasNativeAddon || !hosted)(
  'CLI consumer integration — maybeLoadRustEngine',
  () => {
    const host = hosted as HostedModel;
    const cleanups: string[] = [];

    afterEach(() => {
      shutdownRustEngine();
      for (const dir of cleanups.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it(
      'drives one turn through the real CLI wiring',
      { timeout: 60_000 },
      async () => {
        const homeDir = mkdtempSync(join(tmpdir(), 'kimi-cli-e2e-'));
        cleanups.push(homeDir);
        writeFileSync(
          join(homeDir, 'config.toml'),
          [
            `default_model = "${host.alias}"`,
            '',
            `[providers."${host.provider}"]`,
            `type = "${host.type}"`,
            `api_key = "${host.apiKey}"`,
            `base_url = "${host.baseUrl}"`,
            '',
            `[models."${host.alias}"]`,
            `provider = "${host.provider}"`,
            `model = "${host.model}"`,
            'max_context_size = 200000',
            '',
            '[agent]',
            'engine = "rust"',
          ].join('\n'),
        );

        const { maybeLoadRustEngine } = await import('../../src/cli/rust-engine');
        const engine = await maybeLoadRustEngine(homeDir);
        expect(engine).toBeDefined();
        expect(typeof engine).toBe('function');

        const events: string[] = [];
        const input = {
          turnId: 1,
          signal: new AbortController().signal,
          llm: {
            modelAlias: host.alias,
            modelId: host.model,
            systemPrompt: 'Answer with exactly the word ok.',
            // Only consulted when the engine proxies the LLM through the host;
            // a native-LLM turn calls the provider itself.
            async chat() {
              return {
                toolCalls: [],
                providerFinishReason: 'stop',
                content: 'ok',
                usage: { inputOther: 8, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
              };
            },
          },
          async buildMessages() {
            return [
              {
                role: 'user' as const,
                content: [{ type: 'text' as const, text: 'Reply with exactly: ok' }],
              },
            ];
          },
          buildTools() {
            return [];
          },
          async dispatchEvent(e: { type: string }) {
            events.push(e.type);
          },
          // Only reached when the engine routes a tool call back to the host;
          // a native-LLM turn with no tool calls never invokes it.
          async executeTool() {
            return { output: JSON.stringify({}), isError: false };
          },
        };

        // The test input is a minimal stand-in for the v2 TurnEngineInput
        // contract; assert the engine only through the call shape we need.
        const result = await (
          engine as (i: unknown) => Promise<{
            stopReason: string;
            steps: number;
            usage: { inputOther: number; output: number };
            telemetry?: { eventsEmitted: number; llmRetries: number };
          }>
        )(input);

        expect(result.stopReason).toBe('completed');
        expect(result.steps).toBeGreaterThanOrEqual(1);
        expect(result.usage.output).toBeGreaterThan(0);
        expect(events.length).toBeGreaterThan(0);
        expect(result.telemetry?.eventsEmitted ?? 0).toBeGreaterThan(0);
      },
    );
  },
);
