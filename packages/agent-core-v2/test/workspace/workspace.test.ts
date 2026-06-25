import type { Kaos } from '@moonshot-ai/kaos';
import { beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { PathSecurityError } from '#/_base/tools/policies/path-access';
import { ISessionKaosService } from '#/kaos/kaos';
import { ILogService } from '#/log/log';
import { IWorkspaceService } from '#/workspace/workspace';
import { WorkspaceService } from '#/workspace/workspaceService';

import { stubLog } from '../log/stubs';

function fakeKaos(cwd: string): Kaos {
  return {
    pathClass: () => 'posix',
    getcwd: () => cwd,
    gethome: () => '/home/user',
  } as unknown as Kaos;
}

function stubSessionKaos(cwd: string, initialAdditional: readonly string[] = []): ISessionKaosService {
  const kaos = fakeKaos(cwd);
  const additional = [...initialAdditional];
  return {
    _serviceBrand: undefined,
    toolKaos: kaos,
    persistenceKaos: kaos,
    systemContextKaos: kaos,
    get additionalDirs() {
      return additional;
    },
    setToolKaos: () => {},
    setPersistenceKaos: () => {},
    addAdditionalDir: (dir) => {
      if (!additional.includes(dir)) additional.push(dir);
    },
    removeAdditionalDir: (dir) => {
      const idx = additional.indexOf(dir);
      if (idx >= 0) additional.splice(idx, 1);
    },
  };
}

describe('WorkspaceService', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Session,
      IWorkspaceService,
      WorkspaceService,
      InstantiationType.Delayed,
      'workspace',
    );
  });

  function build(sessionKaos: ISessionKaosService): IWorkspaceService {
    const host = createScopedTestHost([stubPair(ILogService, stubLog())]);
    const session = host.child(LifecycleScope.Session, 's1', [stubPair(ISessionKaosService, sessionKaos)]);
    return session.accessor.get(IWorkspaceService);
  }

  it('reflects the session kaos cwd and additional dirs', () => {
    const ws = build(stubSessionKaos('/repo', ['/extra']));
    expect(ws.workDir).toBe('/repo');
    expect(ws.additionalDirs).toEqual(['/extra']);
  });

  it('resolves a relative path against workDir', () => {
    const ws = build(stubSessionKaos('/repo'));
    expect(ws.resolve('src/index.ts')).toBe('/repo/src/index.ts');
  });

  it('normalizes an absolute path', () => {
    const ws = build(stubSessionKaos('/repo'));
    expect(ws.resolve('/repo/a/../b')).toBe('/repo/b');
  });

  it('checks whether a path is within the workspace', () => {
    const ws = build(stubSessionKaos('/repo', ['/extra']));
    expect(ws.isWithin('src/index.ts')).toBe(true);
    expect(ws.isWithin('/repo/sub/file')).toBe(true);
    expect(ws.isWithin('/extra/file')).toBe(true);
    expect(ws.isWithin('/elsewhere/file')).toBe(false);
  });

  it('allows a path inside the workspace', () => {
    const ws = build(stubSessionKaos('/repo'));
    expect(ws.assertAllowed('src/index.ts', 'read')).toBe('/repo/src/index.ts');
  });

  it('rejects a relative path that escapes the workspace', () => {
    const ws = build(stubSessionKaos('/repo'));
    expect(() => ws.assertAllowed('../outside', 'read')).toThrowError(PathSecurityError);
    try {
      ws.assertAllowed('../outside', 'read');
    } catch (error) {
      expect((error as PathSecurityError).code).toBe('PATH_OUTSIDE_WORKSPACE');
    }
  });

  it('rejects a sensitive file', () => {
    const ws = build(stubSessionKaos('/repo'));
    expect(() => ws.assertAllowed('.env', 'read')).toThrowError(PathSecurityError);
    try {
      ws.assertAllowed('.env', 'read');
    } catch (error) {
      expect((error as PathSecurityError).code).toBe('PATH_SENSITIVE');
    }
  });

  it('snapshots a WorkspaceConfig value object', () => {
    const ws = build(stubSessionKaos('/repo', ['/extra']));
    expect(ws.toConfig()).toEqual({ workspaceDir: '/repo', additionalDirs: ['/extra'] });
  });

  it('delegates additional-dir mutation to the session kaos', () => {
    const ws = build(stubSessionKaos('/repo'));
    ws.addAdditionalDir('/extra');
    expect(ws.additionalDirs).toEqual(['/extra']);
    ws.addAdditionalDir('/extra'); // idempotent
    expect(ws.additionalDirs).toEqual(['/extra']);
    ws.removeAdditionalDir('/extra');
    expect(ws.additionalDirs).toEqual([]);
  });
});
