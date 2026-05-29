import { describe, expect, it, vi } from 'vitest';

import { SwarmTool } from '../../src/tools/builtin/collaboration/swarm';
import type { SessionSubagentHost } from '../../src/session/subagent-host';

const PLAN_JSON = JSON.stringify({
  subtasks: [{ role: 'R', systemPrompt: 'sp', prompt: 'p' }],
});

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
});
