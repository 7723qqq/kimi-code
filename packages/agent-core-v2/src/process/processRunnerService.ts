/**
 * `process` domain (L1) — `ISessionProcessRunner` implementation.
 *
 * Spawns processes through the session execution environment (`IKaos.backend`),
 * defaulting cwd/env to the execution environment and honoring per-call
 * overrides via `withCwd` / `execWithEnv`. Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IKaos } from '#/kaos';

import { type IProcess, ISessionProcessRunner, type ProcessExecOptions } from './process';

export class SessionProcessRunner implements ISessionProcessRunner {
  declare readonly _serviceBrand: undefined;

  constructor(@IKaos private readonly kaos: IKaos) {}

  exec(args: readonly string[], options?: ProcessExecOptions): Promise<IProcess> {
    const k = options?.cwd !== undefined ? this.kaos.withCwd(options.cwd) : this.kaos;
    const env =
      options?.env !== undefined
        ? ({ ...process.env, ...options.env } as Record<string, string>)
        : undefined;
    return k.backend.execWithEnv([...args], env);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionProcessRunner,
  SessionProcessRunner,
  InstantiationType.Delayed,
  'process',
);
