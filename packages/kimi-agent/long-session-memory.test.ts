/**
 * P20-C: long-session memory growth regression baseline.
 *
 * Runs `TURN_COUNT` consecutive native-LLM turns through the Rust engine,
 * each driving a single Read tool call. After every turn samples
 * `process.memoryUsage().rss` (Bun process RSS = napi addon RSS) and
 * per-turn elapsed wall-clock. The collected samples are the first
 * baseline for this project — a hard threshold is intentionally not
 * asserted so the first run establishes the line; subsequent runs
 * (and CI) can compare against the recorded baseline.
 *
 * Skipped unless `KIMI_E2E=1` AND the runtime config has a usable
 * provider. Issues `TURN_COUNT` real billed requests when opted in.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { loadRuntimeConfigSafe } from '@moonshot-ai/kimi-code-sdk';

import { simulateUiDispatch } from './_simulate-ui-dispatch';

const HOME = process.env['KIMI_HOME'] ?? join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.kimi-code');
const CFG = join(HOME, 'config.toml');
const TURN_COUNT = 20;

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
  resolvedBaseUrl: string;
  apiKey: string;
}

function resolveKimiAgentBaseUrl(protocol: 'openai' | 'anthropic', baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  if (/\/v\d+($|\/)/.test(trimmed)) return trimmed;
  if (protocol === 'openai') return `${trimmed}/v1`;
  return /^https?:\/\/[^/]+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function pickAnyProvider(c: ReturnType<typeof loadRuntimeConfigSafe>['config']): ResolvedProvider | null {
  // Prefer anthropic providers over openai (kimi-agent's native-LLM
  // exercise path is most stable on anthropic). P20-A and P20-B both
  // hard-pin the minimax anthropic provider for this reason — the
  // default_model can point to a free-tier model that is unavailable
  // or rate-limited, which would mask memory regressions behind a
  // transport error.
  const candidates: Array<{ alias: string; entry: { provider: string; model: string } }> = [];
  if (c.defaultModel) {
    const entry = c.models?.[c.defaultModel];
    if (entry) candidates.push({ alias: c.defaultModel, entry });
  }
  for (const [alias, entry] of Object.entries(c.models ?? {})) {
    if (alias === c.defaultModel) continue;
    candidates.push({ alias, entry });
  }
  // Reorder: anthropic first, openai second.
  candidates.sort((a, b) => {
    const aProto = c.providers?.[a.entry.provider]?.type === 'anthropic' ? 0 : 1;
    const bProto = c.providers?.[b.entry.provider]?.type === 'anthropic' ? 0 : 1;
    return aProto - bProto;
  });
  for (const { alias, entry } of candidates) {
    if (!alias || !entry) continue;
    const p = c.providers?.[entry.provider];
    if (!p?.baseUrl || !p?.apiKey) continue;
    const protocol: 'openai' | 'anthropic' = p.type === 'anthropic' ? 'anthropic' : 'openai';
    return {
      alias,
      provider: entry.provider,
      model: entry.model,
      protocol,
      resolvedBaseUrl: resolveKimiAgentBaseUrl(protocol, p.baseUrl),
      apiKey: p.apiKey,
    };
  }
  return null;
}

const cfg = existsSync(CFG) ? loadRuntimeConfigSafe(CFG) : null;
const picked = cfg && cfg.fileError === undefined ? pickAnyProvider(cfg.config) : null;
const optedIn = process.env['KIMI_E2E'] === '1';
console.log('[diag-long-session] optedIn =', optedIn, 'picked =', picked?.alias ?? null, 'path =', CFG);

interface TurnSample {
  turn: number;
  rssBytes: number;
  heapBytes: number;
  externalBytes: number;
  elapsedMs: number;
  outputTokens: number;
}

describe.skipIf(!optedIn || !picked)('long-session memory growth (P20-C)', () => {
  const provider = picked!;
  const maskedKey = `${provider.apiKey.slice(0, 4)}…${provider.apiKey.slice(-2)}`;

  it(
    `runs ${TURN_COUNT} consecutive native-LLM turns and reports per-turn RSS`,
    { timeout: 300_000 },
    async () => {
      const { createRunTurnOverride } = await import('./rust-loop');

      const workspace = join(tmpdir(), `kimi-long-session-${Date.now()}`);
      mkdirSync(workspace, { recursive: true });
      for (let i = 1; i <= TURN_COUNT; i += 1) {
        writeFileSync(join(workspace, `f${i}.txt`), `content of file ${i}\n`);
      }

      const samples: TurnSample[] = [];
      const tStart = performance.now();

      for (let i = 1; i <= TURN_COUNT; i += 1) {
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

        const turnStart = performance.now();
        const events: Array<{ type: string; at: number }> = [];
        const result = await (engine as (i: unknown) => Promise<{
          stopReason: string;
          steps: number;
          usage: { output: number };
        }>)({
          turnId: `${Date.now()}-${i}`,
          signal: new AbortController().signal,
          llm: {
            modelAlias: provider.alias,
            modelId: provider.model,
            systemPrompt: 'You are a careful test driver. When asked to read a file, use the Read tool to inspect it.',
          },
          async buildMessages() {
            return [
              {
                role: 'user' as const,
                content: [
                  {
                    type: 'text' as const,
                    text: `Read the file f${i}.txt and report its exact contents verbatim.`,
                  },
                ],
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
            await simulateUiDispatch(event, events);
          },
          async executeTool() {
            return { output: 'UNREACHABLE host fallback', isError: true };
          },
          async checkToolPermission() {
            return { decision: 'allow' as const };
          },
        });
        const elapsedMs = performance.now() - turnStart;

        // Sample memory after the turn resolves. process.memoryUsage().rss
        // is the Bun process's resident set size; the napi addon lives in
        // the same address space, so any growth attributable to the engine
        // shows up here.
        const mem = process.memoryUsage();
        samples.push({
          turn: i,
          rssBytes: mem.rss,
          heapBytes: mem.heapUsed,
          externalBytes: mem.external,
          elapsedMs,
          outputTokens: result.usage.output,
        });

        // Sanity: every turn should complete with a Read tool call landing
        // natively (host fallback would have surfaced an UNREACHABLE error
        // in the tool result). We only assert completion; the per-turn
        // tool call is opportunistic (the LLM may sometimes reply with
        // text directly when the file content is short).
        expect(result.stopReason).toMatch(/^(completed|truncated|other)$/);
        expect(result.usage.output).toBeGreaterThan(0);
      }

      const totalMs = performance.now() - tStart;
      const rssFirst = samples[0]!.rssBytes;
      const rssLast = samples[samples.length - 1]!.rssBytes;
      const rssGrowthPct = ((rssLast - rssFirst) / rssFirst) * 100;
      const med = (xs: number[]): number => {
        const s = [...xs].sort((a, b) => a - b);
        return s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
      };
      const elapsed = samples.map((s) => s.elapsedMs);
      const heapDelta = samples[samples.length - 1]!.heapBytes - samples[0]!.heapBytes;

      // eslint-disable-next-line no-console
      console.log(
        `\n[long-session] ${provider.alias} (${maskedKey}) — ${TURN_COUNT} turns in ${totalMs.toFixed(0)}ms\n` +
          `  rss first=${(rssFirst / 1e6).toFixed(1)}MB last=${(rssLast / 1e6).toFixed(1)}MB growth=${rssGrowthPct.toFixed(1)}%\n` +
          `  heap first=${(samples[0]!.heapBytes / 1e6).toFixed(1)}MB last=${(samples[samples.length - 1]!.heapBytes / 1e6).toFixed(1)}MB delta=${(heapDelta / 1e6).toFixed(1)}MB\n` +
          `  per-turn elapsed: med=${med(elapsed).toFixed(0)}ms min=${Math.min(...elapsed).toFixed(0)}ms max=${Math.max(...elapsed).toFixed(0)}ms\n` +
          `  per-turn rss (MB): ${samples.map((s) => (s.rssBytes / 1e6).toFixed(1)).join(', ')}\n` +
          `  per-turn elapsed (ms): ${samples.map((s) => s.elapsedMs.toFixed(0)).join(', ')}`,
      );

      // No hard threshold: this run is the baseline. Future runs / CI can
      // assert a tighter bound. We do require all turns to complete and
      // emit real output, and require the run to finish in a sane envelope.
      expect(samples).toHaveLength(TURN_COUNT);
      expect(totalMs).toBeLessThan(300_000);

      rmSync(workspace, { recursive: true, force: true });
    },
  );
});
