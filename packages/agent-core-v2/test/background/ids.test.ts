import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';

import type { KaosProcess } from '@moonshot-ai/kaos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentBackgroundTask,
  IBackgroundService,
  ProcessBackgroundTask,
} from '#/background';
import type { SessionSubagentHost, SubagentHandle } from '#/subagentHost';
import { createTestAgent, type TestAgentContext } from '../harness';
import { createBackgroundTaskPersistence } from './stubs';

function registerProcess(
  manager: IBackgroundService,
  proc: KaosProcess,
  command: string,
  description: string,
): string {
  return manager.registerTask(new ProcessBackgroundTask(proc, command, description));
}

function agentTask(
  completion: Promise<{ result: string }>,
  description: string,
): AgentBackgroundTask {
  const handle: SubagentHandle = {
    agentId: 'agent-child',
    profileName: 'coder',
    resumed: false,
    completion,
  };
  return new AgentBackgroundTask(
    handle,
    description,
    { markActiveChildDetached: vi.fn() } as unknown as Pick<
      SessionSubagentHost,
      'markActiveChildDetached'
    >,
    new AbortController(),
  );
}

function pendingProcess(): KaosProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 54321,
    exitCode: null,
    wait: () => new Promise<number>(() => {}),
    kill: vi.fn().mockResolvedValue(undefined) as KaosProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as KaosProcess['dispose'],
  };
}

describe('background task id format', () => {
  let ctx: TestAgentContext;
  let background: IBackgroundService;

  beforeEach(() => {
    ctx = createTestAgent();
    background = ctx.get(IBackgroundService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('assigns bash-prefixed ids to process tasks', () => {
    const id = registerProcess(background, pendingProcess(), 'sleep 60', 'process task');

    expect(id).toMatch(/^bash-[0-9a-z]{8}$/);
    expect(background.getTask(id)).toMatchObject({ taskId: id, kind: 'process' });
  });

  it('assigns agent-prefixed ids to agent tasks', () => {
    const id = background.registerTask(
      agentTask(new Promise(() => {}), 'agent task'),
    );

    expect(id).toMatch(/^agent-[0-9a-z]{8}$/);
    expect(background.getTask(id)).toMatchObject({ taskId: id, kind: 'agent' });
  });

  it('rejects malformed ids at the persistence path boundary', () => {
    const persistence = createBackgroundTaskPersistence('/tmp/kimi-bg-id-test');
    const rejected = [
      '',
      'x',
      '-bash',
      'BASH-12345678',
      'bash_12345678',
      '../escape',
      'bash-1234567',
      'bash-123456789',
      'agent-ABCDEFGH',
      'bg_12345678',
      'a'.repeat(26),
    ];

    for (const bad of rejected) {
      expect(() => persistence.taskOutputFile(bad)).toThrow(/Invalid task id/);
    }
  });
});
