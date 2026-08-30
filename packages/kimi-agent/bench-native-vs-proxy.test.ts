/**
 * Real-key benchmark: native-LLM (Rust drives the provider over SSE) vs
 * host-proxy (Rust engine calls back into the host, which drives the same
 * provider over SSE). Same provider, same messages, same token cap; reports
 * first-token latency (TTFT) and total turn time for both transports.
 *
 * Skipped unless `KIMI_E2E=1` is set AND the runtime config has the
 * `minimax-cn-coding-plan` anthropic provider (static key). This issues real
 * billed requests (3 turns per transport); opt-in is explicit, matching the
 * e2e convention.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, describe, expect, it } from 'vitest';

import { loadRuntimeConfigSafe } from '@moonshot-ai/kimi-code-sdk';

const HOME = process.env['KIMI_HOME'] ?? join(process.env['USERPROFILE'] ?? process.env['HOME'] ?? '', '.kimi-code');
const CFG = join(HOME, 'config.toml');

const ANTHROPIC_MESSAGES_BASE = 'https://api.minimaxi.com/anthropic/v1/messages';
const MODEL = 'MiniMax-M3';
const PROMPT = 'Count from 1 to 30. Reply with only the numbers, separated by commas.';

interface ProviderDef {
  apiKey: string;
}

const minimax = await (async (): Promise<ProviderDef | null> => {
  const fs = await import('node:fs');
  if (!fs.existsSync(CFG)) return null;
  const cfg = loadRuntimeConfigSafe(CFG);
  if (cfg.fileError !== undefined) return null;
  const p = cfg.config.providers?.['minimax-cn-coding-plan'];
  return p?.type === 'anthropic' && p.baseUrl === 'https://api.minimaxi.com/anthropic' && p.apiKey
    ? { apiKey: p.apiKey }
    : null;
})();

const optedIn = process.env['KIMI_E2E'] === '1';
const RUNS = 5;

interface TurnMetrics {
  ttftMs: number;
  totalMs: number;
  outputTokens: number;
}

interface EngineResultShape {
  usage: { output: number };
  telemetry?: { eventsEmitted: number; llmRetries: number };
}

async function sseFirstDeltaUntilDone(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  onFirstDelta: (atMs: number) => void,
  onTextPart?: (text: string) => Promise<void>,
): Promise<{ outputTokens: number; finishReason: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const brief = (await res.text()).slice(0, 200);
    throw new Error(`provider status ${res.status}: ${brief}`);
  }
  let firstDeltaSent = false;
  let outputTokens = 0;
  let finishReason = 'stop';
  let buffer = '';
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error('response body is not a readable stream');
  }
  const decoder = new TextDecoder();
  let v:
    | {
        type?: string;
        delta?: { type?: string; text?: string };
        usage?: { output_tokens?: number; input_tokens?: number };
        message?: { stop_reason?: string | null };
      }
    | undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
        v = JSON.parse(data);
      } catch {
        continue;
      }
      if (v.type === 'content_block_delta' && v.delta?.type === 'text_delta') {
        if (!firstDeltaSent) {
          firstDeltaSent = true;
          onFirstDelta(performance.now());
        }
        if (onTextPart) await onTextPart(v.delta.text ?? '');
      }
      if (v.type === 'message_delta' && v.usage) {
        outputTokens = v.usage.output_tokens ?? 0;
        if (v.message?.stop_reason) finishReason = v.message.stop_reason;
      }
    }
  }
  return { outputTokens, finishReason };
}

/** Symmetric dispatchEvent for both transports. P15 had proxy's
 *  `dispatchEvent` as an empty function — the bench therefore measured
 *  the cost of native-LLM's per-delta event chain against zero cost on
 *  the host-proxy path. This helper mirrors what the real event chain in
 *  `rust-loop.ts` does on the host side: append the event, then yield
 *  two microtask hops to simulate the promise-chain `then`
 *  continuation. Both transports now pay the same forwarding cost. */
async function simulateUiDispatch(
  event: { type: string },
  events: Array<{ type: string; at: number }>,
): Promise<void> {
  events.push({ type: event.type, at: performance.now() });
  await Promise.resolve();
  await Promise.resolve();
}

describe.skipIf(!optedIn || !minimax)('real-key benchmark — native-LLM vs host-proxy', () => {
  const provider = minimax!;
  const maskedKey = `${provider.apiKey.slice(0, 4)}…${provider.apiKey.slice(-2)}`;

  function anthropicBody(): Record<string, unknown> {
    return {
      model: MODEL,
      max_tokens: 96,
      messages: [{ role: 'user', content: PROMPT }],
      stream: true,
    };
  }

  async function nativeTurn(workspace: string, t0: number): Promise<TurnMetrics> {
    const { createRunTurnOverride } = await import('./rust-loop');
    const engine = createRunTurnOverride(undefined, workspace, {
      nativeTools: true,
      nativeLlm: () => ({
        protocol: 'anthropic',
        base_url: ANTHROPIC_MESSAGES_BASE.replace(/\/messages$/, ''),
        api_key: provider.apiKey,
        model: MODEL,
        max_tokens: 96,
      }),
      shellPath: undefined,
    });
    const events: Array<{ type: string; at: number }> = [];
    const started = performance.now();
    const engineFn = engine as (i: unknown) => Promise<EngineResultShape>;
    const result = await engineFn({
      turnId: Date.now(),
      signal: new AbortController().signal,
      llm: { modelAlias: 'minimax-m3', modelId: MODEL, systemPrompt: 'You are concise.' },
      async buildMessages() {
        return [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }];
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
    const firstPart = events.find((e) => e.type === 'content.part');
    return {
      ttftMs: firstPart ? firstPart.at - started : started + 60_000 - t0,
      totalMs: performance.now() - started,
      outputTokens: result.usage.output,
    };
  }

  async function proxyTurn(t0: number): Promise<TurnMetrics> {
    const { createRunTurnOverride } = await import('./rust-loop');
    const engine = createRunTurnOverride(undefined, tmpdirStore.dir, {
      nativeTools: false,
      shellPath: undefined,
    });
    const events: Array<{ type: string; at: number }> = [];
    let firstDeltaAt = 0;
    const started = performance.now();
    const engineFn = engine as (i: unknown) => Promise<EngineResultShape>;
    const result = await engineFn({
      turnId: Date.now(),
      signal: new AbortController().signal,
      llm: {
        modelAlias: 'minimax-m3',
        modelId: MODEL,
        systemPrompt: 'You are concise.',
        async chat({ onTextPart }: { onTextPart: (part: { type: 'text'; text: string }) => Promise<void> }) {
          const { outputTokens, finishReason } = await sseFirstDeltaUntilDone(
            ANTHROPIC_MESSAGES_BASE,
            provider.apiKey,
            anthropicBody(),
            (at) => {
              firstDeltaAt = at;
            },
            async (text) => {
              await onTextPart({ type: 'text', text });
            },
          );
          return {
            toolCalls: [],
            providerFinishReason: finishReason,
            usage: { inputOther: 0, output: outputTokens, inputCacheRead: 0, inputCacheCreation: 0 },
          };
        },
      },
      async buildMessages() {
        return [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }];
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
    // For host-proxy, first delta is captured from the inner fetch rather
    // than the dispatchEvent chain, so the proxy's TTFT reflects the
    // provider→host hop, not the host→engine hop. Use the same signal
    // (content.part in dispatch) for fair comparison when present.
    const firstPart = events.find((e) => e.type === 'content.part');
    const proxyTtft = firstPart
      ? firstPart.at - started
      : firstDeltaAt > 0
        ? firstDeltaAt - started
        : performance.now() - started;
    return {
      ttftMs: proxyTtft,
      totalMs: performance.now() - started,
      outputTokens: result.usage.output,
    };
  }

  const tmpdirStore = (() => {
    const dir = mkdtempSync(join(tmpdir(), 'kimi-nvp-'));
    return { dir };
  })();

  it(
    `compares ${RUNS} runs each — native vs host-proxy (${MODEL})`,
    { timeout: 180_000 },
    async () => {
      const native: TurnMetrics[] = [];
      const proxy: TurnMetrics[] = [];
      const globalStart = performance.now();

      for (let i = 0; i < RUNS; i += 1) {
        native.push(await nativeTurn(tmpdirStore.dir, globalStart));
        proxy.push(await proxyTurn(globalStart));
      }

      const median = (xs: number[]): number => {
        const s = [...xs].sort((a, b) => a - b);
        return s.length % 2 === 1 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
      };
      const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
      const pct = (xs: number[], p: number): number => {
        const s = [...xs].sort((a, b) => a - b);
        const idx = Math.min(s.length - 1, Math.max(0, Math.floor((p / 100) * (s.length - 1))));
        return s[idx]!;
      };
      const fmt = (n: number): string => n.toFixed(0).padStart(5);

      // eslint-disable-next-line no-console
      console.log(
        `\n[bench] ${MODEL} (${maskedKey}) — native-LLM vs host-proxy, ${RUNS} runs each ` +
          `(symmetric UI dispatch; P15 baseline had proxy dispatch as no-op)\n` +
          `transport   ttft(med/p90)   total(med/p90/p95)\n` +
          `native      ${fmt(median(native.map((m) => m.ttftMs)))}/${fmt(pct(native.map((m) => m.ttftMs), 90))}ms   ` +
          `${fmt(median(native.map((m) => m.totalMs)))}/${fmt(pct(native.map((m) => m.totalMs), 90))}/${fmt(pct(native.map((m) => m.totalMs), 95))}ms\n` +
          `host-proxy  ${fmt(median(proxy.map((m) => m.ttftMs)))}/${fmt(pct(proxy.map((m) => m.ttftMs), 90))}ms   ` +
          `${fmt(median(proxy.map((m) => m.totalMs)))}/${fmt(pct(proxy.map((m) => m.totalMs), 90))}/${fmt(pct(proxy.map((m) => m.totalMs), 95))}ms\n` +
          `native outputTokens: ${native.map((m) => m.outputTokens).join(', ')}\n` +
          `proxy  outputTokens: ${proxy.map((m) => m.outputTokens).join(', ')}`,
      );

      // Both transports must complete real generations; perf is reported,
      // not asserted (network/providers vary).
      for (const m of [...native, ...proxy]) {
        expect(m.outputTokens).toBeGreaterThan(0);
        expect(m.ttftMs).toBeGreaterThan(0);
      }
    },
  );

  afterAll(async () => {
    rmSync(tmpdirStore.dir, { recursive: true, force: true });
  });
});