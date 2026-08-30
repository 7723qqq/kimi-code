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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadRuntimeConfigSafe } from '@moonshot-ai/kimi-code-sdk';

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