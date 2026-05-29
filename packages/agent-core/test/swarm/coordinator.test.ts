import { describe, expect, it, vi } from 'vitest';

import { SwarmCoordinator } from '../../src/agent/swarm/coordinator';
import type { SpawnSubagentFn } from '../../src/agent/swarm/types';

const PLAN_JSON = JSON.stringify({
  subtasks: [
    { role: 'Researcher', systemPrompt: 'sp-research', prompt: 'p-research' },
    { role: 'Analyst', systemPrompt: 'sp-analyst', prompt: 'p-analyst', toolAllowlist: ['Read'] },
  ],
});

function makeSpawner(byProfile: Record<string, string>): SpawnSubagentFn {
  return vi.fn(async (args) => {
    if (args.profileName === 'swarm-planner') return { result: '```json\n' + PLAN_JSON + '\n```' };
    if (args.profileName === 'swarm-synthesizer') return { result: 'FINAL ANSWER' };
    const key = args.profileName;
    return { result: byProfile[key] ?? `done:${args.description}` };
  });
}

describe('SwarmCoordinator.run', () => {
  it('plans, runs workers concurrently, and synthesizes', async () => {
    const spawn = makeSpawner({});
    const coordinator = new SwarmCoordinator({
      spawnSubagent: spawn,
      signal: new AbortController().signal,
      maxConcurrency: 4,
    });

    const result = await coordinator.run('do a thing');

    expect(result).toBe('FINAL ANSWER');
    const calls = (spawn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(calls).toHaveLength(4);
    expect(calls[0].profileName).toBe('swarm-planner');
    expect(calls.some((c) => c.profileName === 'swarm:Researcher' && c.systemPrompt === 'sp-research')).toBe(true);
    expect(calls.some((c) => c.profileName === 'swarm:Analyst' && c.tools.includes('Read'))).toBe(true);
    expect(calls[calls.length - 1].profileName).toBe('swarm-synthesizer');
  });

  it('retries planning once on invalid JSON, then succeeds', async () => {
    let first = true;
    const spawn: SpawnSubagentFn = vi.fn(async (args) => {
      if (args.profileName === 'swarm-planner') {
        if (first) {
          first = false;
          return { result: 'not json at all' };
        }
        return { result: PLAN_JSON };
      }
      if (args.profileName === 'swarm-synthesizer') return { result: 'OK' };
      return { result: 'worker-done' };
    });
    const coordinator = new SwarmCoordinator({ spawnSubagent: spawn, signal: new AbortController().signal });
    const result = await coordinator.run('x');
    expect(result).toBe('OK');
  });

  it('throws when planning fails twice', async () => {
    const spawn: SpawnSubagentFn = vi.fn(async () => ({ result: 'never json' }));
    const coordinator = new SwarmCoordinator({ spawnSubagent: spawn, signal: new AbortController().signal });
    await expect(coordinator.run('x')).rejects.toThrow(/valid plan/i);
  });

  it('records a failed worker and still synthesizes', async () => {
    const spawn: SpawnSubagentFn = vi.fn(async (args) => {
      if (args.profileName === 'swarm-planner') return { result: PLAN_JSON };
      if (args.profileName === 'swarm-synthesizer') return { result: 'SYNTH' };
      if (args.profileName === 'swarm:Researcher') throw new Error('boom');
      return { result: 'analyst-done' };
    });
    const onProgress = vi.fn();
    const coordinator = new SwarmCoordinator({
      spawnSubagent: spawn,
      signal: new AbortController().signal,
      onProgress,
    });
    const result = await coordinator.run('x');
    expect(result).toBe('SYNTH');
    expect(onProgress.mock.calls.some((c) => /failed/i.test(String(c[0])))).toBe(true);
  });
});
