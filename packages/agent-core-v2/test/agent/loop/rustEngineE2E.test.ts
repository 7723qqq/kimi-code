import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IEngineOverrideService, type TurnEngine } from '#/agent/loop/engineOverride';

import {
  appService,
  createTestAgent,
  permissionModeServices,
  type TestAgentContext,
} from '../../harness';

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
});
