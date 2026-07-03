/**
 * Shared harness for the `agent-core-v2` examples.
 *
 * Boots the **real** composition root so examples resolve services through the
 * same wiring production uses, and only the genuine external boundaries (the
 * seeded `IExecContext` value, plus anything a specific example wants to
 * control) are supplied as seeds. This keeps examples from rotting when a
 * service gains a constructor dependency: the dependency is already registered
 * by its domain barrel, so the example does not hard-code a stub list.
 *
 * How it works:
 *   1. `import '#/index'` loads every domain barrel as a side effect, which
 *      populates the scoped registry with all real `registerScopedService`
 *      descriptors.
 *   2. `bootstrap(...)` builds the real App scope (storage roles, bootstrap
 *      snapshot, skill store) and picks up every App-scope descriptor.
 *   3. `createChild(Session, …)` / `createChild(Agent, …)` pick up the Session
 *      and Agent descriptors. The seeded *values* (`IExecContext`,
 *      `ISessionContext`, `IAgentScopeContext`) — which are not constructed
 *      services and so absent from the registry — are provided here, mirroring
 *      what `sessionLifecycle` / `agentLifecycle` seed when they open scopes.
 *   4. Per-example `sessionSeeds` / `agentSeeds` override any registration, so
 *      an example can substitute a capturing fake for the one collaborator it
 *      wants to assert on (for example `IAgentRecordService`).
 *
 * Examples using this harness must NOT call `_clearScopedRegistryForTests()`:
 * the registry populated by step 1 is what makes resolution work.
 */

import '#/index';

import { LifecycleScope, type Scope, type ScopeSeed } from '#/_base/di/scope';
import {
  bootstrap,
  IBootstrapService,
  type BootstrapInput,
  type IBootstrapService as IBootstrapServiceType,
} from '#/app/bootstrap';
import {
  ILogOptions,
  resolveLoggingConfig,
} from '#/app/log/logConfig';
import {
  IAgentScopeContext,
  makeAgentScopeContext,
} from '#/agent/scopeContext';
import { createExecContext, execContextSeed } from '#/os/interface/execContext';
import {
  makeSessionContext,
  sessionContextSeed,
} from '#/session/sessionContext';

export interface SliceHost {
  readonly app: Scope;
  /** The default Session scope created by the harness (`sessionId`, default `s1`). */
  readonly session: Scope;
  /** The default Agent scope under `session` (`agentId`, default `main`). */
  readonly agent: Scope;
  /** Create an additional seeded Session scope under the App root (for
   *  multi-session examples). Shares the App scope and `KIMI_CODE_HOME`. */
  newSession(id: string, overrides?: { cwd?: string; seeds?: ScopeSeed }): Scope;
  /** Create an additional seeded Agent scope under the default Session. */
  newAgent(id: string, overrides?: { seeds?: ScopeSeed }): Scope;
  dispose(): void;
}

export interface SliceHostOptions {
  /** Root directory for the real file-backed services (storage, config, logs). */
  readonly homeDir: string;
  /** Working directory seeded into `IExecContext`. Defaults to `homeDir`. */
  readonly cwd?: string;
  /** Extra App-scope seeds (rarely needed; the composition root is complete). */
  readonly appSeeds?: ScopeSeed;
  /** Extra Session-scope seeds (overrides for the slice under test). */
  readonly sessionSeeds?: ScopeSeed;
  /** Extra Agent-scope seeds (overrides for the slice under test). */
  readonly agentSeeds?: ScopeSeed;
  /** Session / Agent ids. */
  readonly sessionId?: string;
  readonly agentId?: string;
  /** Workspace id used to derive the agent persistence scope. */
  readonly workspaceId?: string;
}

function sessionSeeds(
  boot: IBootstrapServiceType,
  workspaceId: string,
  sessionId: string,
  cwd: string,
  extra: ScopeSeed,
): ScopeSeed {
  return [
    ...execContextSeed(createExecContext(cwd)),
    ...sessionContextSeed(
      makeSessionContext({
        sessionId,
        workspaceId,
        sessionDir: boot.sessionDir(workspaceId, sessionId),
        sessionScope: boot.sessionScope(workspaceId, sessionId),
      }),
    ),
    ...extra,
  ];
}

function agentSeeds(
  boot: IBootstrapServiceType,
  workspaceId: string,
  sessionId: string,
  agentId: string,
  extra: ScopeSeed,
): ScopeSeed {
  return [
    [
      IAgentScopeContext,
      makeAgentScopeContext({
        agentId,
        agentScope: boot.agentScope(workspaceId, sessionId, agentId),
      }),
    ],
    ...extra,
  ];
}

export function createSliceHost(options: SliceHostOptions): SliceHost {
  const input: BootstrapInput = { homeDir: options.homeDir };
  // `ILogOptions` is an App-scope seeded value (built from env + homeDir); the
  // real startup seeds it before any log writer is constructed.
  const logSeed: ScopeSeed = [
    [ILogOptions, resolveLoggingConfig({ homeDir: options.homeDir, env: process.env })],
  ];
  const { app } = bootstrap(input, [...logSeed, ...(options.appSeeds ?? [])]);

  const sessionId = options.sessionId ?? 's1';
  const agentId = options.agentId ?? 'main';
  const workspaceId = options.workspaceId ?? 'ws_example';
  const cwd = options.cwd ?? options.homeDir;

  const boot = app.accessor.get(IBootstrapService);

  const session = app.createChild(LifecycleScope.Session, sessionId, {
    extra: sessionSeeds(boot, workspaceId, sessionId, cwd, options.sessionSeeds ?? []),
  });
  const agent = session.createChild(LifecycleScope.Agent, agentId, {
    extra: agentSeeds(boot, workspaceId, sessionId, agentId, options.agentSeeds ?? []),
  });

  return {
    app,
    session,
    agent,
    newSession(id, overrides) {
      return app.createChild(LifecycleScope.Session, id, {
        extra: sessionSeeds(boot, workspaceId, id, overrides?.cwd ?? cwd, overrides?.seeds ?? []),
      });
    },
    newAgent(id, overrides) {
      return session.createChild(LifecycleScope.Agent, id, {
        extra: agentSeeds(boot, workspaceId, sessionId, id, overrides?.seeds ?? []),
      });
    },
    dispose: () => app.dispose(),
  };
}
