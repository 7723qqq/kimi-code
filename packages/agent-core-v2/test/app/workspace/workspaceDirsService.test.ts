import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { ErrorCodes, Error2 } from '#/errors';
import { HostFileSystem } from '#/os/backends/host/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { WorkspaceDirsService } from '#/workspace/workspaceDirs/workspaceDirsService';
import { expectRejection } from '#test/helpers/assertions';

import { stubBootstrap } from '../../app/bootstrap/stubs';
import { registerStateServices } from '../../state/stubs';

describe('WorkspaceDirsService session sandbox', () => {
  let root: string;
  let workspaceDir: string;
  let outsideDir: string;
  let homeDir: string;
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let registered: readonly { id: string; root: string; name: string; kind: 'managed' | 'implicit'; additionalDirs: readonly string[]; createdAt: number; lastOpenedAt: number }[] = [];

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
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        registerStateServices(reg);
        reg.definePartialInstance(IWorkspaceContext, { cwd: workspaceDir });
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
          list: async () => registered,
          get: async (id: string) => registered.find((entry) => entry.id === id),
        } as never);
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
