import {
  IAgentTaskService,
  IEventBus,
  TaskStarted,
  TaskTerminatedNotice,
  type AgentTaskInfo,
  type IAgentScopeHandle,
} from '@moonshot-ai/agent-core-v2';
import type { Event2 } from '@moonshot-ai/agent-core-v2/app/event/event2';
import { describe, expect, it } from 'bun:test';

import { SessionTaskFeed } from '../src/transport/ws/v1/sessionTaskFeed';

class FakeBus {
  declare readonly _serviceBrand: undefined;
  private readonly listeners = new Set<(event: Event2) => void>();

  emit(event: Event2): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  subscribe(handler: (event: Event2) => void): { dispose(): void } {
    this.listeners.add(handler);
    return { dispose: () => this.listeners.delete(handler) };
  }

  publish(): void {}

  subscribeAgent(): { dispose(): void } {
    return { dispose: () => {} };
  }
}

interface FakeServices {
  tasks?: {
    list: (activeOnly?: boolean, limit?: number) => readonly AgentTaskInfo[];
    onDidChangeTask: (listener: (info: AgentTaskInfo) => void) => { dispose(): void };
  };
  bus?: FakeBus;
}

function handleWith(id: string, services: FakeServices): IAgentScopeHandle {
  return {
    accessor: {
      get: (token: unknown) => {
        if (token === IAgentTaskService) return services.tasks;
        if (token === IEventBus) return services.bus;
        throw new Error('unexpected service');
      },
    },
  } as unknown as IAgentScopeHandle;
}

function swarmTask(status: AgentTaskInfo['status']): AgentTaskInfo {
  return {
    taskId: 'agent-swarm-1',
    description: '3-way explore #0 (explore)',
    status,
    detached: false,
    startedAt: 1_700_000_001_000,
    endedAt: status === 'running' ? null : 1_700_000_006_000,
    kind: 'agent',
    agentId: 'agent-1',
    subagentType: 'explore',
    swarmIndex: 0,
  };
}

function shellTask(status: AgentTaskInfo['status']): AgentTaskInfo {
  return {
    taskId: 'bash-1',
    description: 'sleep 30',
    status,
    detached: false,
    startedAt: 1_700_000_001_000,
    endedAt: null,
    kind: 'process',
    command: 'sleep 30',
    pid: 4321,
    exitCode: null,
  };
}

describe('SessionTaskFeed', () => {
  it('pushes swarm task events observed on the agent bus', () => {
    const changes: Array<{ agentId: string; info: AgentTaskInfo }> = [];
    const bus = new FakeBus();
    const main = handleWith('main', {
      bus,
      tasks: {
        list: () => [],
        onDidChangeTask: () => ({ dispose: () => {} }),
      },
    });
    const lifecycle = {
      list: () => [{ agentId: 'main' }],
      onDidCreate: () => ({ dispose: () => {} }),
      onDidClose: () => ({ dispose: () => {} }),
      handleOf: (agentId: string) => (agentId === 'main' ? main : undefined),
    };
    const feed = new SessionTaskFeed(
      lifecycle as never,
      (agentId, info) => changes.push({ agentId, info }),
    );

    bus.emit(new TaskStarted({ agentId: 'main', info: swarmTask('running') }));
    bus.emit(new TaskStarted({ agentId: 'child', info: swarmTask('running') }));
    bus.emit(new TaskStarted({ agentId: 'main', info: shellTask('running') }));
    bus.emit(new TaskTerminatedNotice({ agentId: 'main', info: swarmTask('completed') }));

    expect(changes.map((change) => change.info.taskId)).toEqual([
      'agent-swarm-1',
      'agent-swarm-1',
    ]);
    expect(changes[0]!.info.status).toBe('running');
    expect(changes[1]!.info.status).toBe('completed');
    feed.dispose();
  });

  it('keeps shell tasks flowing through the task service only', () => {
    const changes: Array<{ agentId: string; info: AgentTaskInfo }> = [];
    const bus = new FakeBus();
    let emitChange: ((info: AgentTaskInfo) => void) | undefined;
    const main = handleWith('main', {
      bus,
      tasks: {
        list: () => [],
        onDidChangeTask: (listener: (info: AgentTaskInfo) => void) => {
          emitChange = listener;
          return { dispose: () => {} };
        },
      },
    });
    const lifecycle = {
      list: () => [{ agentId: 'main' }],
      onDidCreate: () => ({ dispose: () => {} }),
      onDidClose: () => ({ dispose: () => {} }),
      handleOf: (agentId: string) => (agentId === 'main' ? main : undefined),
    };
    new SessionTaskFeed(lifecycle as never, (agentId, info) =>
      changes.push({ agentId, info }),
    ).dispose();

    emitChange!(shellTask('running'));
    bus.emit(new TaskStarted({ agentId: 'main', info: shellTask('running') }));

    expect(changes).toHaveLength(1);
    expect(changes[0]!.info.taskId).toBe('bash-1');
  });
});
