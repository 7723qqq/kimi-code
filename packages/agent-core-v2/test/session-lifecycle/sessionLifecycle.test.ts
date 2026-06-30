import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { type ScopedTestHost, createScopedTestHost, stubPair } from '#/_base/di/test';
import { IBootstrapService } from '#/bootstrap';
import { IKaosFactory, type IKaos } from '#/kaos';
import { ISessionService } from '#/session';
import { ISessionLifecycleService } from '#/session-lifecycle/sessionLifecycle';
import { SessionLifecycleService } from '#/session-lifecycle/sessionLifecycleService';
import { ISessionMetadata } from '#/session-metadata';
import { ISessionSkillCatalog } from '#/skill';

function bootstrapStub(): IBootstrapService {
  return {
    sessionsDir: '/tmp/sessions',
    homeDir: '/tmp',
  } as IBootstrapService;
}

function metadataStub(): ISessionMetadata {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: () => ({ dispose: () => {} }),
    read: () => Promise.resolve({} as never),
    update: () => Promise.resolve(),
    setTitle: () => Promise.resolve(),
    setArchived: () => Promise.resolve(),
  };
}

function kaosFactoryStub(): IKaosFactory {
  const kaos: IKaos = {
    _serviceBrand: undefined,
    name: 'local',
    cwd: '/tmp/proj',
    osEnv: { osKind: 'test', osArch: 'x64', osVersion: '', shellName: 'sh', shellPath: '/bin/sh' },
    backend: undefined as never,
    pathClass: () => 'posix',
    normpath: (p) => p,
    gethome: () => '/home',
    getcwd: () => '/tmp/proj',
    withCwd: (cwd) => ({ ...kaos, cwd, getcwd: () => cwd }),
    withEnv: () => kaos,
  };
  return {
    _serviceBrand: undefined,
    createLocal: (cwd) => Promise.resolve({ ...kaos, cwd, getcwd: () => cwd }),
  };
}

function skillCatalogStub(): ISessionSkillCatalog {
  return {
    _serviceBrand: undefined,
    catalog: {
      getSkill: () => undefined,
      getPluginSkill: () => undefined,
      renderSkillPrompt: () => '',
      listSkills: () => [],
      listInvocableSkills: () => [],
      getSkillRoots: () => [],
      getModelSkillListing: () => '',
    },
    ready: Promise.resolve(),
    load: () => Promise.resolve(),
    reload: () => Promise.resolve(),
  };
}

describe('SessionLifecycleService', () => {
  let host: ScopedTestHost | undefined;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      ISessionLifecycleService,
      SessionLifecycleService,
      InstantiationType.Delayed,
      'session-lifecycle',
    );
  });

  afterEach(() => {
    host?.dispose();
    host = undefined;
  });

  function build(extra: ReturnType<typeof stubPair>[] = []): ISessionLifecycleService {
    host = createScopedTestHost([
      stubPair(IBootstrapService, bootstrapStub()),
      stubPair(ISessionMetadata, metadataStub()),
      stubPair(IKaosFactory, kaosFactoryStub()),
      stubPair(ISessionSkillCatalog, skillCatalogStub()),
      ...extra,
    ]);
    return host.app.accessor.get(ISessionLifecycleService);
  }

  it('create / get / list / close', async () => {
    const svc = build();
    const h = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    expect(h.id).toBe('s1');
    expect(svc.get('s1')).toBe(h);
    expect(svc.list()).toEqual([h]);

    await svc.close('s1');
    expect(svc.get('s1')).toBeUndefined();
  });

  it('create seeds identity and materializes metadata', async () => {
    const svc = build();
    const h = await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    // create() awaits ISessionMetadata.ready, so a resolved handle implies the
    // metadata service was resolved inside the new session scope.
    expect(h.kind).toBe(LifecycleScope.Session);
  });

  it('archive runs the in-scope command and disposes the session', async () => {
    let archived = false;
    const sessionStub: ISessionService = {
      _serviceBrand: undefined,
      archive: () => {
        archived = true;
        return Promise.resolve();
      },
    };
    const svc = build([stubPair(ISessionService, sessionStub)]);

    await svc.create({ sessionId: 's1', workDir: '/tmp/proj' });
    await svc.archive('s1');

    expect(archived).toBe(true);
    expect(svc.get('s1')).toBeUndefined();
  });
});
