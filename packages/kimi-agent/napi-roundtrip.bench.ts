// Napi transport round-trip benchmarks — the P5 relative baseline (no real LLM).
//
// Measures the per-call overhead of the host ↔ engine boundary through the
// real `kimi_agent.node` addon: every op is a full `runTurnRust` turn whose
// LLM/tool callbacks resolve instantly, so the measured time is almost
// entirely marshalling + ThreadsafeFunction hop cost — the floor the
// host-proxy path pays per LLM step / per tool call.
//
// Run with: bun x vitest bench --run napi-roundtrip.bench.ts
//
// Complements the real-key benchmark documented in ROADMAP P5.

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { bench, describe } from 'vitest';

const nativeEntry = readdirSync(import.meta.dirname).find(
  (f) => f.endsWith('.node') && f.startsWith('kimi_agent'),
);

interface NativeModule {
  runTurnRust: (
    params: unknown,
    llmChatCb: (id: number) => void,
    executeToolCb: (id: number) => void,
  ) => Promise<unknown>;
  resolveCallback: (id: number, error: string | null, result: string | null) => void;
  getCallbackPayload: (id: number) => string | null;
}

function loadNativeModule(): NativeModule {
  if (!nativeEntry) {
    throw new Error('kimi_agent native addon not built; run `napi build` in packages/kimi-agent');
  }
  return require(resolve(import.meta.dirname, nativeEntry)) as NativeModule;
}

const mod = loadNativeModule();

function makeCallback(handler: (req: unknown) => unknown): (id: number) => void {
  return (id: number) => {
    const payload = mod.getCallbackPayload(id);
    if (!payload) return;
    Promise.resolve(handler(JSON.parse(payload))).then(
      (result) => mod.resolveCallback(id, null, JSON.stringify(result)),
      (error: unknown) =>
        mod.resolveCallback(
          id,
          error instanceof Error ? error.message : String(error),
          null,
        ),
    );
  };
}

const LLM_STOP = (): unknown => ({
  tool_calls: [],
  finish_reason: 'stop',
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
});

const LLM_ONE_TOOL_CALL = (): unknown => ({
  tool_calls: [{ id: 'call-1', name: 'read', arguments: { path: 'bench.txt' } }],
  finish_reason: 'tool_calls',
  usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
});

const TOOL_OK = (): unknown => ({ content: 'ok', is_error: false });

const PARAMS = {
  turnId: 'bench-turn',
  systemPrompt: 'bench',
  modelName: 'bench-model',
  messages: [{ role: 'user', content: 'bench' }],
  tools: [],
  maxSteps: 2,
};

async function runTurn(
  llmHandler: (req: unknown) => unknown,
  toolHandler: (req: unknown) => unknown,
): Promise<void> {
  await mod.runTurnRust(PARAMS, makeCallback(llmHandler), makeCallback(toolHandler));
}

const OPTIONS = { warmupTime: 500, time: 3000 };

describe.skipIf(!nativeEntry)('napi runTurnRust round-trip (instant fakes)', () => {
  bench(
    'single step — 1 llm_chat hop',
    async () => {
      await runTurn(LLM_STOP, TOOL_OK);
    },
    OPTIONS,
  );

  bench(
    'tool round-trip — 2 llm_chat + 1 execute_tool hops',
    async () => {
      let called = false;
      await runTurn(() => {
        if (!called) {
          called = true;
          return LLM_ONE_TOOL_CALL();
        }
        return LLM_STOP();
      }, TOOL_OK);
    },
    OPTIONS,
  );
});
