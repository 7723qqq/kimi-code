import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { ErrorCodes, Error2 } from '#/errors';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IProjectLocalConfigService } from '#/app/projectLocalConfig/projectLocalConfig';
import { HostFileSystem } from '#/os/backends/host/hostFsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { FileProjectLocalConfigService } from '#/persistence/backends/node-fs/projectLocalConfigService';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { WorkspaceDirsService } from '#/workspace/workspaceDirs/workspaceDirsService';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { stubBootstrap } from '../../app/bootstrap/stubs';
import { registerStateServices } from '../../state/stubs';

describe('WorkspaceDirsService session sandbox', () => {
  let root: string;
  let workspaceDir: string;
  let outsideDir: string;
  let homeDir: string;
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

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
      await expect(dirs.mergeAdditionalDirs(workspaceDir, [candidate])).rejects.toSatisfy(
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

    expect(dirs.additionalDirs).toEqual([outsideDir]);
    release.dispose();
    expect(dirs.additionalDirs).toEqual([]);
  });

  it('keeps a shared directory while any session still holds it', async () => {
    const dirs = await service();

    const first = await dirs.mergeAdditionalDirs(workspaceDir, [outsideDir]);
    const second = await dirs.mergeAdditionalDirs(workspaceDir, [outsideDir]);
    expect(dirs.additionalDirs).toEqual([outsideDir]);

    first.dispose();
    expect(dirs.additionalDirs).toEqual([outsideDir]);

    second.dispose();
    expect(dirs.additionalDirs).toEqual([]);
  });

  it('keeps the project-local config channel permissive', async () => {
    const dirs = await service();
    const config = ix.get(IProjectLocalConfigService);

    await expect(config.resolveAdditionalDirs(workspaceDir, ['/etc'], 'config')).resolves.toEqual([
      '/etc',
    ]);
    expect(dirs.additionalDirs).toEqual([]);
  });
});
