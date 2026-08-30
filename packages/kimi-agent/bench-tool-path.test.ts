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
  ) => Promise<{
    steps: number;
    stopReason: string;
    nativeToolCalls?: number;
    llmTransport?: string;
  }>;
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
    .map((line, i) => `${String(i + 1)}\t${line}`)
    .join('\n');
}

/**
 * Realistic shape: many short lines. A single giant line would let the native
 * arm truncate to READ_MAX_LINE_LENGTH while the host arm returned the whole
 * thing, which measures output size rather than work.
 */
function syntheticFile(lines: number): string {
  const out: string[] = [];
  for (let i = 1; i <= lines; i += 1) {
    out.push(`line ${String(i)}: ${'x'.repeat(50)}`);
  }
  return `${out.join('\n')}\n`;
}

let workspace: string;
let fitName: string;
let escapeName: string;

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'kimi-tool-path-'));
  fitName = 'fits.txt';
  escapeName = 'too_big.txt';
  writeFileSync(join(workspace, fitName), syntheticFile(50_000));
  // ~13 MB — above the native Read cap (10 MiB since P32 G-3), so the
  // native arm must fall back to the host.
  writeFileSync(join(workspace, escapeName), syntheticFile(200_000));
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

type Counts = {
  hostExecutions: number;
  permissionChecks: number;
  nativeResults: string[];
  engineNativeTotal: number;
};

async function runTurn(
  mod: NativeModule,
  file: string | null,
  opts: { nativeTools: boolean; counts: Counts },
): Promise<number> {
  let requests = 0;
  const started = performance.now();
  const turnResult = await mod.runTurnRust(
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
    makeCallback(mod, (req) => {
      const event = JSON.parse(req) as { type?: string; content?: string };
      if (event.type === 'tool.native' && typeof event.content === 'string') {
        opts.counts.nativeResults.push(event.content);
      }
      return '';
    }),
    makeCallback(mod, () => {
      opts.counts.permissionChecks += 1;
      return JSON.stringify({ decision: 'allow' });
    }),
  );
  // -1 marks "this addon never reported it", so a stale binary fails loudly.
  opts.counts.engineNativeTotal += turnResult.nativeToolCalls ?? -1;
  return performance.now() - started;
}

async function measure(
  mod: NativeModule,
  file: string | null,
  nativeTools: boolean,
): Promise<{ medianMs: number; counts: Counts }> {
  const counts: Counts = {
    hostExecutions: 0,
    permissionChecks: 0,
    nativeResults: [],
    engineNativeTotal: 0,
  };
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
    const oversizedHost = await measure(mod, escapeName, false);
    const nativeFallsBack = await measure(mod, escapeName, true);

    const toolCost = (turn: { medianMs: number }): number => turn.medianMs - control.medianMs;

    const lines = [
      `control (2 steps, no tool)        ${control.medianMs.toFixed(2)} ms`,
      `host  read in-cap file            ${viaHost.medianMs.toFixed(2)} ms  (tool ${toolCost(viaHost).toFixed(2)} ms)`,
      `native read in-cap file           ${viaNative.medianMs.toFixed(2)} ms  (tool ${toolCost(viaNative).toFixed(2)} ms)`,
      `host  read oversized file         ${oversizedHost.medianMs.toFixed(2)} ms  (tool ${toolCost(oversizedHost).toFixed(2)} ms)`,
      `native oversized → falls back     ${nativeFallsBack.medianMs.toFixed(2)} ms  (tool ${toolCost(nativeFallsBack).toFixed(2)} ms)`,
      `fallback tax vs same-size host    ${(nativeFallsBack.medianMs - oversizedHost.medianMs).toFixed(2)} ms`,
    ];
    console.log(`\n── tool-execution path baseline (${REPS} reps/arm) ──\n${lines.join('\n')}\n`);

    const routed = (c: Counts) => ({ host: c.hostExecutions, permission: c.permissionChecks });
    expect(routed(control.counts)).toEqual({ host: 0, permission: 0 });
    expect(routed(viaHost.counts)).toEqual({ host: REPS, permission: 0 });
    expect(routed(viaNative.counts)).toEqual({ host: 0, permission: REPS });
    expect(routed(oversizedHost.counts)).toEqual({ host: REPS, permission: 0 });
    expect(routed(nativeFallsBack.counts)).toEqual({ host: REPS, permission: REPS });

    // The engine's own report must agree with what the callbacks observed:
    // only the in-cap native arm executed anything in-process, and a
    // never-reported field would surface as a negative total here.
    expect(control.counts.engineNativeTotal).toBe(0);
    expect(viaHost.counts.engineNativeTotal).toBe(0);
    expect(viaNative.counts.engineNativeTotal).toBe(REPS);
    expect(oversizedHost.counts.engineNativeTotal).toBe(0);
    expect(nativeFallsBack.counts.engineNativeTotal).toBe(0);

    // Guard against measuring unequal work: the native arm must hand back the
    // same 1000 numbered lines the host arm does, not a shorter payload.
    const hostShape = hostRead(join(workspace, fitName));
    expect(viaNative.counts.nativeResults).toHaveLength(REPS);
    for (const content of viaNative.counts.nativeResults) {
      expect(content).toContain('1\tline 1:');
      expect(content).toContain('1000\tline 1000:');
      expect(content.length).toBeLessThan(hostShape.length * 2);
    }
  });
});
