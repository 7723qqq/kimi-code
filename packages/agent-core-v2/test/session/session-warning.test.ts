import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { LocalKaos, type Environment, type Kaos } from '@moonshot-ai/kaos';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { type ScopedTestHost, createScopedTestHost, stubPair } from '#/_base/di/test';
import { IAgentLifecycleService } from '#/session/agent-lifecycle';
import { IBootstrapService } from '#/app/bootstrap';
import { IKaos, type IKaos as IKaosType, type PathClass } from '#/app/kaos';
import { IAgentProfileService } from '#/agent/profile';
import { ISessionWarningService, SessionWarningService } from '#/session/session';
import { ISessionWorkspaceContext } from '#/session/workspaceContext';

const TEST_OS_ENV: Environment = {
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
};

type LocalKaosCtor = new (osEnv: Environment) => LocalKaos;

function realIKaos(cwd: string): IKaosType {
  const backend: Kaos = new (LocalKaos as unknown as LocalKaosCtor)(TEST_OS_ENV);
  return wrapKaos(backend.withCwd(cwd));
}

function wrapKaos(backend: Kaos): IKaosType {
  return {
    _serviceBrand: undefined,
    get name() {
      return backend.name;
    },
    get cwd() {
      return backend.getcwd();
    },
    get osEnv() {
      return backend.osEnv;
    },
    backend,
    pathClass: (): PathClass => backend.pathClass(),
    normpath: (path) => backend.normpath(path),
    gethome: () => backend.gethome(),
    getcwd: () => backend.getcwd(),
    withCwd: (cwd) => wrapKaos(backend.withCwd(cwd)),
    withEnv: (env) => wrapKaos(backend.withEnv(env)),
  };
}

function workspaceStub(additionalDirs: readonly string[] = []): ISessionWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workDir: '/tmp/proj',
    additionalDirs,
    setWorkDir: () => {},
    resolve: (p) => p,
    isWithin: () => true,
    assertAllowed: (p) => p,
    addAdditionalDir: () => {},
    removeAdditionalDir: () => {},
  };
}

function bootstrapStub(homeDir: string): IBootstrapService {
  return { homeDir } as unknown as IBootstrapService;
}

/**
 * Build a Session-scoped host with `SessionWarningService` registered and its
 * collaborators stubbed. `agentLifecycle` defaults to "no live main agent" so
 * the service exercises the on-demand recompute path.
 */
function build(args: {
  kaos: IKaosType;
  homeDir: string;
  additionalDirs?: readonly string[];
  agentLifecycle?: IAgentLifecycleService;
}): { host: ScopedTestHost; service: ISessionWarningService } {
  const host = createScopedTestHost([stubPair(IBootstrapService, bootstrapStub(args.homeDir))]);
  const session = host.child(LifecycleScope.Session, 's1', [
    stubPair(IKaos, args.kaos),
    stubPair(ISessionWorkspaceContext, workspaceStub(args.additionalDirs ?? [])),
    stubPair(
      IAgentLifecycleService,
      args.agentLifecycle ??
        ({
          _serviceBrand: undefined,
          getHandle: () => undefined,
        } as unknown as IAgentLifecycleService),
    ),
  ]);
  return { host, service: session.accessor.get(ISessionWarningService) };
}

describe('SessionWarningService.getSessionWarnings', () => {
  let host: ScopedTestHost | undefined;
  let homeDir: string;
  let workDir: string;
  let kaos: IKaosType;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Session,
      ISessionWarningService,
      SessionWarningService,
      InstantiationType.Delayed,
      'sessionWarning',
    );
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-warn-home-'));
    workDir = await mkdtemp(join(tmpdir(), 'kimi-warn-work-'));
    kaos = realIKaos(workDir);
    // Keep user-level discovery hermetic.
    vi.spyOn(kaos, 'gethome').mockReturnValue(homeDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    host?.dispose();
    host = undefined;
    await rm(homeDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it('returns an agents-md-oversized warning when AGENTS.md exceeds the 32 KB budget', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'x'.repeat(40 * 1024), 'utf-8');
    const built = build({ kaos, homeDir });
    host = built.host;

    const warnings = await built.service.getSessionWarnings();

    expect(warnings).toEqual([
      expect.objectContaining({
        code: 'agents-md-oversized',
        severity: 'warning',
        message: expect.stringContaining('exceeds the recommended'),
      }),
    ]);
  });

  it('returns no warnings when AGENTS.md is within the budget', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'small instructions', 'utf-8');
    const built = build({ kaos, homeDir });
    host = built.host;

    const warnings = await built.service.getSessionWarnings();

    expect(warnings).toEqual([]);
  });

  it('prefers the main agent cached warning when the agent is live', async () => {
    // No AGENTS.md on disk — the recompute path would yield nothing — but the
    // live main agent reports a cached warning, which must win.
    const cached = 'AGENTS.md total 40 KB exceeds the recommended 32 KB.';
    const profileStub = {
      getAgentsMdWarning: () => cached,
    } as unknown as IAgentProfileService;
    const agentLifecycle = {
      _serviceBrand: undefined,
      getHandle: (id: string) =>
        id === 'main'
          ? { accessor: { get: (token: unknown) => (token === IAgentProfileService ? profileStub : undefined) } }
          : undefined,
    } as unknown as IAgentLifecycleService;

    const built = build({ kaos, homeDir, agentLifecycle });
    host = built.host;

    const warnings = await built.service.getSessionWarnings();

    expect(warnings).toEqual([
      { code: 'agents-md-oversized', severity: 'warning', message: cached },
    ]);
  });
});
