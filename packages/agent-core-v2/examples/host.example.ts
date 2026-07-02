/**
 * Scenario: the **host** slice — `IHostEnvironment` + the `IExecContext` seed.
 *
 * Concept taught: not every dependency is *constructed* by the container. Some
 * enter the scope tree as plain **values** seeded through `stubPair(...)` /
 * `ScopeSeed`:
 *
 *   - `IHostEnvironment` (App scope) — an immutable snapshot of the host OS,
 *     shell, path style, and home directory. One per process.
 *   - `IExecContext` (Session scope) — the session's `cwd` + env overlays. It is
 *     a value, not a service: it has no `registerScopedService` entry, which is
 *     why the dep-graph lists it as an "unresolved" token even though Session
 *     and Agent services inject it. `sessionLifecycle` seeds it when a session
 *     is created; `withCwd` / `withEnv` derive new contexts immutably.
 *
 * `SessionWorkspaceContextService` consumes `IExecContext` and resolves every
 * path relative to the seeded `cwd` — so the same service behaves differently
 * in two sibling Sessions purely because each was seeded a different context.
 *
 * Prerequisites: example 01 (container & scope tree).
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/host.example.ts
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';

import { IHostEnvironment } from '#/app/hostEnvironment';
import {
  createExecContext,
  IExecContext,
} from '#/session/execContext';
import {
  ISessionWorkspaceContext,
  SessionWorkspaceContextService,
} from '#/session/workspaceContext';

const fakeEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Linux',
  osArch: 'x86_64',
  osVersion: 'test',
  shellName: 'bash',
  shellPath: '/bin/bash',
  pathClass: 'posix',
  homeDir: '/home/test',
  ready: Promise.resolve(),
};

describe('host slice (IHostEnvironment + IExecContext seed)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Session,
      ISessionWorkspaceContext,
      SessionWorkspaceContextService,
    );
  });

  it('resolves paths against the seeded IExecContext.cwd', () => {
    const host = createScopedTestHost([stubPair(IHostEnvironment, fakeEnv)]);
    const session = host.child(LifecycleScope.Session, 's1', [
      stubPair(IExecContext, createExecContext('/workspace')),
    ]);

    const ws = session.accessor.get(ISessionWorkspaceContext);
    expect(ws.workDir).toBe('/workspace');
    expect(ws.resolve('src/index.ts')).toBe('/workspace/src/index.ts');
    expect(ws.isWithin('/workspace/src/index.ts')).toBe(true);
    expect(ws.isWithin('/elsewhere/file.ts')).toBe(false);

    host.dispose();
  });

  it('isolates IExecContext between sibling Session scopes', () => {
    const host = createScopedTestHost([stubPair(IHostEnvironment, fakeEnv)]);
    const s1 = host.child(LifecycleScope.Session, 's1', [
      stubPair(IExecContext, createExecContext('/repo-a')),
    ]);
    const s2 = host.child(LifecycleScope.Session, 's2', [
      stubPair(IExecContext, createExecContext('/repo-b')),
    ]);

    expect(s1.accessor.get(ISessionWorkspaceContext).workDir).toBe('/repo-a');
    expect(s2.accessor.get(ISessionWorkspaceContext).workDir).toBe('/repo-b');

    host.dispose();
  });

  it('derives a new context with withCwd without mutating the original', () => {
    const base = createExecContext('/workspace', [{ PATH: '/usr/bin' }]);
    const derived = base.withCwd('/workspace/sub');

    expect(derived.cwd).toBe('/workspace/sub');
    expect(derived.envLayers).toEqual([{ PATH: '/usr/bin' }]);
    // Original is untouched — IExecContext is immutable.
    expect(base.cwd).toBe('/workspace');
  });
});
