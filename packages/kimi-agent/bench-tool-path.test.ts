/**
 * Tool-execution path baseline: engine-native vs host round-trip.
 *
 * The LLM is scripted, so no provider traffic leaves this file and the only
 * work per step is one tool call. Timing is printed, never asserted — the
 * assertions are the routing facts (who executed, and how many times the
 * boundary was crossed), which is what ROADMAP P21 / D-1 needs before deciding
 * the `nativeTools` default.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
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

const optedIn = process.env['KIMI_E2E'] === '1';

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

// ── Fixture-repo scale baseline (ROADMAP L689: tool-execution path baseline) ──
//
// The describe above measures the *routing* cost of a single Read crossing.
// This block measures what the paths do against a realistic fixture repo
// (~2000 files, mixed sizes): engine-native grep vs the host's external
// ripgrep pipeline, a 200-file batch Read, and a MAX_PARALLEL_TOOLS-wide
// (16) batch through the engine scheduler. Numbers are printed for ROADMAP
// backfill; the only assertions are "produced a result" sanity checks, so
// machine variance never fails the suite.

const FIXTURE_FILES = 2000;
const FIXTURE_DIRS = 40;
const BATCH_READ_FILES = 200;
const PARALLEL = 16; // mirrors MAX_PARALLEL_TOOLS in src/turn_loop/tool_scheduler.rs
const SCALE_REPS = 3;
const NEEDLE = 'zebra_needle_42';

const fixturePaths: string[] = [];

/** Deterministic PRNG so every run builds the identical fixture repo. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fixtureBody(rng: () => number, lines: number, seed: number): string {
  const out: string[] = [];
  for (let i = 1; i <= lines; i += 1) {
    out.push(
      rng() < 0.02
        ? `export const ${NEEDLE}_${seed}_${i} = ${i};`
        : `const filler_${i} = 'payload-${'y'.repeat(30 + Math.floor(rng() * 40))}-end';`,
    );
  }
  return `${out.join('\n')}\n`;
}

function buildFixtureRepo(root: string): void {
  const rng = makeRng(20260902);
  for (let i = 0; i < FIXTURE_FILES; i += 1) {
    const dir = join(root, `d${String(i % FIXTURE_DIRS).padStart(2, '0')}`);
    mkdirSync(dir, { recursive: true });
    // Mixed sizes: most files small, a few thousand-line ones (~200 KB each,
    // safely under the native Read/Grep caps).
    const lines = i % 100 === 0 ? 4000 : 40 + Math.floor(rng() * 560);
    const name = i % 2 === 0 ? `src-${String(i).padStart(4, '0')}.ts` : `doc-${String(i).padStart(4, '0')}.txt`;
    const path = join(dir, name);
    writeFileSync(path, fixtureBody(rng, lines, i));
    fixturePaths.push(path);
  }
}

const medianMs = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)] ?? 0;
};

function ripgrepAvailable(): boolean {
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** One scripted turn executing a single native grep through the engine. */
async function engineGrepOnce(mod: NativeModule, root: string, pattern: string): Promise<string> {
  const captured: string[] = [];
  let requests = 0;
  await mod.runTurnRust(
    {
      turnId: `bench-grep-${Math.random()}`,
      systemPrompt: 'You are a benchmark.',
      modelName: 'bench',
      messages: [{ role: 'user', content: 'grep it' }],
      tools: [{ name: 'grep', description: 'Search files', inputSchema: '{"type":"object"}' }],
      maxSteps: 3,
      workspaceRoot: root,
      nativeTools: true,
      shellPath: undefined,
    },
    makeCallback(mod, () => {
      requests += 1;
      if (requests > 1) {
        return JSON.stringify({
          tool_calls: [],
          finish_reason: 'stop',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }
      return JSON.stringify({
        tool_calls: [{ id: 'g1', name: 'grep', arguments: { pattern } }],
        finish_reason: 'tool_calls',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }),
    makeCallback(mod, () => {
      throw new Error('grep must run natively; host execution is a routing failure');
    }),
    makeCallback(mod, (req) => {
      const event = JSON.parse(req) as { type?: string; content?: string };
      if (event.type === 'tool.native' && typeof event.content === 'string') {
        captured.push(event.content);
      }
      return '';
    }),
    makeCallback(mod, () => JSON.stringify({ decision: 'allow' })),
  );
  return captured.join('\n');
}

function hostRipgrep(root: string, pattern: string): string {
  // Same shape as the host Grep tool's default files_with_matches arm
  // (packages/agent-core-v2 .../os/grep/grepTool.ts): external ripgrep,
  // hidden files searched, one engine-native head cap.
  const out = execFileSync('rg', ['--files-with-matches', '--hidden', '--max-count', '250', '--', pattern, root], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out;
}

/** One scripted turn whose single LLM reply fans out `count` native reads. */
async function engineReadBatchOnce(
  mod: NativeModule,
  root: string,
  paths: string[],
  maxSteps: number,
): Promise<{ resultCount: number; steps: number }> {
  let emitted = false;
  let resultCount = 0;
  const turn = await mod.runTurnRust(
    {
      turnId: `bench-batch-${Math.random()}`,
      systemPrompt: 'You are a benchmark.',
      modelName: 'bench',
      messages: [{ role: 'user', content: 'read them' }],
      tools: [{ name: 'read', description: 'Read a file', inputSchema: '{"type":"object"}' }],
      maxSteps,
      workspaceRoot: root,
      nativeTools: true,
      shellPath: undefined,
    },
    makeCallback(mod, () => {
      if (emitted) {
        return JSON.stringify({
          tool_calls: [],
          finish_reason: 'stop',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }
      emitted = true;
      return JSON.stringify({
        tool_calls: paths.map((p, i) => ({ id: `r${i}`, name: 'read', arguments: { path: p } })),
        finish_reason: 'tool_calls',
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }),
    makeCallback(mod, () => {
      throw new Error('reads must run natively; host execution is a routing failure');
    }),
    makeCallback(mod, (req) => {
      const event = JSON.parse(req) as { type?: string };
      if (event.type === 'tool.native') resultCount += 1;
      return '';
    }),
    makeCallback(mod, () => JSON.stringify({ decision: 'allow' })),
  );
  return { resultCount, steps: turn.steps };
}

describe.skipIf(!optedIn || !nativeEntry)(
  'tool-path scale baseline (fixture repo, KIMI_E2E-gated)',
  () => {
    let repo = '';
    const hasRg = ripgrepAvailable();

    beforeAll(() => {
      repo = mkdtempSync(join(tmpdir(), 'kimi-tool-scale-'));
      buildFixtureRepo(repo);
    }, 120_000);

    afterAll(() => {
      if (repo) rmSync(repo, { recursive: true, force: true });
    });

    it(
      `grep: engine-native walk vs host ripgrep over ${FIXTURE_FILES} fixture files`,
      { timeout: 180_000 },
      async () => {
        const mod = loadNativeModule();

        const engineSamples: number[] = [];
        let engineOut = '';
        for (let i = 0; i < SCALE_REPS; i += 1) {
          const t0 = performance.now();
          engineOut = await engineGrepOnce(mod, repo, NEEDLE);
          engineSamples.push(performance.now() - t0);
        }
        const heapBefore = process.memoryUsage().heapUsed;
        await engineGrepOnce(mod, repo, NEEDLE);
        const heapDeltaMb = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);

        const hostSamples: number[] = [];
        let hostOut = '';
        if (hasRg) {
          for (let i = 0; i < SCALE_REPS; i += 1) {
            const t0 = performance.now();
            hostOut = hostRipgrep(repo, NEEDLE);
            hostSamples.push(performance.now() - t0);
          }
        }

        const engineMatches = engineOut.split('\n').filter((l) => l.trim().length > 0).length;
        const hostMatches = hostOut.split('\n').filter((l) => l.trim().length > 0).length;

        // eslint-disable-next-line no-console
        console.log(
          [
            '',
            `── grep baseline (${FIXTURE_FILES} fixture files, ${SCALE_REPS} reps) ──`,
            `arm                        median      samples`,
            `engine-native grep         ${medianMs(engineSamples).toFixed(2).padStart(8)} ms  [${engineSamples.map((x) => x.toFixed(1)).join(', ')}]`,
            hasRg
              ? `host ripgrep (external)    ${medianMs(hostSamples).toFixed(2).padStart(8)} ms  [${hostSamples.map((x) => x.toFixed(1)).join(', ')}]`
              : 'host ripgrep               (rg not installed — arm skipped)',
            `engine output lines/files  ${engineMatches}   heap delta ≈ ${heapDeltaMb.toFixed(1)} MB (JS heap only)`,
            hasRg ? `host output lines/files    ${hostMatches}` : '',
          ]
            .filter((l) => l !== '')
            .join('\n'),
        );

        // Sanity only: both arms located seeded files; no perf threshold.
        // files_with_matches mode lists relative paths, so verify at least one
        // listed file actually carries the needle.
        const engineListed = engineOut
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        const engineVerified = engineListed.some((rel) => {
          try {
            return readFileSync(join(repo, rel), 'utf8').includes(NEEDLE);
          } catch {
            return false;
          }
        });
        expect(engineVerified).toBe(true);
        expect(engineMatches).toBeGreaterThan(0);
        if (hasRg) {
          expect(hostOut).toContain('.ts');
          expect(hostMatches).toBeGreaterThan(0);
        }
      },
    );

    it(
      `batch read: ${BATCH_READ_FILES} files through the engine`,
      { timeout: 180_000 },
      async () => {
        const mod = loadNativeModule();
        const targets = fixturePaths.slice(0, BATCH_READ_FILES);
        const perTurn = PARALLEL;
        const turns: string[][] = [];
        for (let i = 0; i < targets.length; i += perTurn) {
          turns.push(targets.slice(i, i + perTurn));
        }

        const t0 = performance.now();
        let totalResults = 0;
        let totalSteps = 0;
        for (const batch of turns) {
          const r = await engineReadBatchOnce(mod, repo, batch, 4);
          totalResults += r.resultCount;
          totalSteps += r.steps;
        }
        const engineWall = performance.now() - t0;

        // Host-side proxy reference: the same 200 reads as independent
        // concurrent host executions (what nativeTools=false pays per call).
        const h0 = performance.now();
        const hostContents = await Promise.all(targets.map(async (p) => hostRead(p)));
        const hostWall = performance.now() - h0;

        // eslint-disable-next-line no-console
        console.log(
          [
            '',
            `── batch read baseline (${BATCH_READ_FILES} files, ${perTurn} native calls/turn × ${turns.length} turns) ──`,
            `engine-native: ${engineWall.toFixed(1)} ms wall, ${totalResults} tool results, ${totalSteps} engine steps, ${(engineWall / BATCH_READ_FILES).toFixed(2)} ms/file`,
            `host concurrent (Promise.all of ${BATCH_READ_FILES} sync reads): ${hostWall.toFixed(1)} ms wall, ${(hostWall / BATCH_READ_FILES).toFixed(2)} ms/file`,
          ].join('\n'),
        );

        expect(totalResults).toBe(BATCH_READ_FILES);
        expect(hostContents[0]).toContain('1\t');
      },
    );

    it(
      `parallel ${PARALLEL}-wide batch: engine scheduler vs concurrent host calls`,
      { timeout: 120_000 },
      async () => {
        const mod = loadNativeModule();
        const batch = fixturePaths.slice(0, PARALLEL);

        const engineSamples: number[] = [];
        let lastResultCount = 0;
        for (let i = 0; i < SCALE_REPS; i += 1) {
          const t0 = performance.now();
          const r = await engineReadBatchOnce(mod, repo, batch, 3);
          engineSamples.push(performance.now() - t0);
          lastResultCount = r.resultCount;
        }

        const hostSamples: number[] = [];
        for (let i = 0; i < SCALE_REPS; i += 1) {
          const t0 = performance.now();
          await Promise.all(batch.map(async (p) => hostRead(p)));
          hostSamples.push(performance.now() - t0);
        }

        // eslint-disable-next-line no-console
        console.log(
          [
            '',
            `── parallel-${PARALLEL} batch baseline (${SCALE_REPS} reps) ──`,
            `engine scheduler batch    median ${medianMs(engineSamples).toFixed(2)} ms  [${engineSamples.map((x) => x.toFixed(1)).join(', ')}]`,
            `host ${PARALLEL} concurrent reads  median ${medianMs(hostSamples).toFixed(2)} ms  [${hostSamples.map((x) => x.toFixed(1)).join(', ')}]`,
          ].join('\n'),
        );

        expect(lastResultCount).toBe(PARALLEL);
        expect(engineSamples.every((x) => x > 0)).toBe(true);
        expect(hostSamples.every((x) => x > 0)).toBe(true);
      },
    );
  },
);
