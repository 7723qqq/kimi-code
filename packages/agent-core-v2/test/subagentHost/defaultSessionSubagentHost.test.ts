import { describe, expect, it, vi } from 'vitest';

import { APIProviderRateLimitError } from '@moonshot-ai/kosong';

import { IAgentLifecycleService } from '#/session/agent-lifecycle';
import type { IScopeHandle } from '#/_base/di/scope';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentEventSinkService } from '#/agent/eventSink';
import { IAgentExternalHooksService } from '#/agent/externalHooks';
import {
  DenyAllPermissionPolicyService,
  IAgentPermissionPolicyService,
} from '#/agent/permissionPolicy';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentPromptService } from '#/agent/prompt';
import { IAgentSystemReminderService } from '#/agent/systemReminder';
import { ITelemetryService } from '#/app/telemetry';
import { IAgentUsageService } from '#/agent/usage';
import { DefaultSessionSubagentHost } from '#/session/subagentHost/defaultSessionSubagentHost';

const CHILD_SUMMARY = 'child summary '.repeat(20);

interface FakeScopeOptions {
  readonly result?: Promise<{ reason: string; error?: unknown }>;
  readonly events?: unknown[];
  readonly initialText?: string;
  readonly parentMessages?: readonly unknown[];
  readonly ready?: Promise<void>;
}

function mockOf(fn: unknown): { mock: { calls: unknown[][]; results: Array<{ value: unknown }> } } {
  return fn as { mock: { calls: unknown[][]; results: Array<{ value: unknown }> } };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function fakeScope(id: string, options: FakeScopeOptions = {}): IScopeHandle {
  const {
    result = Promise.resolve({ reason: 'completed' }),
    events = [],
    initialText = CHILD_SUMMARY,
    parentMessages,
    ready = Promise.resolve(),
  } = options;
  const profile = {
    data: vi.fn(() => ({
      cwd: '/repo',
      modelAlias: 'parent-model',
      thinkingLevel: 'medium',
      systemPrompt: 'parent prompt',
      activeToolNames: ['Read', 'Write'] as readonly string[],
      profileName: 'agent',
    })),
    update: vi.fn(),
  };
  const messages: Array<{
    role: string;
    content: Array<{ type: string; text: string }>;
    toolCalls: never[];
    origin?: unknown;
  }> =
    parentMessages !== undefined
      ? (parentMessages as typeof messages)
      : [{ role: 'assistant', content: [{ type: 'text', text: initialText }], toolCalls: [] }];
  const context = {
    get: vi.fn(() => messages),
    splice: vi.fn((start: number, deleteCount: number, inserted: readonly unknown[]) => {
      messages.splice(start, deleteCount, ...(inserted as typeof messages));
    }),
  };
  const prompt = {
    prompt: vi.fn((message: { content: Array<{ type: string; text: string }> }) => {
      const text = message.content[0]?.text ?? '';
      if (text.includes('comprehensive summary')) {
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: 'x'.repeat(220) }],
          toolCalls: [],
        });
      }
      return {
        id: 1,
        abortController: new AbortController(),
        ready,
        result,
      };
    }),
    retry: vi.fn(() => ({
      id: 2,
      abortController: new AbortController(),
      ready,
      result,
    })),
  };
  const usage = {
    status: vi.fn(() => ({ total: { input: 1, output: 2, cache_read: 0, cache_write: 0 } })),
  };
  const systemReminder = {
    appendSystemReminder: vi.fn((content: string, origin: unknown) => {
      const message = {
        role: 'user',
        content: [{ type: 'text', text: content }],
        toolCalls: [],
        origin,
      };
      messages.push(message as (typeof messages)[number]);
      return message;
    }),
  };
  const permissionPolicy = {
    registerPolicy: vi.fn(() => ({ dispose: () => {} })),
  };
  const externalHooks = {
    triggerSubagentStart: vi.fn().mockResolvedValue(undefined),
    triggerSubagentStop: vi.fn(),
  };
  const telemetry = {
    track: vi.fn(),
  };
  return {
    id,
    accessor: {
      get: vi.fn((token: unknown) => {
        if (token === IAgentProfileService) return profile;
        if (token === IAgentPromptService) return prompt;
        if (token === IAgentContextMemoryService) return context;
        if (token === IAgentUsageService) return usage;
        if (token === IAgentEventSinkService) return { emit: (event: unknown) => events.push(event) };
        if (token === IAgentSystemReminderService) return systemReminder;
        if (token === IAgentPermissionPolicyService) return permissionPolicy;
        if (token === IAgentExternalHooksService) return externalHooks;
        if (token === ITelemetryService) return telemetry;
        return undefined;
      }),
    },
  } as unknown as IScopeHandle;
}

function makeAgents(parent: IScopeHandle, children: Record<string, IScopeHandle> | (() => IScopeHandle)) {
  return {
    getHandle: vi.fn((id: string) => {
      if (id === 'main') return parent;
      if (typeof children === 'function') return undefined;
      return children[id];
    }),
    createMain: vi.fn(),
    create: vi.fn().mockImplementation(() => {
      if (typeof children === 'function') return Promise.resolve(children());
      return Promise.resolve(children['child'] ?? Object.values(children)[0]);
    }),
  };
}

describe('DefaultSessionSubagentHost', () => {
  it('aborts a running subagent when the caller signal aborts', async () => {
    const parent = fakeScope('main');
    const child = fakeScope('child', { result: new Promise(() => {}) });
    const agents = makeAgents(parent, { child });
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');
    const controller = new AbortController();

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Run long task',
      description: 'Long task',
      runInBackground: false,
      signal: controller.signal,
    });
    controller.abort();

    await expect(handle.completion).rejects.toBeDefined();
  });

  it('emits subagent spawned and started events', async () => {
    const events: unknown[] = [];
    const parent = fakeScope('main', { events });
    const child = fakeScope('child');
    const agents = makeAgents(parent, { child });
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Explore the repo',
      description: 'Explore repo',
      runInBackground: false,
      signal: new AbortController().signal,
    });
    await handle.completion;

    expect(events).toEqual([
      expect.objectContaining({ type: 'subagent.spawned', subagentId: 'child', subagentName: 'explore' }),
      expect.objectContaining({ type: 'subagent.started', subagentId: 'child' }),
      expect.objectContaining({
        type: 'subagent.completed',
        subagentId: 'child',
        resultSummary: CHILD_SUMMARY,
        usage: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
      }),
    ]);
  });

  it('asks for a continuation when the first summary is too short', async () => {
    const parent = fakeScope('main', { initialText: 'short' });
    const child = fakeScope('child', { initialText: 'short' });
    const agents = makeAgents(parent, { child });
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Implement',
      description: 'Implement',
      runInBackground: false,
      signal: new AbortController().signal,
    });

    const completion = await handle.completion;
    expect(completion.result.length).toBeGreaterThanOrEqual(200);
    expect(completion.result).toBe('x'.repeat(220));
  });

  it('persists and exposes swarmItem for spawned subagents', async () => {
    const parent = fakeScope('main');
    const child = fakeScope('child');
    const agents = makeAgents(parent, { child });
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

    await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Swarm task',
      description: 'Swarm task',
      runInBackground: false,
      swarmItem: 'item-1',
      signal: new AbortController().signal,
    });

    expect(host.getSwarmItem('child')).toBe('item-1');
    expect(agents.create).toHaveBeenCalledWith({
      parentAgentId: 'main',
      cwd: '/repo',
      type: 'sub',
      swarmItem: 'item-1',
    });
  });

  it('rejects resuming a subagent owned by another parent', async () => {
    const child = fakeScope('child');
    const agents = {
      getHandle: vi.fn((id: string) => (id === 'child' ? child : undefined)),
      createMain: vi.fn(),
      create: vi.fn(),
    };
    const metadata = {
      read: vi.fn().mockResolvedValue({
        agents: {
          child: { homedir: '/repo/agents/child', type: 'sub', parentAgentId: 'other-parent' },
        },
      }),
    };
    const host = new DefaultSessionSubagentHost(
      agents as unknown as IAgentLifecycleService,
      'main',
      metadata as never,
    );

    await expect(
      host.resume('child', {
        parentToolCallId: 'call_agent',
        prompt: 'Continue',
        description: 'Continue',
        runInBackground: false,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('does not belong');
  });

  it('emits subagent.failed when the child turn fails', async () => {
    const events: unknown[] = [];
    const parent = fakeScope('main', {
      result: Promise.resolve({ reason: 'failed', error: new Error('boom') }),
      events,
    });
    const child = fakeScope('child', {
      result: Promise.resolve({ reason: 'failed', error: new Error('boom') }),
    });
    const agents = makeAgents(parent, { child });
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Do work',
      description: 'Do work',
      runInBackground: false,
      signal: new AbortController().signal,
    });

    await expect(handle.completion).rejects.toThrow('boom');
    expect(events).toEqual([
      expect.objectContaining({ type: 'subagent.spawned', subagentId: 'child' }),
      expect.objectContaining({ type: 'subagent.started', subagentId: 'child' }),
      expect.objectContaining({ type: 'subagent.failed', subagentId: 'child', error: 'boom' }),
    ]);
  });

  it('treats timeout aborts as subagent failures, not user cancellations', async () => {
    const events: unknown[] = [];
    const parent = fakeScope('main', { result: new Promise(() => {}), events });
    const child = fakeScope('child', { result: new Promise(() => {}) });
    const agents = makeAgents(parent, { child });
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');
    const controller = new AbortController();

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Run long task',
      description: 'Long task',
      runInBackground: false,
      signal: controller.signal,
    });
    controller.abort('Timed out');

    await expect(handle.completion).rejects.toBe('Timed out');
    expect(events).toEqual([
      expect.objectContaining({ type: 'subagent.spawned', subagentId: 'child' }),
      expect.objectContaining({ type: 'subagent.started', subagentId: 'child' }),
      expect.objectContaining({ type: 'subagent.failed', subagentId: 'child', error: 'Timed out' }),
    ]);
  });

  it('resumes an existing child agent and returns completion summary', async () => {
    const events: unknown[] = [];
    const parent = fakeScope('main', { events });
    const child = fakeScope('child');
    const agents = {
      getHandle: vi.fn((id: string) => (id === 'child' ? child : id === 'main' ? parent : undefined)),
      createMain: vi.fn(),
      create: vi.fn(),
    };
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

    const handle = await host.resume('child', {
      parentToolCallId: 'call_agent',
      prompt: 'Continue',
      description: 'Continue',
      runInBackground: false,
      signal: new AbortController().signal,
    });

    await expect(handle.completion).resolves.toEqual({
      result: CHILD_SUMMARY,
      usage: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
    });
    expect(handle.resumed).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({ type: 'subagent.spawned', subagentId: 'child' }),
      expect.objectContaining({ type: 'subagent.started', subagentId: 'child' }),
      expect.objectContaining({ type: 'subagent.completed', subagentId: 'child' }),
    ]);
  });

  it('builds a side-question child that projects history, denies tools, and adds the reminder', async () => {
    const parentMessages = [
      { role: 'user', content: [{ type: 'text', text: 'earlier question' }], toolCalls: [] },
      { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }], toolCalls: [] },
    ];
    const parent = fakeScope('main', { parentMessages });
    const child = fakeScope('btw-child');
    const agents = makeAgents(parent, { 'btw-child': child });
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

    await expect(host.startBtw()).resolves.toBe('btw-child');
    expect(agents.create).toHaveBeenCalledWith({ parentAgentId: 'main', type: 'sub' });

    // Loop tools copied from the parent for prompt-cache parity.
    const childProfile = child.accessor.get(IAgentProfileService);
    expect(childProfile.update).toHaveBeenCalledWith(
      expect.objectContaining({
        modelAlias: 'parent-model',
        thinkingLevel: 'medium',
        systemPrompt: 'parent prompt',
        activeToolNames: ['Read', 'Write'],
      }),
    );

    // Parent history projected into the child.
    const childContext = child.accessor.get(IAgentContextMemoryService);
    expect(childContext.splice).toHaveBeenCalledWith(0, 0, parentMessages);

    // Side-question reminder appended.
    const childReminder = child.accessor.get(IAgentSystemReminderService);
    expect(childReminder.appendSystemReminder).toHaveBeenCalledWith(
      expect.stringContaining('side-channel conversation'),
      { kind: 'system_trigger', name: 'btw' },
    );

    // Every tool call denied.
    const childPermission = child.accessor.get(IAgentPermissionPolicyService);
    expect(childPermission.registerPolicy).toHaveBeenCalledTimes(1);
    const policy = mockOf(childPermission.registerPolicy).mock.calls[0]?.[0];
    expect(policy).toBeInstanceOf(DenyAllPermissionPolicyService);
  });

  it('runs queued subagent tasks to completion', async () => {
    const parent = fakeScope('main');
    const child = fakeScope('child');
    const agents = makeAgents(parent, { child });
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

    const results = await host.runQueued([
      {
        kind: 'spawn',
        data: {},
        profileName: 'coder',
        parentToolCallId: 'call_agent',
        prompt: 'Queued task',
        description: 'Queued task',
        runInBackground: false,
      },
    ]);

    expect(results).toEqual([
      expect.objectContaining({ status: 'completed', agentId: 'child', result: CHILD_SUMMARY }),
    ]);
  });

  it('passes the swarm maxConcurrency env cap through to the batch', async () => {
    const previous = process.env['KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY'];
    process.env['KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY'] = '2';
    try {
      const parent = fakeScope('main');
      const pending: Array<ReturnType<typeof deferred<{ reason: string }>>> = [];
      const agents = makeAgents(parent, () => {
        const d = deferred<{ reason: string }>();
        pending.push(d);
        return fakeScope(`child-${pending.length}`, { result: d.promise });
      });
      const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

      const tasks = Array.from({ length: 4 }, (_, index) => ({
        kind: 'spawn' as const,
        data: {},
        profileName: 'coder',
        parentToolCallId: 'call_agent',
        prompt: `task ${index}`,
        description: `task ${index}`,
        runInBackground: false,
      }));
      const run = host.runQueued(tasks);
      void run.catch(() => {});
      const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

      // The cap stops the launch burst at 2 even though 4 tasks are queued.
      await flush();
      expect(agents.create).toHaveBeenCalledTimes(2);

      // Completing one task frees a slot so the next queued task launches.
      pending[0]?.resolve({ reason: 'completed' });
      await flush();
      expect(agents.create).toHaveBeenCalledTimes(3);

      // Completing another task launches the final queued task.
      pending[1]?.resolve({ reason: 'completed' });
      await flush();
      expect(agents.create).toHaveBeenCalledTimes(4);

      // Drain the remaining attempts so the batch settles.
      pending[2]?.resolve({ reason: 'completed' });
      pending[3]?.resolve({ reason: 'completed' });
      await run;
    } finally {
      if (previous === undefined) delete process.env['KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY'];
      else process.env['KIMI_CODE_AGENT_SWARM_MAX_CONCURRENCY'] = previous;
    }
  });

  it('marks an active child as detached', async () => {
    const parent = fakeScope('main', { result: new Promise(() => {}) });
    const child = fakeScope('child', { result: new Promise(() => {}) });
    const agents = makeAgents(parent, { child });
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

    await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Run detached task',
      description: 'Detached task',
      runInBackground: false,
      signal: new AbortController().signal,
    });

    host.markActiveChildDetached('child');
    expect((host as unknown as { activeChildren: Map<string, { runInBackground: boolean }> }).activeChildren.get('child')?.runInBackground).toBe(true);
  });

  it('spawns a child agent and returns its completion summary', async () => {
    const parent = fakeScope('main');
    const child = fakeScope('child');
    const agents = makeAgents(parent, { child });
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Explore the repo',
      description: 'Explore repo',
      runInBackground: false,
      signal: new AbortController().signal,
    });

    await expect(handle.completion).resolves.toEqual({
      result: CHILD_SUMMARY,
      usage: { input: 1, output: 2, cache_read: 0, cache_write: 0 },
    });
    expect(agents.create).toHaveBeenCalledWith({
      parentAgentId: 'main',
      cwd: '/repo',
      type: 'sub',
      swarmItem: undefined,
    });
  });

  it('fires SubagentStart and SubagentStop external hooks around the turn', async () => {
    const parent = fakeScope('main');
    const child = fakeScope('child');
    const agents = makeAgents(parent, { child });
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Explore the repo',
      description: 'Explore repo',
      runInBackground: false,
      signal: new AbortController().signal,
    });
    await handle.completion;

    const hooks = parent.accessor.get(IAgentExternalHooksService);
    expect(hooks.triggerSubagentStart).toHaveBeenCalledWith(
      { agentName: 'explore', prompt: 'Explore the repo' },
      expect.anything(),
    );
    expect(hooks.triggerSubagentStop).toHaveBeenCalledWith({
      agentName: 'explore',
      response: CHILD_SUMMARY,
    });
  });

  it('tracks subagent_created telemetry on spawn', async () => {
    const parent = fakeScope('main');
    const child = fakeScope('child');
    const agents = makeAgents(parent, { child });
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Do work',
      description: 'Do work',
      runInBackground: true,
      signal: new AbortController().signal,
    });
    await handle.completion;

    const telemetry = parent.accessor.get(ITelemetryService);
    expect(telemetry.track).toHaveBeenCalledWith('subagent_created', {
      subagent_name: 'coder',
      run_in_background: true,
    });
  });

  it('fires onReady on the first turn activity rather than synchronously at launch', async () => {
    const ready = deferred<void>();
    const parent = fakeScope('main');
    const child = fakeScope('child', { ready: ready.promise });
    const agents = makeAgents(parent, { child });
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');
    const onReady = vi.fn();

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Do work',
      description: 'Do work',
      runInBackground: false,
      signal: new AbortController().signal,
      onReady,
    });

    // Not fired synchronously at launch.
    expect(onReady).not.toHaveBeenCalled();
    ready.resolve();
    await handle.completion;
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('retries the existing turn in place instead of re-prompting', async () => {
    const parent = fakeScope('main');
    const child = fakeScope('child');
    const agents = {
      getHandle: vi.fn((id: string) => (id === 'child' ? child : id === 'main' ? parent : undefined)),
      createMain: vi.fn(),
      create: vi.fn(),
    };
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

    const handle = await host.retry('child', {
      parentToolCallId: 'call_agent',
      prompt: 'ignored on retry',
      description: 'Retry',
      runInBackground: false,
      signal: new AbortController().signal,
    });
    await handle.completion;

    const prompt = child.accessor.get(IAgentPromptService);
    expect(prompt.retry).toHaveBeenCalledWith('agent-host');
    expect(prompt.prompt).not.toHaveBeenCalled();
  });

  it('classifies a filtered turn as a provider safety policy block', async () => {
    const parent = fakeScope('main');
    const child = fakeScope('child', { result: Promise.resolve({ reason: 'filtered' }) });
    const agents = makeAgents(parent, { child });
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Do work',
      description: 'Do work',
      runInBackground: false,
      signal: new AbortController().signal,
    });

    await expect(handle.completion).rejects.toThrow('blocked by provider safety policy');
  });

  it('rethrows a provider rate limit as an APIProviderRateLimitError', async () => {
    const parent = fakeScope('main');
    const child = fakeScope('child', {
      result: Promise.resolve({
        reason: 'failed',
        error: new APIProviderRateLimitError('slow down', null),
      }),
    });
    const agents = makeAgents(parent, { child });
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Do work',
      description: 'Do work',
      runInBackground: false,
      signal: new AbortController().signal,
    });

    await expect(handle.completion).rejects.toSatisfy((error) => error instanceof APIProviderRateLimitError);
  });

  it('emits subagent.suspended when a queued attempt is requeued', () => {
    const events: unknown[] = [];
    const parent = fakeScope('main', { events });
    const agents = makeAgents(parent, {});
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

    host.suspended({
      task: {
        kind: 'spawn',
        data: {},
        profileName: 'coder',
        parentToolCallId: 'call_agent',
        prompt: 'task',
        description: 'task',
        runInBackground: false,
      },
      agentId: 'child-1',
      reason: 'Provider rate limit; subagent requeued for retry.',
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: 'subagent.suspended',
        subagentId: 'child-1',
        reason: 'Provider rate limit; subagent requeued for retry.',
      }),
    ]);
  });

  it('cancels every foreground active child with the provided reason', async () => {
    const parent = fakeScope('main');
    const child = fakeScope('child', { result: new Promise(() => {}) });
    const agents = makeAgents(parent, { child });
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

    const handle = await host.spawn({
      profileName: 'coder',
      parentToolCallId: 'call_agent',
      prompt: 'Run long task',
      description: 'Long task',
      runInBackground: false,
      signal: new AbortController().signal,
    });
    void handle.completion.catch(() => {});
    // Let the SubagentStart hook resolve so the turn is launched.
    await Promise.resolve();
    await Promise.resolve();

    const prompt = child.accessor.get(IAgentPromptService);
    const turn = mockOf(prompt.prompt).mock.results[0]?.value as { abortController: AbortController };
    host.cancelAll('user-stop');

    expect(turn.abortController.signal.aborted).toBe(true);
    expect(turn.abortController.signal.reason).toBe('user-stop');
  });

  it('composes the explore system prompt from the parent prompt plus the explore role', async () => {
    const parent = fakeScope('main');
    const child = fakeScope('child');
    const agents = makeAgents(parent, { child });
    const host = new DefaultSessionSubagentHost(agents as unknown as IAgentLifecycleService, 'main');

    const handle = await host.spawn({
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      prompt: 'Explore the repo',
      description: 'Explore repo',
      runInBackground: false,
      signal: new AbortController().signal,
    });
    await handle.completion;

    const childProfile = child.accessor.get(IAgentProfileService);
    const updateCall = mockOf(childProfile.update).mock.calls[0]?.[0] as {
      systemPrompt: string;
      activeToolNames: readonly string[];
    };
    expect(updateCall.systemPrompt).toContain('parent prompt');
    expect(updateCall.systemPrompt).toContain('codebase exploration specialist');
    expect(updateCall.systemPrompt).toContain('EXCLUSIVELY');
    expect(updateCall.activeToolNames).toEqual(
      expect.arrayContaining(['Bash', 'Read', 'Glob', 'Grep', 'WebSearch', 'FetchURL']),
    );
  });
});
