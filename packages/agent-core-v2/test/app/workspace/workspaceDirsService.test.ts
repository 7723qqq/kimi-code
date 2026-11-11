import { afterEach, beforeEach, describe, expect, it, mock, type Mock } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventService } from '#/app/event/event';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { IWorkspaceService, type Workspace } from '#/app/workspace/workspace';
import { FileWorkspacePersistence } from '#/app/workspace/fileWorkspacePersistence';
import { IWorkspacePersistence } from '#/app/workspace/workspacePersistence';
import { WorkspaceService } from '#/app/workspace/workspaceService';
import { ErrorCodes, Error2 } from '#/errors';
import { HostFileSystem } from '#/os/backends/host/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { WorkspaceDirsService } from '#/workspace/workspaceDirs/workspaceDirsService';
import { WorkspaceStateService } from '#/workspace/state/workspaceStateService';
import { expectRejection } from '#test/helpers/assertions';
import { waitForAssertion, waitUntil } from '#test/helpers/waitFor';

import { stubBootstrap } from '../../app/bootstrap/stubs';
import { registerStateServices } from '../../state/stubs';

describe('WorkspaceDirsService session sandbox', () => {
  let root: string;
  let workspaceDir: string;
  let outsideDir: string;
  let homeDir: string;
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let registered: readonly Workspace[] = [];
  let registryChanges: Emitter<void>;
  let listWorkspaces: Mock<() => Promise<readonly Workspace[]>>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'kimi-workspace-dirs-'));
    workspaceDir = join(root, 'workspace');
    outsideDir = join(root, 'outside');
    homeDir = join(root, 'home');
    await Promise.all([
      mkdir(workspaceDir, { recursive: true }),
      mkdir(outsideDir, { recursive: true }),
      mkdir(homeDir, { recursive: true }),
    ]);
    await writeFile(join(workspaceDir, 'local.toml'), '');
    registered = [];
    disposables = new DisposableStore();
    registryChanges = disposables.add(new Emitter<void>());
    listWorkspaces = mock(async () => registered);
    ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        registerStateServices(reg);
        reg.definePartialInstance(IWorkspaceContext, {
          cwd: workspaceDir,
          workspaceId: 'ws_test',
          meta: {
            id: 'ws_test',
            root: workspaceDir,
            name: 'workspace',
            kind: 'implicit',
            createdAt: 1,
            lastOpenedAt: 2,
          },
        });
        reg.defineInstance(IBootstrapService, stubBootstrap(homeDir, {}, {}, root));
        reg.defineInstance(IHostFileSystem, new HostFileSystem());
        reg.definePartialInstance(ILogService, {
          info: () => {},
          warn: () => {},
          error: () => {},
          debug: () => {},
          trace: () => {},
          withContext: () => ix.get(ILogService),
        } as never);
        reg.define(IProjectLocalConfigService, FileProjectLocalConfigService);
        reg.definePartialInstance(IWorkspaceService, {
          list: listWorkspaces,
          get: async (id: string) => registered.find((entry) => entry.id === id),
        } as never);
        reg.definePartialInstance(IWorkspacePersistence, {
          onDidChange: registryChanges.event,
        });
        reg.define(IWorkspaceDirs, WorkspaceDirsService);
      },
    });
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(root, { recursive: true, force: true });
  });

  async function service(): Promise<IWorkspaceDirs> {
    const dirs = ix.get(IWorkspaceDirs);
    await dirs.ready;
    return dirs;
  }

  it('refuses machine-scale roots for a session payload', async () => {
    const dirs = await service();
    const before = dirs.additionalDirs;

    for (const candidate of ['/', '~', dirs.additionalDirs.length === 0 ? root : root]) {
      await expectRejection(
        dirs.mergeAdditionalDirs(workspaceDir, [candidate]),
        (error: unknown) => error instanceof Error2 && error.code === ErrorCodes.CONFIG_INVALID,
      );
    }
    expect(dirs.additionalDirs).toEqual(before);
  });

  it('refuses a system directory and an ancestor of the workspace', async () => {
    const dirs = await service();

    await expect(dirs.mergeAdditionalDirs(workspaceDir, ['/etc'])).rejects.toBeInstanceOf(Error2);
    await expect(dirs.mergeAdditionalDirs(workspaceDir, [root])).rejects.toBeInstanceOf(Error2);
    expect(dirs.additionalDirs).toEqual([]);
  });

  it('still accepts an ordinary sibling directory', async () => {
    const dirs = await service();

    const release = await dirs.mergeAdditionalDirs(workspaceDir, [outsideDir]);

    expect(dirs.additionalDirs).toEqual([outsideDir.split(sep).join('/')]);
    release.dispose();
    expect(dirs.additionalDirs).toEqual([]);
  });

  it('keeps a shared directory while any session still holds it', async () => {
    const dirs = await service();

    const first = await dirs.mergeAdditionalDirs(workspaceDir, [outsideDir]);
    const second = await dirs.mergeAdditionalDirs(workspaceDir, [outsideDir]);
    expect(dirs.additionalDirs).toEqual([outsideDir.split(sep).join('/')]);

    first.dispose();
    expect(dirs.additionalDirs).toEqual([outsideDir.split(sep).join('/')]);

    second.dispose();
    expect(dirs.additionalDirs).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the project-local config channel permissive',
    async () => {
      const dirs = await service();
      const config = ix.get(IProjectLocalConfigService);

      await expect(config.resolveAdditionalDirs(workspaceDir, ['/etc'], 'config')).resolves.toEqual(
        ['/etc'],
      );
      expect(dirs.additionalDirs).toEqual([]);
    },
  );

  it('names the offending path when an additional dir is invalid', async () => {
    const dirs = await service();
    expect(dirs.additionalDirs).toEqual([]);
    const config = ix.get(IProjectLocalConfigService);
    const missing = join(root, 'no-such-dir');

    const statFailure = await config
      .resolveAdditionalDirs(workspaceDir, [missing], 'session')
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(statFailure).toBeInstanceOf(Error2);
    expect((statFailure as Error2).message).toContain('no-such-dir');

    const notADir = join(workspaceDir, 'local.toml');
    const typeFailure = await config.resolveAdditionalDirs(workspaceDir, [notADir], 'session').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(typeFailure).toBeInstanceOf(Error2);
    expect((typeFailure as Error2).message).toContain('local.toml');

    const empty = await config.resolveAdditionalDirs(workspaceDir, ['  '], 'session').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(empty).toBeInstanceOf(Error2);
    expect((empty as Error2).message).toBe('workspace.additional_dir must not be empty');
  });

  it('coalesces pending registry reloads and applies changes received during an active reload', async () => {
    const extra = join(root, 'extra');
    await mkdir(extra, { recursive: true });
    const project: Workspace = {
      id: 'ws_test',
      root: workspaceDir,
      name: 'workspace',
      kind: 'managed',
      additionalDirs: [outsideDir],
      createdAt: 1,
      lastOpenedAt: 2,
    };
    registered = [project];
    const dirs = await service();
    expect(dirs.primary).toBe(workspaceDir);
    listWorkspaces.mockClear();
    let release!: (workspaces: readonly Workspace[]) => void;
    const held = new Promise<readonly Workspace[]>((resolve) => {
      release = resolve;
    });
    listWorkspaces.mockImplementationOnce(() => held);

    registryChanges.fire();
    await waitUntil(() => listWorkspaces.mock.calls.length === 1);
    registered = [
      { ...project, root: outsideDir, additionalDirs: [workspaceDir, extra] },
    ];
    for (let index = 0; index < 32; index += 1) registryChanges.fire();
    release([project]);

    await waitUntil(() => dirs.primary === outsideDir);
    expect(listWorkspaces).toHaveBeenCalledTimes(2);
    expect(dirs.additionalDirs).toEqual([workspaceDir, extra]);
  });

  it('includes source folders registered on the workspace', async () => {
    const extra = join(root, 'extra');
    await mkdir(extra, { recursive: true });
    registered = [
      {
        id: 'ws_test',
        root: workspaceDir,
        name: 'workspace',
        kind: 'managed',
        additionalDirs: [extra],
        createdAt: 1,
        lastOpenedAt: 2,
      },
    ];
    try {
      const dirs = await service();
      expect(dirs.additionalDirs).toEqual([extra]);
    } finally {
      registered = [];
    }
  });
});

describe('WorkspaceDirsService primary lifecycle', () => {
  let homeDir: string;
  let dirA: string;
  let dirB: string;
  let dirC: string;
  let disposables: DisposableStore;
  let persistence: FileWorkspacePersistence;
  let workspaces: WorkspaceService;

  const normalize = (path: string): string => path.split(sep).join('/');

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'ws-dirs-home-'));
    dirA = mkdtempSync(join(tmpdir(), 'ws-dirs-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'ws-dirs-b-'));
    dirC = mkdtempSync(join(tmpdir(), 'ws-dirs-c-'));
    disposables = new DisposableStore();
    const storage = new FileStorageService(homeDir);
    const hostFs = new HostFileSystem();
    const bootstrap = stubBootstrap(homeDir);
    const log = {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
    } as unknown as ILogService;
    const event = {
      publish: () => {},
      subscribe: () => ({ dispose: () => {} }),
    } as unknown as IEventService;
    persistence = disposables.add(
      new FileWorkspacePersistence(
        new JsonAtomicDocumentStore(storage),
        bootstrap,
        storage,
        log,
      ),
    );
    workspaces = new WorkspaceService(
      persistence,
      storage,
      new AppendLogStore(storage, log),
      hostFs,
      log,
      event,
    );
  });

  afterEach(async () => {
    disposables.dispose();
    await Promise.all(
      [homeDir, dirA, dirB, dirC].map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  function createDirs(
    cwd: string,
    workspaceId: string,
    kind: 'managed' | 'implicit' = 'implicit',
    environmentId = 'local',
    followsPrimary = environmentId === 'local',
  ): WorkspaceDirsService {
    const bootstrap = stubBootstrap(homeDir);
    const hostFs = new HostFileSystem();
    return disposables.add(
      new WorkspaceDirsService(
        {
          _serviceBrand: undefined,
          workspaceId,
          cwd,
          meta: { id: workspaceId, root: cwd, name: 'test', kind, createdAt: 0, lastOpenedAt: 0 },
        } as unknown as IWorkspaceContext,
        new FileProjectLocalConfigService(bootstrap, hostFs),
        {
          error: () => {},
          warn: () => {},
          info: () => {},
          debug: () => {},
        } as unknown as ILogService,
        new WorkspaceStateService(),
        workspaces,
        persistence,
        environmentId,
        followsPrimary,
      ),
    );
  }

  it('keeps the current primary for managed scopes and the associated primary for member scopes', async () => {
    const project = await workspaces.create({ root: dirA, additionalDirs: [dirB], name: 'proj' });

    const primary = createDirs(dirA, project.id, 'managed');
    await primary.ready;
    expect(primary.additionalDirs).toEqual([dirB]);
    expect(primary.sessionInfo().primaryByWorkspace).toEqual({ [project.id]: dirA });

    const member = createDirs(dirB, 'wd_other_000000000000');
    await member.ready;
    expect(member.additionalDirs).toEqual([dirA]);
    expect(member.sessionInfo().primaryByWorkspace).toEqual({ [project.id]: dirA });

    const outsider = createDirs(dirC, 'wd_else_000000000000');
    await outsider.ready;
    expect(outsider.additionalDirs).toEqual([]);
    expect(outsider.sessionInfo().primaryByWorkspace).toEqual({});
  });

  it('moves legacy local config and its watcher when the associated primary changes', async () => {
    const project = await workspaces.createOrTouch(dirA);
    await workspaces.update(project.id, { additionalDirs: [dirB] });
    const dirD = mkdtempSync(join(tmpdir(), 'ws-dirs-d-'));
    const writeLocalConfig = async (root: string, additionalDirs: readonly string[]) => {
      await mkdir(join(root, '.kimi-code'), { recursive: true });
      const entries = additionalDirs.map((dir) => `"${dir.replaceAll('\\', '\\\\')}"`).join(', ');
      await writeFile(
        join(root, '.kimi-code', 'local.toml'),
        `[workspace]\nadditional_dir = [${entries}]\n`,
        'utf8',
      );
    };
    try {
      await writeLocalConfig(dirA, [dirC]);
      await writeLocalConfig(dirB, [dirD]);
      const dirs = createDirs(dirA, project.id, 'implicit');
      await dirs.ready;
      expect(dirs.additionalDirs).toEqual([normalize(dirC), dirB]);

      await workspaces.setPrimary(project.id, dirB);
      await waitForAssertion(
        () => {
          expect(dirs.primary).toBe(dirB);
          expect(dirs.additionalDirs).toEqual([normalize(dirD), dirA]);
        },
        { timeout: 5_000 },
      );

      await writeLocalConfig(dirB, []);
      await waitForAssertion(
        () => {
          expect(dirs.additionalDirs).toEqual([dirA]);
        },
        { timeout: 5_000 },
      );
    } finally {
      await rm(dirD, { recursive: true, force: true });
    }
  }, 15_000);

  it('pins explicit local roots without expanding directory access', async () => {
    const project = await workspaces.create({ root: dirA, additionalDirs: [dirB], name: 'proj' });
    const pinned = createDirs(dirC, project.id, 'managed', 'local', false);
    const following = createDirs(dirC, project.id, 'managed', 'local', true);
    await Promise.all([pinned.ready, following.ready]);

    expect(pinned.primary).toBe(dirC);
    expect(pinned.additionalDirs).toEqual([]);
    expect(pinned.sessionInfo().primaryByWorkspace).toEqual({});
    expect(following.primary).toBe(dirA);
    expect(following.additionalDirs).toEqual([dirB]);

    await workspaces.setPrimary(project.id, dirB);
    await waitForAssertion(
      () => {
        expect(following.primary).toBe(dirB);
      },
      { timeout: 5_000 },
    );
    expect(pinned.primary).toBe(dirC);
    expect(pinned.additionalDirs).toEqual([]);
    expect(pinned.sessionInfo().primaryByWorkspace).toEqual({});
    expect(following.additionalDirs).toEqual([dirA]);
  }, 15_000);

  it('keeps the complete directory set when the primary changes from the original cwd', async () => {
    const project = await workspaces.create({
      root: dirA,
      additionalDirs: [dirB],
      name: 'proj',
    });
    const dirs = createDirs(dirA, project.id, 'managed');
    await dirs.ready;

    await workspaces.setPrimary(project.id, dirB);
    await waitForAssertion(
      () => {
        expect(dirs.primary).toBe(dirB);
      },
      { timeout: 5_000 },
    );

    expect(dirs.additionalDirs).toEqual([dirA]);
    expect(dirs.sessionInfo().primaryByWorkspace).toEqual({ [project.id]: dirB });

    await workspaces.update(project.id, { additionalDirs: [dirA, dirC] });
    await waitForAssertion(
      () => {
        expect(dirs.additionalDirs).toEqual([dirA, dirC]);
      },
      { timeout: 5_000 },
    );
    expect(dirs.primary).toBe(dirB);
  }, 15_000);

  it('keeps a remote workdir rooted at its environment cwd without local registry roots', async () => {
    const project = await workspaces.create({
      root: dirA,
      additionalDirs: [dirB],
      name: 'proj',
    });
    const remoteCwd = join(dirC, 'remote-workdir');
    const dirs = createDirs(remoteCwd, project.id, 'managed', 'ssh-dev');
    await dirs.ready;

    expect(dirs.primary).toBe(remoteCwd);
    expect(dirs.additionalDirs).toEqual([]);
    expect(dirs.sessionInfo().primaryByWorkspace).toEqual({});
  });
});
