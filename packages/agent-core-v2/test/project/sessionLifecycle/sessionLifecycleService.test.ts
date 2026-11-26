import { describe, expect, it, mock, spyOn } from 'bun:test';

import * as scopeModule from '#/_base/di/scope';
import { ISessionPresence } from '#/app/sessionPresence/sessionPresence';
import { noopTelemetryService } from '#/app/telemetry/telemetry';
import { SessionLifecycleService } from '#/project/sessionLifecycle/sessionLifecycleService';

const createScopedChildHandleMock = spyOn(scopeModule, 'createScopedChildHandle');

describe('SessionLifecycleService', () => {
  it('does not rescan workspace skills when additional dirs are session-only', async () => {
    const calls: string[] = [];
    const workspaceDirs = {
      ready: Promise.resolve(),
      mergeAdditionalDirs: mock(async () => {
        calls.push('merge');
      }),
      sessionInfo: () => ({}),
    };
    const workspaceSkillCatalog = {
      sessionData: () => ({}),
      reloadSources: mock(() => {
        calls.push('reload');
        return Promise.resolve();
      }),
    };
    const ready = Promise.resolve();
    const workdir = {
      dirs: workspaceDirs,
      skills: workspaceSkillCatalog,
      contextKey: 'local:/workspace',
      fs: {},
      instructions: { sessionProvider: () => ({}) },
      agentProfiles: { ready },
      mcp: { sessionHandle: () => ({}) },
      dispose: mock(),
    };
    const handle = {
      id: 'child',
      kind: 'agent',
      accessor: { get: () => ({ ready }) },
      dispose: mock(),
    } as never;
    createScopedChildHandleMock.mockReset();
    createScopedChildHandleMock.mockImplementation(() => {
      calls.push('scope');
      return handle;
    });
    const service = new SessionLifecycleService(
      ...([
        undefined,
        { workspaceId: 'wm_test', persistenceScope: 'sessions/wm_test' },
        { homeDir: '/home' },
        { ready, assertValid: () => {}, get: () => undefined },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        noopTelemetryService,
        undefined,
        { ready },
        { ready },
        { ready },
        { ready },
        async () => ({ service: { sessionHandle: () => ({}) }, dispose: () => {} }),
        { ready },
        { ready },
        { ready } as any,
        { ready } as any,
        undefined,
        undefined,
        async () => workdir,
      ] as unknown as ConstructorParameters<typeof SessionLifecycleService>)
    );
    const materialize = (
      service as unknown as {
        materializeSession(
          options: {
            sessionId: string;
            workDir: string;
            additionalDirs: readonly string[];
          },
          environment: undefined,
          workdir: unknown,
        ): Promise<unknown>;
      }
    ).materializeSession(
      {
        sessionId: 'session_test',
        workDir: '/workspace',
        additionalDirs: ['/additional'],
      },
      undefined,
      workdir,
    );

    try {
      await materialize;
      expect(calls).toEqual(['merge', 'scope']);
      expect(workspaceSkillCatalog.reloadSources).not.toHaveBeenCalled();
      expect(workspaceDirs.mergeAdditionalDirs).toHaveBeenCalledWith('/workspace', ['/additional']);
    } finally {
      await materialize.catch(() => undefined);
      service.dispose();
      createScopedChildHandleMock.mockReset();
    }
  });

  it('keeps remote resume cwd independent from the local primary', () => {
    const service = Object.assign(Object.create(SessionLifecycleService.prototype), {
      workspaceContext: { workspaceId: 'workspace', meta: { root: '/new-primary' } },
    }) as unknown as {
      sessionWorkDir(fallbackCwd: string, environment: { environmentId: string; cwd?: string } | undefined): string;
    };

    expect(service.sessionWorkDir('/local-anchor', { environmentId: 'ssh-dev', cwd: '/srv/app' })).toBe('/local-anchor');
    expect(service.sessionWorkDir('/old', undefined)).toBe('/new-primary');
    expect(service.sessionWorkDir('/old', { environmentId: 'local', cwd: '/explicit' })).toBe('/explicit');
  });

  it('registers session presence even when the worktree flag starts disabled', async () => {
    const ready = Promise.resolve();
    const disposePresence = mock();
    const markOpen = mock(() => ({ dispose: disposePresence }));
    const anchored: { readonly name: string; readonly fn: () => void }[] = [];
    const workdir = {
      dirs: {
        ready,
        mergeAdditionalDirs: mock(async () => {}),
        sessionInfo: () => ({}),
      },
      skills: { sessionData: () => ({}) },
      contextKey: 'local:/workspace',
      fs: {},
      instructions: { sessionProvider: () => ({}) },
      agentProfiles: { ready },
      configuredSources: {
        contextKey: 'local:/workspace:configured',
        explicitAgentProfiles: { ready },
        extraAgentProfiles: { ready },
      },
      mcp: { sessionHandle: () => ({}) },
      dispose: mock(),
    };
    const handle = {
      accessor: { get: () => ({ ready }) },
      dispose: mock(),
    };
    createScopedChildHandleMock.mockReset();
    createScopedChildHandleMock.mockImplementation(((_ix: unknown, _kind: string, _id: string, opts: any) => {
      opts.configureContainer({
        anchorKernelEntry: (fn: () => void, name: string) => {
          anchored.push({ name, fn });
        },
        invokeFunction: (cb: (accessor: { get: (id: unknown) => unknown }) => unknown) =>
          cb({
            get: (id: unknown) => (id === ISessionPresence ? { markOpen } : undefined),
          }),
        provide: () => {},
      });
      return handle;
    }) as never);
    const service = new SessionLifecycleService(
      ...([
        undefined,
        { workspaceId: 'wm_test', persistenceScope: 'sessions/wm_test' },
        { homeDir: '/home' },
        { ready, assertValid: () => {}, get: () => undefined },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        noopTelemetryService,
        { enabled: () => false },
        { ready },
        { ready, reload: async () => undefined },
        { ready },
        { ready },
        { ready },
        { ready } as any,
        { ready } as any,
        undefined,
        undefined,
        async () => workdir,
      ] as unknown as ConstructorParameters<typeof SessionLifecycleService>),
    );
    try {
      await (
        service as unknown as {
          materializeSession(
            options: { sessionId: string; workDir: string },
            environment: undefined,
            workdir: unknown,
          ): Promise<unknown>;
        }
      ).materializeSession({ sessionId: 'session_flag_off', workDir: '/workspace' }, undefined, workdir);

      expect(markOpen).toHaveBeenCalledWith('/home/sessions/wm_test/session_flag_off');
      const presenceAnchor = anchored.find((entry) => entry.name === 'sessionLifecycle:presence');
      expect(presenceAnchor).toBeDefined();
      presenceAnchor?.fn();
      expect(disposePresence).toHaveBeenCalledTimes(1);
    } finally {
      service.dispose();
      createScopedChildHandleMock.mockReset();
    }
  });
});
