/**
 * Tool-execution path baseline: engine-native vs host round-trip.
 *
 * The LLM is scripted, so no provider traffic leaves this file and the only
 * work per step is one tool call. Timing is printed, never asserted — the
 * assertions are the routing facts (who executed, and how many times the
 * boundary was crossed), which is what ROADMAP P21 / D-1 needs before deciding
 * the `nativeTools` default.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const nativeEntry = readdirSync(import.meta.dirname).find(
  (f) => f.endsWith('.node') && f.startsWith('kimi_agent'),
);

type NativeModule = {
  runTurnRust: (
    params: unknown,
    llm: (id: number) => void,
    tool: (id: number) => void,
    events: (id: number) => void,
    permission: (id: number) => void,
  ) => Promise<{ steps: number; stopReason: string }>;
  resolveCallback: (id: number, error: string | null, result: string | null) => void;
  getCallbackPayload: (id: number) => string | null;
};

function loadNativeModule(): NativeModule {
  if (!nativeEntry) {
    throw new Error('kimi_agent native addon not built; run `bun run build` in packages/kimi-agent');
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(resolve(import.meta.dirname, nativeEntry));
}

function makeCallback(mod: NativeModule, handler: (request: string) => string) {
  return (callbackId: number) => {
    const payload = mod.getCallbackPayload(callbackId);
    if (!payload) return;
    try {
      mod.resolveCallback(callbackId, null, handler(payload));
    } catch (error: unknown) {
      mod.resolveCallback(
        callbackId,
        error instanceof Error ? error.message : String(error),
        null,
      );
    }
  };
}

const REPS = 25;
const READ_CAP_LINES = 1000;

/** Mirrors what the host Read tool does: read, cap, number the lines. */
function hostRead(path: string): string {
  const text = readFileSync(path, 'utf8');
  return text
    .split('\n')
    .slice(0, READ_CAP_LINES)
    .map((line, i) => `${String(i + 1)} | ${line}`)
    .join('\n');
}

let workspace: string;
let fitName: string;
let escapeName: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'kimi-tool-path-'));
  const fit = 'fits.txt';
  const escape = 'too_big.txt';
  writeFileSync(join(workspace, fit), 'a'.repeat(3_000_000) + '\n');
  writeFileSync(join(workspace, escape), 'b'.repeat(5_000_000) + '\n');
  fitName = fit;
  escapeName = escape;
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

type Counts = { hostExecutions: number; permissionChecks: number };

async function runTurn(
  mod: NativeModule,
  file: string | null,
  opts: { nativeTools: boolean; counts: Counts },
): Promise<number> {
  let requests = 0;
  const started = performance.now();
  await mod.runTurnRust(
    {
      turnId: `bench-${Math.random()}`,
      systemPrompt: 'You are a benchmark.',
      modelName: 'bench',
      messages: [{ role: 'user', content: 'read it' }],
      tools: [{ name: 'read', description: 'Read a file', inputSchema: '{"type":"object"}' }],
      maxSteps: 3,
      workspaceRoot: workspace,
      nativeTools: opts.nativeTools,
      shellPath: undefined,
    },
    makeCallback(mod, () => {
      requests += 1;
      if (file === null || requests > 1) {
        return JSON.stringify({
          tool_calls: [],
          finish_reason: 'stop',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }
      return JSON.stringify({
        tool_calls: [{ id: `c${requests}`, name: 'read', arguments: { path: file } }],
        finish_reason: 'tool_calls',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }),
    makeCallback(mod, (req) => {
      opts.counts.hostExecutions += 1;
      const args = JSON.parse(req) as { arguments?: { path?: string } };
      return JSON.stringify({
        content: hostRead(join(workspace, String(args.arguments?.path))),
        is_error: false,
      });
    }),
    makeCallback(mod, () => ''),
    makeCallback(mod, () => {
      opts.counts.permissionChecks += 1;
      return JSON.stringify({ decision: 'allow' });
    }),
  );
  return performance.now() - started;
}

async function measure(
  mod: NativeModule,
  file: string | null,
  nativeTools: boolean,
): Promise<{ medianMs: number; counts: Counts }> {
  const counts: Counts = { hostExecutions: 0, permissionChecks: 0 };
  const samples: number[] = [];
  for (let i = 0; i < REPS; i += 1) {
    samples.push(await runTurn(mod, file, { nativeTools, counts }));
  }
  samples.sort((a, b) => a - b);
  return { medianMs: samples[Math.floor(REPS / 2)] ?? 0, counts };
}

describe.skipIf(!nativeEntry)('tool-execution path baseline (scripted LLM, no provider traffic)', () => {
  it('routes each arm the way P21 claims and prints the cost of each crossing', async () => {
    const mod = loadNativeModule();

    const control = await measure(mod, null, false);
    const viaHost = await measure(mod, fitName, false);
    const viaNative = await measure(mod, fitName, true);
    const nativeFallsBack = await measure(mod, escapeName, true);

    const toolCost = (turn: { medianMs: number }): number => turn.medianMs - control.medianMs;

    const lines = [
      `control (2 steps, no tool)        ${control.medianMs.toFixed(2)} ms`,
      `host  read 3 MB                   ${viaHost.medianMs.toFixed(2)} ms  (tool ${toolCost(viaHost).toFixed(2)} ms)`,
      `native read 3 MB                  ${viaNative.medianMs.toFixed(2)} ms  (tool ${toolCost(viaNative).toFixed(2)} ms)`,
      `native attempted, 5 MB falls back ${nativeFallsBack.medianMs.toFixed(2)} ms  (tool ${toolCost(nativeFallsBack).toFixed(2)} ms)`,
    ];
    console.log(`\n── tool-execution path baseline (${REPS} reps/arm) ──\n${lines.join('\n')}\n`);

    expect(control.counts).toEqual({ hostExecutions: 0, permissionChecks: 0 });
    expect(viaHost.counts).toEqual({ hostExecutions: REPS, permissionChecks: 0 });
    expect(viaNative.counts).toEqual({ hostExecutions: 0, permissionChecks: REPS });
    expect(nativeFallsBack.counts).toEqual({
      hostExecutions: REPS,
      permissionChecks: REPS,
    });
  });
});
