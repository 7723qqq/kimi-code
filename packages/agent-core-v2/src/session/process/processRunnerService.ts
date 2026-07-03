/**
 * `process` domain (L2) — `ISessionProcessRunner` implementation.
 *
 * Resolves cwd + env from the session's `IExecContext` and delegates the actual
 * host spawn to the App-scope `IHostProcessService`. Per-call overrides
 * (`options.cwd`, `options.env`) win over the seeded context; env layers are
 * overlaid onto `process.env` in registration order, then the caller-supplied
 * env goes on top. When neither `envLayers` nor `options.env` is set we pass
 * `undefined` so the child inherits `process.env` verbatim. Bound at Session
 * scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { IExecContext } from '#/session/execContext';

import { type IProcess, ISessionProcessRunner, type ProcessExecOptions } from './processRunner';

export class SessionProcessRunner implements ISessionProcessRunner {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IExecContext private readonly ctx: IExecContext,
    @IHostProcessService private readonly hostProcess: IHostProcessService,
  ) {}

  async exec(args: readonly string[], options?: ProcessExecOptions): Promise<IProcess> {
    const command = args[0];
    if (command === undefined) {
      throw new Error(
        'SessionProcessRunner.exec(): at least one argument (the command to run) is required.',
      );
    }
    const restArgs = args.slice(1);

    const cwd = options?.cwd ?? this.ctx.cwd;
    const env = this._buildExecEnv(options?.env);

    return this.hostProcess.spawn(command, restArgs, { cwd, env });
  }

  private _buildExecEnv(
    invocationEnv: Record<string, string> | undefined,
  ): Record<string, string> | undefined {
    // No overrides at all — inherit process.env verbatim by passing `undefined`
    // to the host process service. Mirrors the pre-refactor behaviour when
    // neither the session context nor the caller wanted to touch the child's
    // environment.
    if (this.ctx.envLayers.length === 0 && invocationEnv === undefined) {
      return undefined;
    }
    const merged: Record<string, string> = {
      ...(process.env as Record<string, string>),
    };
    for (const layer of this.ctx.envLayers) {
      Object.assign(merged, layer);
    }
    if (invocationEnv !== undefined) {
      Object.assign(merged, invocationEnv);
    }
    return merged;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionProcessRunner,
  SessionProcessRunner,
  InstantiationType.Delayed,
  'process',
);
