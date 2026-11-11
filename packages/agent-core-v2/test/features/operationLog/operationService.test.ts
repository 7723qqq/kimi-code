import { afterAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';

import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type { IConfigService } from '#/app/config/config';
import type { IFlagService } from '#/app/flag/flag';
import { OPERATION_LOG_SECTION } from '#/features/operationLog/configSection';
import { OPERATION_LOG_FLAG_ID } from '#/features/operationLog/flag';
import type { OperationLogRetention } from '#/features/operationLog/operationLog';
import { OperationLogStore } from '#/features/operationLog/operationLogStore';
import { AgentOperationService } from '#/features/operationLog/operationService';
import { RepositoryViewService } from '#/features/operationLog/repositoryViewService';
import { OrderedHookSlot } from '#/hooks';
import type { IHostClock } from '#/os/interface/hostClock';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ToolAccesses } from '#/tool/toolContract';
import type { ToolCall } from '#human/llm/message';

import { fakeEnvironment, stubAgentEnvironment } from '../../environment/stubs';

const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
  return stdout.trim();
}

async function createRepo(withGit = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-operation-service-'));
  roots.push(root);
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  if (!withGit) return repo;
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'core.autocrlf', 'false');
  await git(repo, 'config', 'user.email', 'operation-test@example.com');
  await git(repo, 'config', 'user.name', 'Operation Test');
  await writeFile(join(repo, 'a.txt'), 'initial\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial');
  return repo;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function toolCall(id: string, name = 'Write'): ToolCall {
  return { type: 'function', id, name, arguments: '{}' };
}

function context(id: string, name = 'Write', turnId = 7): ResolvedToolExecutionHookContext {
  return {
    turnId,
    signal: new AbortController().signal,
    toolCall: toolCall(id, name),
    toolCalls: [toolCall(id, name)],
    args: {},
    execution: {
      approvalRule: 'Write',
      accesses: ToolAccesses.all(),
      execute: async () => ({ output: 'ok' }),
    },
  };
}

function operationHarness(
  repo: string,
  enabled = true,
  environmentId = 'local',
  retention: Partial<OperationLogRetention> = {},
): {
  readonly hook: OrderedHookSlot<ResolvedToolExecutionHookContext>;
  readonly service: AgentOperationService;
} {
  const hook = new OrderedHookSlot<ResolvedToolExecutionHookContext>();
  const executor = { hooks: { onExecuteTool: hook } } as unknown as IAgentToolExecutorService;
  const flags = {
    enabled: (id: string) => id === OPERATION_LOG_FLAG_ID && enabled,
  } as unknown as IFlagService;
  const clock = { now: () => new Date(1_000), timeZone: () => 'UTC' } as IHostClock;
  const environment = stubAgentEnvironment(fakeEnvironment(environmentId, 'generation-1'), {
    workDir: repo,
  });
  const config = {
    get: (section: string) => (section === OPERATION_LOG_SECTION ? retention : undefined),
  } as unknown as IConfigService;
  const service = new AgentOperationService(
    executor,
    makeSessionContext({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      sessionDir: join(repo, 'session'),
      sessionScope: 'session-1',
      cwd: repo,
    }),
    makeAgentScopeContext({ agentId: 'main', agentScope: 'main' }),
    environment,
    flags,
    clock,
    config,
  );
  return { hook, service };
}

function harness(
  repo: string,
  enabled = true,
  environmentId = 'local',
  retention: Partial<OperationLogRetention> = {},
): OrderedHookSlot<ResolvedToolExecutionHookContext> {
  return operationHarness(repo, enabled, environmentId, retention).hook;
}

function store(repo: string): OperationLogStore {
  return new OperationLogStore(join(repo, '.git', 'kimi-operation-log'));
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('AgentOperationService', () => {
  it('does not create an operation when a tool leaves the view unchanged', async () => {
    const repo = await createRepo();
    const hook = harness(repo);

    await hook.run(context('call-1'), async () => {});

    expect(await store(repo).head()).toBeUndefined();
  });

  it('captures one undoable operation with its before view and tool origin', async () => {
    const repo = await createRepo();
    const hook = harness(repo);

    await hook.run(context('call-1'), async () => {
      await writeFile(join(repo, 'a.txt'), 'changed\n');
    });

    const operations = await store(repo).list();
    expect(operations).toHaveLength(1);
    const operation = operations[0]!;
    expect(operation.kind).toBe('capture');
    const beforeViewId = operation.beforeViewId;
    if (beforeViewId === undefined) throw new Error('Missing before view id');
    expect(operation.origin).toEqual({
      sessionId: 'session-1',
      agentId: 'main',
      turnId: 7,
      toolCallId: 'call-1',
      toolName: 'Write',
    });
    expect(await store(repo).view(beforeViewId)).not.toEqual(
      await store(repo).view(operation.viewId),
    );
    expect((await store(repo).undo({ at: new Date(2_000), description: 'undo' })).viewId).toBe(
      beforeViewId,
    );
  });

  it('rejects execution when the repository changed outside the recorded operations', async () => {
    const repo = await createRepo();
    const hook = harness(repo);
    await hook.run(context('call-1'), async () => {
      await writeFile(join(repo, 'a.txt'), 'recorded\n');
    });
    await writeFile(join(repo, 'a.txt'), 'external\n');
    let executed = false;

    expect(
      await rejectionOf(
        hook.run(context('call-2'), async () => {
          executed = true;
        }),
      ),
    ).toMatchObject({ code: 'view-mismatch' });
    expect(executed).toBe(false);
    expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('external\n');
  });

  it('fails closed before tool execution when the view cannot be captured', async () => {
    const repo = await createRepo(false);
    const hook = harness(repo);
    let executed = false;

    expect(
      await rejectionOf(
        hook.run(context('call-1'), async () => {
          executed = true;
        }),
      ),
    ).toMatchObject({ name: 'GitOperationError' });
    expect(executed).toBe(false);
  });

  it('serializes concurrent foreground captures into a linear history', async () => {
    const repo = await createRepo();
    const hook = harness(repo);
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const events: string[] = [];

    const first = hook.run(context('call-1'), async () => {
      events.push('start:first');
      firstStarted.resolve();
      await releaseFirst.promise;
      await writeFile(join(repo, 'a.txt'), 'first\n');
      events.push('end:first');
    });
    await firstStarted.promise;
    const second = hook.run(context('call-2'), async () => {
      events.push('start:second');
      await writeFile(join(repo, 'b.txt'), 'second\n');
      events.push('end:second');
    });
    await Promise.resolve();
    expect(events).toEqual(['start:first']);
    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(['start:first', 'end:first', 'start:second', 'end:second']);
    const operations = await store(repo).list();
    expect(operations.map((operation) => operation.origin?.toolCallId)).toEqual([
      'call-2',
      'call-1',
    ]);
    expect(operations[0]?.beforeViewId).toBe(operations[1]?.viewId);
  });

  it('uses the configured retention limits when appending operations', async () => {
    const repo = await createRepo();
    const hook = harness(repo, true, 'local', { maxOperations: 1 });
    await hook.run(context('call-1'), async () => {
      await writeFile(join(repo, 'a.txt'), 'first\n');
    });

    expect(
      await rejectionOf(
        hook.run(context('call-2'), async () => {
          await writeFile(join(repo, 'a.txt'), 'second\n');
        }),
      ),
    ).toMatchObject({ code: 'retention-exceeded', details: { limit: 'operations', maximum: 1 } });
    expect(await store(repo).list()).toHaveLength(1);
  });

  it.each(['Agent', 'AgentSwarm'])(
    'does not capture the %s orchestration wrapper around nested tool operations',
    async (name) => {
      const repo = await createRepo();
      const hook = harness(repo);

      await hook.run(context('call-1', name), async () => {
        await writeFile(join(repo, 'a.txt'), 'nested\n');
      });

      expect(await store(repo).head()).toBeUndefined();
    },
  );

  it('rejects tool execution outside the local environment', async () => {
    const repo = await createRepo();
    const hook = harness(repo, true, 'remote');
    let executed = false;

    expect(
      await rejectionOf(
        hook.run(context('call-1'), async () => {
          executed = true;
        }),
      ),
    ).toMatchObject({ code: 'invalid' });
    expect(executed).toBe(false);
  });

  it('restores successive undo and redo operations in the repository', async () => {
    const repo = await createRepo();
    const { hook, service } = operationHarness(repo);
    await hook.run(context('call-1'), async () => {
      await writeFile(join(repo, 'a.txt'), 'first\n');
    });
    await hook.run(context('call-2'), async () => {
      await writeFile(join(repo, 'a.txt'), 'second\n');
    });

    await service.undoOperation();
    expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('first\n');
    await service.undoOperation();
    expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('initial\n');
    await service.redoOperation();
    expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('first\n');
    await service.redoOperation();
    expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('second\n');

    const operations = await service.listOperations();
    expect(operations.map((operation) => operation.kind)).toEqual([
      'redo',
      'redo',
      'undo',
      'undo',
      'capture',
      'capture',
    ]);
    const head = await store(repo).head();
    const operation = await store(repo).get(head!.operationId);
    expect(await service.listOperations()).toHaveLength(6);
    const backend = await RepositoryViewService.open({ repoRoot: repo });
    expect(await store(repo).view(operation.viewId)).toEqual(await backend.captureView());
  });

  it('restores an arbitrary operation and can undo that restoration', async () => {
    const repo = await createRepo();
    const { hook, service } = operationHarness(repo);
    await hook.run(context('call-1'), async () => {
      await writeFile(join(repo, 'a.txt'), 'first\n');
    });
    await hook.run(context('call-2'), async () => {
      await writeFile(join(repo, 'a.txt'), 'second\n');
    });
    const operations = await store(repo).list();

    await service.restoreOperation(operations[1]!.id);
    expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('first\n');
    expect((await store(repo).head())?.redoStack).toEqual([]);

    await service.undoOperation();
    expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('second\n');
  });

  it('restores the view before the earliest operation in the removed turn range', async () => {
    const repo = await createRepo();
    const { hook, service } = operationHarness(repo);
    await hook.run(context('call-1', 'Write', 7), async () => {
      await writeFile(join(repo, 'a.txt'), 'first\n');
    });
    await hook.run(context('call-2', 'Write', 8), async () => {
      await writeFile(join(repo, 'a.txt'), 'second\n');
    });
    await hook.run(context('call-3', 'Write', 9), async () => {
      await writeFile(join(repo, 'a.txt'), 'third\n');
    });
    const before = await store(repo).list();

    const restored = await service.restoreBeforeTurn(8);

    expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('first\n');
    expect(restored).toMatchObject({
      kind: 'restore',
      targetId: before.find((operation) => operation.origin?.toolCallId === 'call-2')?.id,
      beforeViewId: before[0]?.viewId,
      viewId: before.find((operation) => operation.origin?.toolCallId === 'call-1')?.viewId,
    });
    await service.undoOperation();
    expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('third\n');
  });

  it('does not append an operation when the removed turns captured no writes', async () => {
    const repo = await createRepo();
    const { hook, service } = operationHarness(repo);
    await hook.run(context('call-1', 'Write', 7), async () => {
      await writeFile(join(repo, 'a.txt'), 'first\n');
    });
    const before = await store(repo).head();

    await expect(service.restoreBeforeTurn(8)).resolves.toBeUndefined();
    expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('first\n');
    expect(await store(repo).head()).toEqual(before);
  });

  it('rejects restore when the repository differs from the operation head', async () => {
    const repo = await createRepo();
    const { hook, service } = operationHarness(repo);
    await hook.run(context('call-1'), async () => {
      await writeFile(join(repo, 'a.txt'), 'recorded\n');
    });
    await writeFile(join(repo, 'a.txt'), 'external\n');
    const before = await store(repo).head();

    expect(await rejectionOf(service.undoOperation())).toMatchObject({ code: 'view-mismatch' });
    expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('external\n');
    expect(await store(repo).head()).toEqual(before);
  });

  it('rolls the repository back when appending the restore operation fails', async () => {
    const repo = await createRepo();
    const { hook, service } = operationHarness(repo, true, 'local', { maxOperations: 2 });
    await hook.run(context('call-1'), async () => {
      await writeFile(join(repo, 'a.txt'), 'first\n');
    });
    await hook.run(context('call-2'), async () => {
      await writeFile(join(repo, 'a.txt'), 'second\n');
    });
    const before = await store(repo).head();

    expect(await rejectionOf(service.undoOperation())).toMatchObject({
      code: 'retention-exceeded',
      details: { limit: 'operations', maximum: 2 },
    });
    expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('second\n');
    expect(await store(repo).head()).toEqual(before);
    expect(await store(repo).list()).toHaveLength(2);
  });

  it('bypasses capture entirely while the experiment is disabled', async () => {
    const repo = await createRepo();
    const hook = harness(repo, false);

    await hook.run(context('call-1'), async () => {
      await writeFile(join(repo, 'a.txt'), 'changed\n');
    });

    expect(await Bun.file(join(repo, 'a.txt')).text()).toBe('changed\n');
    expect(await Bun.file(join(repo, '.git', 'kimi-operation-log', 'head.json')).exists()).toBe(
      false,
    );
  });
});
