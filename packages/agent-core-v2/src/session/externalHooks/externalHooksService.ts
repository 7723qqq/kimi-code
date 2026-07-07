/**
 * `externalHooks` domain (L6) — Session-scope adapter for external hook commands.
 *
 * Registers with `sessionLifecycle` hook slots to run `SessionStart` and
 * `SessionEnd` external commands for the current `sessionContext`, delegating
 * the actual hook execution to the shared App-scope
 * `IExternalHooksRunnerService`. Bound at Session scope; purely an observer —
 * all config/plugin loading and engine lifecycle live in the runner.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IExternalHooksRunnerService } from '#/app/externalHooksRunner/externalHooksRunner';
import {
  ISessionLifecycleService,
  type SessionCloseReason,
  type SessionCreateSource,
} from '#/app/sessionLifecycle/sessionLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { ISessionExternalHooksService } from './externalHooks';

type SessionStartHookSource = Exclude<SessionCreateSource, 'fork'>;

export class SessionExternalHooksService
  extends Disposable
  implements ISessionExternalHooksService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @ISessionContext private readonly context: ISessionContext,
    @ISessionLifecycleService lifecycle: ISessionLifecycleService,
    @IExternalHooksRunnerService private readonly runner: IExternalHooksRunnerService,
  ) {
    super();
    this._register(
      lifecycle.hooks.onDidCreateSession.register('externalHooks', async (event, next) => {
        if (event.sessionId === this.context.sessionId && event.source !== 'fork') {
          await this.triggerSessionStart(event.source);
        }
        await next();
      }),
    );
    this._register(
      lifecycle.hooks.onWillCloseSession.register('externalHooks', async (event, next) => {
        if (event.sessionId === this.context.sessionId) {
          await this.triggerSessionEnd(event.reason);
        }
        await next();
      }),
    );
  }

  private async triggerSessionStart(source: SessionStartHookSource): Promise<void> {
    await this.runner.trigger('SessionStart', {
      matcherValue: source,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      inputData: { source },
    });
  }

  private async triggerSessionEnd(reason: SessionCloseReason): Promise<void> {
    await this.runner.trigger('SessionEnd', {
      matcherValue: reason,
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
      inputData: { reason },
    });
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionExternalHooksService,
  SessionExternalHooksService,
  InstantiationType.Eager,
  'externalHooks',
);
