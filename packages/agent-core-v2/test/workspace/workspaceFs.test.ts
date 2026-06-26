import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import type { Workspace } from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { WorkspaceErrors } from '#/workspace/errors';
import { IWorkspaceRegistry } from '#/workspace/workspaceRegistry';
import { IWorkspaceFsService } from '#/workspace/workspaceFs';
import { WorkspaceFsService } from '#/workspace/workspaceFsService';

function stubRegistry(workspaces: Workspace[]): IWorkspaceRegistry {
  return {
    _serviceBrand: undefined,
    list: async () => workspaces,
    get: async () => {
      throw new Error('not implemented in test');
    },
    createOrTouch: async () => {
      throw new Error('not implemented in test');
    },
    update: async () => {
      throw new Error('not implemented in test');
    },
    delete: async () => {},
    resolveRoot: async () => {
      throw new Error('not implemented in test');
    },
  };
}

function fakeWorkspace(root: string): Workspace {
  return {
    id: 'wd_fake_000000000000',
    root,
    name: root.split('/').pop() ?? root,
    is_git_repo: false,
    branch: null,
    created_at: new Date(0).toISOString(),
    last_opened_at: new Date(0).toISOString(),
    session_count: 0,
  };
}

describe('WorkspaceFsService', () => {
  let tmpDir: string;
  let disposeHost: (() => void) | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Core,
      IWorkspaceFsService,
      WorkspaceFsService,
      InstantiationType.Delayed,
      'workspace',
    );
    // Canonicalize: browse() realpaths the target, so assertions must compare
    // against the real path (macOS maps /var/folders -> /private/var/folders).
    tmpDir = await fsp.realpath(await fsp.mkdtemp(join(os.tmpdir(), 'ws-fs-')));
  });

  afterEach(async () => {
    disposeHost?.();
    disposeHost = undefined;
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  function build(workspaces: Workspace[] = []): IWorkspaceFsService {
    const host = createScopedTestHost([stubPair(IWorkspaceRegistry, stubRegistry(workspaces))]);
    disposeHost = () => host.dispose();
    return host.core.accessor.get(IWorkspaceFsService);
  }

  it('lists subdirectories of an absolute path', async () => {
    await fsp.mkdir(join(tmpDir, 'alpha'));
    await fsp.mkdir(join(tmpDir, 'beta'));
    await fsp.writeFile(join(tmpDir, 'not-a-dir.txt'), 'x');

    const fs = build();
    const result = await fs.browse(tmpDir);
    expect(result.path).toBe(tmpDir);
    expect(result.entries.map((e) => e.name).sort()).toEqual(['alpha', 'beta']);
    expect(result.entries.every((e) => e.is_dir)).toBe(true);
  });

  it('throws validation.failed for a relative path', async () => {
    const fs = build();
    await expect(fs.browse('relative/path')).rejects.toMatchObject({
      code: WorkspaceErrors.codes.PATH_NOT_ABSOLUTE,
    });
  });

  it('throws fs.path_not_found for a missing path', async () => {
    const fs = build();
    await expect(fs.browse(join(tmpDir, 'missing'))).rejects.toMatchObject({
      code: WorkspaceErrors.codes.PATH_NOT_FOUND,
    });
  });

  it('returns $HOME plus recent roots from the registry on home()', async () => {
    const roots = ['/repo/one', '/repo/two', '/repo/three'];
    const fs = build(roots.map(fakeWorkspace));
    const result = await fs.home();
    expect(result.home).toBe(os.homedir());
    expect(result.recent_roots).toEqual(roots);
  });
});
