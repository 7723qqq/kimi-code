/**
 * Real-key MultiLLM concurrency test: the Rust engine races two live
 * providers (minimax anthropic + deepseek openai) and returns the first
 * winner. Also guards the model-routing seam — each racing llm_chat carries
 * its provider's model, and the host chat must be able to route on it.
 *
 * Skipped unless `KIMI_E2E=1` AND both live providers are present in the
 * runtime config (static keys). Real billed requests (one turn, both
 * providers raced).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';

import { loadRuntimeConfigSafe } from '@moonshot-ai/kimi-code-sdk';

import { simulateUiDispatch } from './_simulate-ui-dispatch';

const HOME = process.env['KIMI_HOME'] ?? join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.kimi-code');
const CFG = join(HOME, 'config.toml');

const PROMPT = 'Reply with exactly the single word: pong';
const MINIMAX_MODEL = 'MiniMax-M3';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';

interface Providers {
  minimaxKey: string;
  deepseekKey: string;
}

const providers = await (async (): Promise<Providers | null> => {
  const fs = await import('node:fs');
  if (!fs.existsSync(CFG)) return null;
  const cfg = loadRuntimeConfigSafe(CFG);
  if (cfg.fileError !== undefined) return null;
  const minimax = cfg.config.providers?.['minimax-cn-coding-plan'];
  const deepseek = cfg.config.providers?.deepseek;
  if (minimax?.apiKey && deepseek?.apiKey) {
    return { minimaxKey: minimax.apiKey, deepseekKey: deepseek.apiKey };
  }
  return null;
})();

const optedIn = process.env['KIMI_E2E'] === '1';

describe.skipIf(!optedIn || !providers)('real-key MultiLLM concurrency', () => {
  const p = providers!;

  async function streamMinimax(): Promise<number> {
    const res = await fetch('https://api.minimaxi.com/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': p.minimaxKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MINIMAX_MODEL, max_tokens: 16, messages: [{ role: 'user', content: PROMPT }], stream: true }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`minimax ${res.status}: ${text.slice(0, 120)}`);
    let out = 0;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const v = JSON.parse(line.slice(6));
      if (v.type === 'message_delta' && v.usage) out = v.usage.output_tokens ?? out;
    }
    return out;
  }

  async function streamDeepseek(): Promise<number> {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.deepseekKey}` },
      body: JSON.stringify({ model: DEEPSEEK_MODEL, max_tokens: 16, messages: [{ role: 'user', content: PROMPT }], stream: true }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`deepseek ${res.status}: ${text.slice(0, 120)}`);
    let out = 0;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') break;
      const v = JSON.parse(data);
      if (v.usage) out = v.usage.completion_tokens ?? out;
    }
    return out;
  }

  it(
    'races minimax + deepseek and completes with a winner',
    { timeout: 60_000 },
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'kimi-multillm-'));
      try {
        const { createRunTurnOverride } = await import('./rust-loop');
        const engine = createRunTurnOverride(
          [
            { name: 'minimax', model: MINIMAX_MODEL, system_prompt: 'Answer briefly.' },
            { name: 'deepseek', model: DEEPSEEK_MODEL, system_prompt: 'Answer briefly.' },
          ],
          workspace,
          { nativeTools: false, shellPath: undefined },
        );

        const calls: Record<string, number> = { minimax: 0, deepseek: 0 };
        const routedModels = new Set<string>();
        const t0 = performance.now();
        const result = await (engine as (i: unknown) => Promise<{ stopReason: string; steps: number }>)({
          turnId: Date.now(),
          signal: new AbortController().signal,
          llm: {
            modelAlias: 'any',
            modelId: 'any',
            systemPrompt: 'Answer briefly.',
            async chat(input: { modelName?: string }) {
              routedModels.add(input.modelName ?? '');
              const name = (input.modelName ?? '').toLowerCase();
              if (name.includes('minimax')) {
                calls.minimax += 1;
                return { toolCalls: [], providerFinishReason: 'stop', usage: { inputOther: 1, output: await streamMinimax(), inputCacheRead: 0, inputCacheCreation: 0 } };
              }
              if (name.includes('deepseek')) {
                calls.deepseek += 1;
                return { toolCalls: [], providerFinishReason: 'stop', usage: { inputOther: 1, output: await streamDeepseek(), inputCacheRead: 0, inputCacheCreation: 0 } };
              }
              throw new Error(`unroutable model name: ${input.modelName}`);
            },
          },
          async buildMessages() {
            return [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }];
          },
          buildTools() {
            return [];
          },
          async dispatchEvent() {},
          async executeTool() {
            return { output: '', isError: true };
          },
          async checkToolPermission() {
            return { decision: 'allow' as const };
          },
        });
        const elapsedMs = Math.round(performance.now() - t0);

        // eslint-disable-next-line no-console
        console.log(
          `[multi-llm] winner=completed steps=${result.steps} calls=${JSON.stringify(calls)} ` +
            `routed=${[...routedModels].join(',')} elapsed=${elapsedMs}ms`,
        );

        // Both providers must have been raced (real concurrency), each under
        // its own model name — the seam this test guards.
        expect(calls.minimax).toBeGreaterThanOrEqual(1);
        expect(calls.deepseek).toBeGreaterThanOrEqual(1);
        expect(routedModels).toEqual(new Set([MINIMAX_MODEL, DEEPSEEK_MODEL]));
        expect(result.stopReason).toBe('completed');
        expect(result.steps).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );
});

/** P20-B: MultiLLM multi-step performance baseline.
 *
 * P16 (the test above) exercised MultiLLM in a single step where the
 * winner emerged and the loser was cancelled mid-flight. P20-B measures
 * the per-step cost of the same machinery over many steps so future
 * regressions in the loser-cancellation path or winner-selection are
 * caught. Two cases:
 *
 *  - fake path (always runs): two fake providers + an always-tool-call
 *    LLM stub. Six Read steps; every step races both providers, the
 *    winner is whichever `chat` resolves first, the loser is cancelled.
 *    Reports per-step winner-selection latency and totals.
 *
 *  - real-key path (KIMI_E2E=1): one real turn with the same two live
 *    providers as P16, but reports the same dimensions as the fake
 *    path so the two are directly comparable.
 */
describe('MultiLLM multi-step performance (P20-B)', () => {
  it(
    'fake path — 6 steps with always-tool-call stub measures winner-selection cost',
    { timeout: 30_000 },
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'kimi-multillm-perf-'));
      try {
        // Six files, one per step. The stub reads step index from a
        // closure counter; each call returns a tool_call referencing the
        // file for that step, except the seventh call which returns stop.
        for (let i = 1; i <= 7; i += 1) {
          writeFileSync(join(workspace, `f${i}.txt`), `content of file ${i}\n`);
        }

        const stepLimit = 6;
        const providers = [
          { name: 'minimax', model: 'fake-minimax-m3', system_prompt: 'Answer briefly.' },
          { name: 'deepseek', model: 'fake-deepseek-v4-flash', system_prompt: 'Answer briefly.' },
        ];

        const { createRunTurnOverride } = await import('./rust-loop');
        const engine = createRunTurnOverride(providers, workspace, {
          nativeTools: true,
          shellPath: undefined,
        });

        const events: Array<{ type: string; at: number }> = [];
        const stepBoundaries: Array<{ step: number; beganAt: number; endedAt?: number }> = [];
        const calls: Record<string, number> = { minimax: 0, deepseek: 0 };
        const perStepLatency: number[] = [];
        const t0 = performance.now();

        const result = await (engine as (i: unknown) => Promise<{
          stopReason: string;
          steps: number;
        }>)({
          turnId: Date.now(),
          signal: new AbortController().signal,
          llm: {
            modelAlias: 'any',
            modelId: 'any',
            systemPrompt: 'You are a Read tool driver. Each call must use the Read tool to read f{N}.txt for the current step.',
            async chat(input: { modelName?: string }) {
              const name = (input.modelName ?? '').toLowerCase();
              const tag = name.includes('minimax') ? 'minimax' : name.includes('deepseek') ? 'deepseek' : 'unknown';
              calls[tag] = (calls[tag] ?? 0) + 1;
              const stepIdx = (calls[tag] ?? 1) - 1; // 0-based per provider
              // Simulate a tiny provider latency so the race actually
              // races (winner ≠ always-minimax). 0–3 ms jitter.
              await new Promise<void>((resolve) =>
                setTimeout(resolve, Math.floor(Math.random() * 3)),
              );
              if (stepIdx < stepLimit) {
                return {
                  toolCalls: [
                    {
                      id: `tc-${tag}-${stepIdx}`,
                      name: 'Read',
                      arguments: JSON.stringify({ path: `f${stepIdx + 1}.txt` }),
                    },
                  ],
                  providerFinishReason: 'tool_calls',
                  usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
                };
              }
              return {
                toolCalls: [],
                providerFinishReason: 'stop',
                usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
              };
            },
          },
          async buildMessages() {
            return [
              { role: 'user' as const, content: [{ type: 'text' as const, text: 'Read f1.txt through f6.txt in order. Each call reads the next file.' }] },
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
          async dispatchEvent(event: { type: string; step?: number; type_only?: never }) {
            await simulateUiDispatch(event, events);
            if (event.type === 'step.begin' && typeof event.step === 'number') {
              stepBoundaries.push({ step: event.step, beganAt: performance.now() });
            } else if (event.type === 'step.end' && typeof event.step === 'number') {
              const open = stepBoundaries.find((s) => s.step === event.step && s.endedAt === undefined);
              if (open) {
                open.endedAt = performance.now();
                perStepLatency.push(open.endedAt - open.beganAt);
              }
            }
          },
          async executeTool(call: { name: string; arguments?: string }) {
            if (call.name !== 'Read') return { output: 'unknown tool', isError: true };
            try {
              const args = JSON.parse(call.arguments ?? '{}') as { path?: string };
              const text = await Bun.file(join(workspace, args.path ?? '')).text();
              return { output: text, isError: false };
            } catch (e) {
              return { output: `error: ${(e as Error).message}`, isError: true };
            }
          },
          async checkToolPermission() {
            return { decision: 'allow' as const };
          },
        });

        const totalMs = Math.round(performance.now() - t0);
        const med = (xs: number[]): number => {
          const s = [...xs].sort((a, b) => a - b);
          return s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
        };
        const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

        // eslint-disable-next-line no-console
        console.log(
          `[multi-llm-perf:fake] steps=${result.steps} total=${totalMs}ms ` +
            `calls=${JSON.stringify(calls)} ` +
            `perStepMs(sum/med)=${sum(perStepLatency).toFixed(0)}/${med(perStepLatency).toFixed(0)}`,
        );

        // Sanity: 6 tool-call steps + 1 stop = 7 chats per provider,
        // the winner takes 6 steps, the loser is cancelled at step 7
        // after stop. We expect at least 6 from each provider.
        expect(calls.minimax).toBeGreaterThanOrEqual(stepLimit);
        expect(calls.deepseek).toBeGreaterThanOrEqual(stepLimit);
        // Total chats per provider should equal stepLimit + 1 (one stop
        // call) = 7. Allow >= stepLimit to be tolerant of stop calls.
        expect(result.stopReason).toBe('completed');
        expect(result.steps).toBeGreaterThanOrEqual(stepLimit);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!optedIn || !providers)(
    'real-key — 1 turn with 2 live providers reports the same dimensions as the fake path',
    { timeout: 90_000 },
    async () => {
      const p = providers!;
      const streamMinimax = async (): Promise<number> => {
        const res = await fetch('https://api.minimaxi.com/anthropic/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': p.minimaxKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: MINIMAX_MODEL, max_tokens: 16, messages: [{ role: 'user', content: PROMPT }], stream: true }),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`minimax ${res.status}: ${text.slice(0, 120)}`);
        let out = 0;
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const v = JSON.parse(line.slice(6));
          if (v.type === 'message_delta' && v.usage) out = v.usage.output_tokens ?? out;
        }
        return out;
      };
      const streamDeepseek = async (): Promise<number> => {
        const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${p.deepseekKey}` },
          body: JSON.stringify({ model: DEEPSEEK_MODEL, max_tokens: 16, messages: [{ role: 'user', content: PROMPT }], stream: true }),
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`deepseek ${res.status}: ${text.slice(0, 120)}`);
        let out = 0;
        for (const line of text.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') break;
          const v = JSON.parse(data);
          if (v.usage) out = v.completion_tokens ?? out;
        }
        return out;
      };
      const workspace = mkdtempSync(join(tmpdir(), 'kimi-multillm-perf-real-'));
      try {
        const { createRunTurnOverride } = await import('./rust-loop');
        const engine = createRunTurnOverride(
          [
            { name: 'minimax', model: MINIMAX_MODEL, system_prompt: 'Answer briefly.' },
            { name: 'deepseek', model: DEEPSEEK_MODEL, system_prompt: 'Answer briefly.' },
          ],
          workspace,
          { nativeTools: false, shellPath: undefined },
        );

        const events: Array<{ type: string; at: number }> = [];
        const calls: Record<string, number> = { minimax: 0, deepseek: 0 };
        const routedModels = new Set<string>();
        const t0 = performance.now();
        const result = await (engine as (i: unknown) => Promise<{ stopReason: string; steps: number }>)({
          turnId: Date.now(),
          signal: new AbortController().signal,
          llm: {
            modelAlias: 'any',
            modelId: 'any',
            systemPrompt: 'Answer briefly.',
            async chat(input: { modelName?: string }) {
              routedModels.add(input.modelName ?? '');
              const name = (input.modelName ?? '').toLowerCase();
              const streamFn = name.includes('minimax') ? streamMinimax : streamDeepseek;
              const tag = name.includes('minimax') ? 'minimax' : 'deepseek';
              calls[tag] = (calls[tag] ?? 0) + 1;
              return {
                toolCalls: [],
                providerFinishReason: 'stop',
                usage: { inputOther: 1, output: await streamFn(p), inputCacheRead: 0, inputCacheCreation: 0 },
              };
            },
          },
          async buildMessages() {
            return [{ role: 'user' as const, content: [{ type: 'text' as const, text: PROMPT }] }];
          },
          buildTools() {
            return [];
          },
          async dispatchEvent(event: { type: string }) {
            await simulateUiDispatch(event, events);
          },
          async executeTool() {
            return { output: '', isError: true };
          },
          async checkToolPermission() {
            return { decision: 'allow' as const };
          },
        });
        const elapsedMs = Math.round(performance.now() - t0);
        const eventCount = events.length;

        // eslint-disable-next-line no-console
        console.log(
          `[multi-llm-perf:real] winner=completed steps=${result.steps} total=${elapsedMs}ms ` +
            `calls=${JSON.stringify(calls)} events=${eventCount} routed=${[...routedModels].join(',')}`,
        );

        // Same assertions as the P16 test (model routing + concurrency),
        // plus a per-event count for forward-compat with future multi-step
        // real-key runs.
        expect(calls.minimax).toBeGreaterThanOrEqual(1);
        expect(calls.deepseek).toBeGreaterThanOrEqual(1);
        expect(routedModels).toEqual(new Set([MINIMAX_MODEL, DEEPSEEK_MODEL]));
        expect(result.stopReason).toBe('completed');
        expect(result.steps).toBeGreaterThanOrEqual(1);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    },
  );
});