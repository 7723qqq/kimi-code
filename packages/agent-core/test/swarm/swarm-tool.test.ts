import { describe, expect, it, vi } from 'vitest';

import { SwarmTool } from '../../src/tools/builtin/collaboration/swarm';
import type { SessionSubagentHost } from '../../src/session/subagent-host';
import type { ToolExecutionHookContext } from '../../src/loop/index';

const PLAN_JSON = JSON.stringify({
  subtasks: [{ role: 'R', systemPrompt: 'sp', prompt: 'p' }],
});

function makeHookCtx(name: string, args: unknown): ToolExecutionHookContext {
  return {
    toolCall: { type: 'function', id: 'c', name, arguments: JSON.stringify(args) },
    args,
    turnId: 't',
    stepNumber: 1,
    signal: new AbortController().signal,
  } as unknown as ToolExecutionHookContext;
}

function fakeHost(): SessionSubagentHost {
  const spawn = vi.fn(async (profileName: string) => {
    const result =
      profileName === 'swarm-planner'
        ? PLAN_JSON
        : profileName === 'swarm-synthesizer'
          ? 'FINAL'
          : 'worker-out';
    return { agentId: 'a', profileName, resumed: false, completion: Promise.resolve({ result }) };
  });
  return { spawn } as unknown as SessionSubagentHost;
}

describe('SwarmTool', () => {
  it('exposes a task parameter and an approval rule', () => {
    const tool = new SwarmTool(fakeHost());
    expect(tool.name).toBe('Swarm');
    const exec = tool.resolveExecution({ task: 'hello' });
    expect('approvalRule' in exec && exec.approvalRule).toBe('Swarm');
  });

  it('runs the coordinator and returns the synthesized output', async () => {
    const tool = new SwarmTool(fakeHost());
    const exec = tool.resolveExecution({ task: 'do it' });
    if (!('execute' in exec)) throw new Error('expected runnable execution');
    const updates: string[] = [];
    const result = await exec.execute({
      turnId: 't1',
      toolCallId: 'tc1',
      signal: new AbortController().signal,
      onUpdate: (u) => {
        if (u.text !== undefined) updates.push(u.text);
      },
    });
    expect('output' in result && result.output).toBe('FINAL');
    expect(updates.length).toBeGreaterThan(0);
  });

  it('injects a stall hook + per-worker signal for workers but not planner/synthesizer', async () => {
    const seen: Array<{ profileName: string; hasHooks: boolean; sameAsCoordinator: boolean }> = [];
    const coordinatorSignal = new AbortController().signal;
    const spawn = vi.fn(async (profileName: string, options: any) => {
      seen.push({
        profileName,
        hasHooks: options.loopHooks !== undefined,
        sameAsCoordinator: options.signal === coordinatorSignal,
      });
      const result =
        profileName === 'swarm-planner'
          ? PLAN_JSON
          : profileName === 'swarm-synthesizer'
            ? 'FINAL'
            : 'worker-out';
      return { agentId: 'a', profileName, resumed: false, completion: Promise.resolve({ result }) };
    });
    const host = { spawn } as unknown as SessionSubagentHost;

    const tool = new SwarmTool(host);
    const exec = tool.resolveExecution({ task: 'do it' });
    if (!('execute' in exec)) throw new Error('expected runnable execution');
    await exec.execute({ turnId: 't1', toolCallId: 'tc1', signal: coordinatorSignal });

    const planner = seen.find((s) => s.profileName === 'swarm-planner');
    const synth = seen.find((s) => s.profileName === 'swarm-synthesizer');
    const worker = seen.find((s) => s.profileName === 'swarm:R');
    expect(planner?.hasHooks).toBe(false);
    expect(synth?.hasHooks).toBe(false);
    // Planner/synthesizer use the coordinator signal directly.
    expect(planner?.sameAsCoordinator).toBe(true);
    // Worker gets the stall hook and a distinct (linked) per-worker signal.
    expect(worker?.hasHooks).toBe(true);
    expect(worker?.sameAsCoordinator).toBe(false);
  });

  it('translates a worker stall into a distinguishable error recorded by the coordinator, leaving the coordinator signal unaborted, and still synthesizes', async () => {
    const coordinator = new AbortController();
    let synthesizerPrompt: string | undefined;

    const spawn = vi.fn(async (profileName: string, options: any) => {
      if (profileName === 'swarm-planner') {
        return {
          agentId: 'p',
          profileName,
          resumed: false,
          completion: Promise.resolve({ result: PLAN_JSON }),
        };
      }
      if (profileName === 'swarm-synthesizer') {
        synthesizerPrompt = options.prompt;
        return {
          agentId: 's',
          profileName,
          resumed: false,
          completion: Promise.resolve({ result: 'SYNTH' }),
        };
      }
      // Worker: drive the injected stall hook with a repeated tool call. The
      // hook's onStall aborts the per-worker signal; we mirror the real
      // subagent-host path by rejecting with the generic cancel message once
      // the per-worker signal is aborted.
      const hook = options.loopHooks?.prepareToolExecution;
      expect(hook).toBeDefined();
      const ctx = makeHookCtx('Read', { path: '/loop' });
      const completion = (async () => {
        for (let i = 0; i < 100; i += 1) {
          const decision = await hook(ctx);
          if (decision?.block === true) break;
        }
        // Per-worker signal was aborted by the stall hook.
        expect(options.signal.aborted).toBe(true);
        const err = new Error('Subagent turn cancelled');
        err.name = 'AbortError';
        throw err;
      })();
      return { agentId: 'w', profileName, resumed: false, completion };
    });
    const host = { spawn } as unknown as SessionSubagentHost;

    const tool = new SwarmTool(host);
    const exec = tool.resolveExecution({ task: 'do it' });
    if (!('execute' in exec)) throw new Error('expected runnable execution');
    const result = await exec.execute({
      turnId: 't1',
      toolCallId: 'tc1',
      signal: coordinator.signal,
    });

    // Swarm still completes (synthesis ran) despite the stalled worker.
    expect('output' in result && result.output).toBe('SYNTH');
    // The coordinator signal was never aborted by the per-worker stall.
    expect(coordinator.signal.aborted).toBe(false);
    // The synthesizer prompt records the worker as failed with the
    // distinguishable stalled reason.
    expect(synthesizerPrompt).toMatch(/stalled/i);
    expect(synthesizerPrompt).toContain('Read');
  });
});
