import { afterAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';

import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { FileHistoryChange } from '#/features/fileHistory/fileHistory';
import { AgentFileHistoryService } from '#/features/fileHistory/fileHistoryService';
import type { OperationView } from '#/features/operationLog/operationLog';
import { OperationLogStore } from '#/features/operationLog/operationLogStore';
import { OperationSnapshotStore } from '#/features/operationLog/operationSnapshotStore';
import { RepositoryViewService } from '#/features/operationLog/repositoryViewService';
import type { SnapshotRecord } from '#/features/snapshot/snapshot';
import { SnapshotService } from '#/features/snapshot/snapshotService';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';

import { stubWorkspaceContext } from '../../session/workspaceContext/stub-workspace-context';

const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
  });
  const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr}`);
}

async function createRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-operation-projection-'));
  roots.push(root);
  const repo = join(root, 'repo');
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'core.autocrlf', 'false');
  await git(repo, 'config', 'user.email', 'operation-test@example.com');
  await git(repo, 'config', 'user.name', 'Operation Test');
  await writeFile(join(repo, 'a.txt'), 'alpha\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial');
  return repo;
}

async function capture(
  repo: string,
  store: OperationLogStore,
  before: OperationView,
  turnId: number,
  toolCallId: string,
): Promise<OperationView> {
  const backend = await RepositoryViewService.open({ repoRoot: repo });
  const after = await backend.captureView();
  await store.capture(
    after,
    {
      at: new Date(turnId * 1_000),
      description: toolCallId,
      origin: {
        sessionId: 'session-1',
        agentId: 'main',
        turnId,
        toolCallId,
        toolName: 'Edit',
      },
    },
    before,
  );
  return after;
}

function contexts(repo: string) {
  const agent = makeAgentScopeContext({ agentId: 'main', agentScope: 'main' });
  const session = makeSessionContext({
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    sessionDir: join(repo, 'session'),
    sessionScope: 'session-1',
    cwd: repo,
  });
  const workspace = stubWorkspaceContext(repo);
  return { agent, session, workspace };
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('operation store query projections', () => {
  it('serves snapshots and per-turn file history without legacy capture services', async () => {
    const repo = await createRepo();
    const backend = await RepositoryViewService.open({ repoRoot: repo });
    const store = new OperationLogStore(backend.storageRoot);
    const initial = await backend.captureView();
    await writeFile(join(repo, 'a.txt'), 'alpha\nbeta\n');
    await writeFile(join(repo, 'new.txt'), 'new\n');
    const first = await capture(repo, store, initial, 7, 'call-1');
    await writeFile(join(repo, 'a.txt'), 'alpha\ngamma\n');
    await rm(join(repo, 'new.txt'));
    const second = await capture(repo, store, first, 7, 'call-2');
    await writeFile(join(repo, 'a.txt'), 'turn8\n');
    await capture(repo, store, second, 8, 'call-3');
    const { agent, session, workspace } = contexts(repo);
    const flags = { enabled: () => true } as never;

    const snapshots = new SnapshotService(
      agent,
      session,
      {} as never,
      {} as never,
      workspace,
      {} as never,
      {} as never,
      {} as never,
      flags,
    );
    const aRecords = await snapshots.store.list(join(repo, 'a.txt'));
    expect(aRecords).toHaveLength(3);
    expect(aRecords[2]).toMatchObject({
      id: (await store.list())[2]?.id,
      hash: (await backend.readFile(initial, 'a.txt'))?.hash,
      afterHash: (await backend.readFile(first, 'a.txt'))?.hash,
      tool: 'Edit',
      mode: 'edit',
      sessionId: 'session-1',
      agentId: 'main',
    });
    expect(new TextDecoder().decode(await snapshots.store.content(aRecords[2]!.hash))).toBe(
      'alpha\n',
    );
    const newRecords = await snapshots.store.list(join(repo, 'new.txt'));
    expect(newRecords).toHaveLength(2);
    expect(newRecords[1]).toMatchObject({ hash: '', mode: 'overwrite' });
    expect(newRecords[0]?.afterHash).toBe('');
    expect(await snapshots.store.agents('session-1')).toEqual([
      expect.objectContaining({ agentId: 'main', sessionId: 'session-1', cwd: repo }),
    ]);

    const history = new AgentFileHistoryService(
      agent,
      { contributeState: () => {} } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      workspace,
      session,
      {} as never,
      {} as never,
      {} as never,
      flags,
    );
    expect(await history.turnRecorded(7)).toBe(true);
    expect(await history.turnRecorded(9)).toBe(false);
    const originalSpawn = Bun.spawn;
    let spawns = 0;
    Bun.spawn = ((options: any) => {
      const command = options.cmd as readonly string[];
      if (command[0] === 'git') spawns += 1;
      return originalSpawn(options);
    }) as typeof Bun.spawn;
    let turnChanges: FileHistoryChange[] = [];
    try {
      turnChanges = await history.changes(7);
    } finally {
      Bun.spawn = originalSpawn;
    }
    expect(spawns).toBe(4);
    expect(turnChanges).toEqual([
      { path: 'a.txt', status: 'modified', additions: 1, deletions: 0 },
    ]);
    expect(await history.changes(8)).toEqual([
      { path: 'a.txt', status: 'modified', additions: 1, deletions: 2 },
    ]);
    expect(await history.contentAt(7, 'a.txt', 'start')).toEqual({
      version: 7_000,
      content: 'alpha\n',
    });
    expect(await history.contentAt(7, 'a.txt', 'end')).toEqual({
      version: 7_000,
      content: 'alpha\ngamma\n',
    });
  });

  it('projects a snapshot list from one batched git read', async () => {
    const repo = await createRepo();
    const backend = await RepositoryViewService.open({ repoRoot: repo });
    const store = new OperationLogStore(backend.storageRoot);
    let view = await backend.captureView();
    for (let index = 0; index < 8; index += 1) {
      await writeFile(join(repo, 'a.txt'), `version ${index}\n`);
      view = await capture(repo, store, view, 7, `call-${index}`);
    }
    const snapshots = new OperationSnapshotStore(repo);
    await snapshots.operations();
    const originalSpawn = Bun.spawn;
    let spawns = 0;
    Bun.spawn = ((options: any) => {
      const command = options.cmd as readonly string[];
      if (command[0] === 'git') spawns += 1;
      return originalSpawn(options);
    }) as typeof Bun.spawn;

    let records: readonly SnapshotRecord[] = [];
    try {
      records = await snapshots.list(join(repo, 'a.txt'));
    } finally {
      Bun.spawn = originalSpawn;
    }

    expect(spawns).toBe(1);
    const operations = await store.list();
    expect(records).toHaveLength(operations.length);
    for (const [index, operation] of operations.entries()) {
      const before =
        operation.beforeViewId === undefined ? undefined : await store.view(operation.beforeViewId);
      const after = await store.view(operation.viewId);
      const beforeFile = before === undefined ? undefined : await backend.readFile(before, 'a.txt');
      const afterFile = await backend.readFile(after, 'a.txt');
      expect(records[index]).toMatchObject({
        id: operation.id,
        hash: beforeFile?.hash ?? '',
        afterHash: afterFile?.hash ?? '',
      });
    }
  });
});
