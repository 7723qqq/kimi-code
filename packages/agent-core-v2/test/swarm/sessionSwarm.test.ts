import { describe, expect, it, vi } from 'vitest';

import {
  AgentRunBatch,
  resolveSwarmMaxConcurrency,
  type AgentRunBatchLauncher,
  type AgentSpawnAttemptOptions,
  type QueuedAgentRunTask,
} from '#/session/swarm/agentRunBatch';

describe('resolveSwarmMaxConcurrency', () => {
  it('returns undefined when the variable is unset', () => {
    expect(resolveSwarmMaxConcurrency({})).toBeUndefined();
  });

  it('returns undefined for empty or whitespace-only values', () => {
    expect(
      resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '' }),
    ).toBeUndefined();
    expect(
      resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '   ' }),
    ).toBeUndefined();
  });

  it('throws for non-positive, non-integer, or non-numeric values', () => {
    for (const raw of ['0', '-1', '2.5', 'abc']) {
      expect(() =>
        resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: raw }),
      ).toThrow(/KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY.*positive integer/);
    }
  });

  it('returns the integer for a positive integer value', () => {
    expect(resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: '3' })).toBe(3);
    expect(resolveSwarmMaxConcurrency({ KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY: ' 8 ' })).toBe(8);
  });
});

describe('AgentRunBatch swarm item forwarding', () => {
  function recordingLauncher() {
    const spawned: AgentSpawnAttemptOptions[] = [];
    let nextId = 1;
    const launcher: AgentRunBatchLauncher = {
      spawn: vi.fn(async (options) => {
        spawned.push(options);
        return {
          agentId: `agent-${String(nextId++)}`,
          profileName: options.profileName,
          completion: Promise.resolve({ result: 'ok' }),
        };
      }),
      resume: vi.fn(async () => {
        throw new Error('unexpected resume');
      }),
      retry: vi.fn(async () => {
        throw new Error('unexpected retry');
      }),
    };
    return { launcher, spawned };
  }

  function spawnTask(swarmItem?: string): QueuedAgentRunTask {
    return {
      kind: 'spawn',
      data: {},
      profileName: 'subagent',
      parentToolCallId: 'call_swarm',
      prompt: 'Review the file',
      description: 'Review #1 (subagent)',
      swarmItem,
      runInBackground: false,
    };
  }

  it('forwards swarmItem from a spawn task to launcher.spawn', async () => {
    const { launcher, spawned } = recordingLauncher();

    const results = await new AgentRunBatch(launcher, [spawnTask('src/a.ts')]).run();

    expect(launcher.spawn).toHaveBeenCalledOnce();
    expect(spawned[0]).toMatchObject({
      profileName: 'subagent',
      swarmItem: 'src/a.ts',
    });
    expect(results).toMatchObject([{ status: 'completed', agentId: 'agent-1' }]);
  });

  it('leaves swarmItem undefined for spawn tasks without one', async () => {
    const { launcher, spawned } = recordingLauncher();

    await new AgentRunBatch(launcher, [spawnTask()]).run();

    expect(launcher.spawn).toHaveBeenCalledOnce();
    expect(spawned[0]?.swarmItem).toBeUndefined();
  });
});
