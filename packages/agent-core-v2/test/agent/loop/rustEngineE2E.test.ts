import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IEngineOverrideService, type TurnEngine } from '#/agent/loop/engineOverride';
import { IAgentPlanService } from '#/features/plan/plan';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { IHostProcessService } from '#/os/interface/hostProcess';

import {
  appService,
  createTestAgent,
  execEnvServices,
  permissionModeServices,
  type TestAgentContext,
} from '../../harness';
import { createFakeHostFs, createFakeProcessRunner } from '../../tools/fixtures/fake-exec';

/**
 * End-to-end seam test: the REAL Rust addon (napi) + the REAL rust-loop
 * adapter + the REAL loopService permission gate, driven by a scripted
 * host LLM. Every slice-level test above this file fakes one of the three
 * parties; this one verifies the seams actually converse.
 *
 * Skipped when the native addon is not built (packages/kimi-agent: `napi build`).
 */
const kimiAgentDir = join(import.meta.dirname, '../../../../kimi-agent');

function hasNativeAddon(): boolean {
  try {
    return readdirSync(kimiAgentDir).some(
      (f) => f.endsWith('.node') && f.startsWith('kimi_agent'),
    );
  } catch {
    return false;
  }
}

describe.skipIf(!hasNativeAddon())('rust engine — real adapter + addon + permission gate', () => {
  let ctx: TestAgentContext | undefined;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (ctx !== undefined) {
      await ctx.dispose();
      ctx = undefined;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('executes a native Write through the host permission gate and records the transcript', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kimi-rust-e2e-'));
    tempDirs.push(workspace);

    // Dynamic import: the adapter lives in the kimi-agent package and loads
    // the native addon relative to its own location.
    const adapterModule = (await import(
      '../../../../kimi-agent/rust-loop.ts'
    )) as typeof import('../../../../kimi-agent/rust-loop');
    const { shutdownRustEngine } = adapterModule;
    const engine = adapterModule.createRunTurnOverride(undefined, workspace, {
      nativeTools: true,
      // Bash needs a shell path; this test only exercises Write, which is
      // shell-independent.
      shellPath: undefined,
    });
    expect(engine).toBeDefined();
    shutdownRustEngine();
    ctx = createTestAgent(
      appService(IEngineOverrideService, {
        getEngine: () => engine as unknown as TurnEngine,
      }),
      permissionModeServices('yolo'),
    );
    // The permission gate resolves the tool from the registry before
    // adjudicating — register a Write stand-in (its execute never runs when
    // the native path is granted; the sandbox writes the file instead).
    ctx.get(IAgentToolRegistryService).register({
      name: 'Write',
      description: 'Write a file',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false,
      },
      resolveExecution: (input: { path: string; content: string }) => ({
        approvalRule: 'Write',
        execute: async () => ({
          isError: true,
          output: `UNREACHABLE native fallback: ${input.path}`,
        }),
      }),
    });
    void ctx.restoreRuntimes();

    // Scripted host LLM: first response issues the Write, second ends the turn.
    ctx.mockNextResponse(
      {
        type: 'text',
        text: 'I will write the file.',
      },
      {
        type: 'function',
        id: 'call-e2e-write',
        name: 'Write',
        arguments: JSON.stringify({ path: 'e2e-seam.txt', content: 'seam check\n' }),
      },
    );
    ctx.mockNextResponse({ type: 'text', text: 'File written.' });

    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Write the seam file' }] });
    await end;

    // The file landed inside the sandbox via the native path.
    expect(existsSync(join(workspace, 'e2e-seam.txt'))).toBe(true);
    expect(readFileSync(join(workspace, 'e2e-seam.txt'), 'utf8')).toBe('seam check\n');

    // The loop saw exactly the engine-driven turn lifecycle.
    const loop = ctx.get(IAgentLoopService);
    expect(loop.status().state).toBe('idle');
  });

  it('carries the plan-mode reminder into the real engine request messages', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kimi-rust-plan-'));
    tempDirs.push(workspace);

    const activeFs = createFakeHostFs({ mkdir: async () => undefined, readText: async () => '' });
    const activeRunner = createFakeProcessRunner();
    const delegatingFs = (): IHostFileSystem =>
      new Proxy(createFakeHostFs({ mkdir: async () => undefined, readText: async () => '' }), {
        get(_target, prop, receiver) {
          const value = Reflect.get(activeFs, prop, receiver);
          return typeof value === 'function' ? value.bind(activeFs) : value;
        },
      }) as IHostFileSystem;
    const delegatingRunner = (): IHostProcessService =>
      new Proxy(createFakeProcessRunner(), {
        get(_target, prop, receiver) {
          const value = Reflect.get(activeRunner, prop, receiver);
          return typeof value === 'function' ? value.bind(activeRunner) : value;
        },
      }) as IHostProcessService;

    const adapterModule = (await import(
      '../../../../kimi-agent/rust-loop.ts'
    )) as typeof import('../../../../kimi-agent/rust-loop');
    const { shutdownRustEngine } = adapterModule;
    const engine = adapterModule.createRunTurnOverride(undefined, workspace, {
      nativeTools: true,
      shellPath: undefined,
    });
    expect(engine).toBeDefined();
    shutdownRustEngine();

    ctx = createTestAgent(
      appService(IEngineOverrideService, {
        getEngine: () => engine as unknown as TurnEngine,
      }),
      execEnvServices({ hostFs: delegatingFs(), processRunner: delegatingRunner() }),
    );
    await ctx.restorePersisted();
    void ctx.restoreRuntimes();

    // Enter plan mode: PlanModeInjection registers the plan_mode reminder,
    // which reconcileAroundStep injects through onWillBeginStep — the gate
    // the engine-driven turn also runs.
    await ctx.get(IAgentPlanService).enter('engine-plan');

    ctx.mockNextResponse({ type: 'text', text: 'Plan first.' });
    const end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Plan the rust engine work' }] });
    await end;

    // The REAL engine adapter built its request from buildMessages(); the
    // host projection must have carried the plan-mode reminder into the
    // messages the (scripted) LLM received.
    expect(ctx.llmCalls.length).toBeGreaterThanOrEqual(1);
    const history = ctx.llmCalls[0]?.history ?? [];
    const text = history
      .flatMap((m) => (typeof m.content === 'string' ? [m.content] : m.content.map((c) => 'text' in c ? c.text : '')))
      .join('\n');
    expect(text).toContain('<system-reminder>');
    expect(text).toContain('Plan mode is active');
  });

  it('continues cross-turn history across engine-driven turns', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kimi-rust-multi-'));
    tempDirs.push(workspace);

    const adapterModule = (await import(
      '../../../../kimi-agent/rust-loop.ts'
    )) as typeof import('../../../../kimi-agent/rust-loop');
    const { shutdownRustEngine } = adapterModule;
    const engine = adapterModule.createRunTurnOverride(undefined, workspace, {
      nativeTools: true,
      shellPath: undefined,
    });
    expect(engine).toBeDefined();
    shutdownRustEngine();
    ctx = createTestAgent(
      appService(IEngineOverrideService, {
        getEngine: () => engine as unknown as TurnEngine,
      }),
    );
    void ctx.restoreRuntimes();

    ctx.mockNextResponse({ type: 'text', text: 'first reply' });
    let end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
    await end;

    ctx.mockNextResponse({ type: 'text', text: 'second reply' });
    end = ctx.untilTurnEnd();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
    await end;

    // Turn 2's request must carry turn 1's exchange: the host context is the
    // single source of truth, whichever transport drives the turn.
    expect(ctx.llmCalls.length).toBe(2);
    const second = ctx.llmCalls[1]?.history ?? [];
    const text = second
      .flatMap((m) =>
        typeof m.content === 'string' ? [m.content] : m.content.map((c) => ('text' in c ? c.text : '')),
      )
      .join('\n');
    expect(text).toContain('first prompt');
    expect(text).toContain('first reply');
    expect(text).toContain('second prompt');
  });
});
