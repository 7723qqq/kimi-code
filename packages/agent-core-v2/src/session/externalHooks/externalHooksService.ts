/**
 * `externalHooks` domain (L6) — Session-scope adapter for external hook commands.
 *
 * Registers with `sessionLifecycle` hook slots to run `SessionStart` and
 * `SessionEnd` external commands for the current `sessionContext`, loading
 * configured hooks through `config` and plugin-contributed hooks through
 * `plugin`. Bound at Session scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IPluginService } from '#/app/plugin/plugin';
import {
  ISessionLifecycleService,
  type SessionCloseReason,
  type SessionCreateSource,
} from '#/app/sessionLifecycle/sessionLifecycle';
import { HOOKS_SECTION, type HookDefConfig } from '#/agent/externalHooks/configSection';
import { HookEngine } from '#/agent/externalHooks/engine';
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
    @IConfigService config: IConfigService,
    @IPluginService plugins: IPluginService,
  ) {
    super();
    let dynamicEngine = new HookEngine([], {
      cwd: this.context.cwd,
      sessionId: this.context.sessionId,
    });
    const loadDynamicHooks = async (): Promise<void> => {
      await config.ready;
      const configured = config.get(HOOKS_SECTION) as readonly HookDefConfig[] | undefined;
      const pluginHooks = await plugins.enabledHooks();
      dynamicEngine = new HookEngine([...(configured ?? []), ...pluginHooks], {
        cwd: this.context.cwd,
        sessionId: this.context.sessionId,
      });
    };
    const loadDynamicHooksSafe = async (): Promise<void> => {
      try {
        await loadDynamicHooks();
      } catch {}
    };
    const hooksReady = loadDynamicHooksSafe();
    const readyEngine = async (): Promise<HookEngine> => {
      await hooksReady;
      return dynamicEngine;
    };
    const triggerSessionStart = async (source: SessionStartHookSource): Promise<void> => {
      const engine = await readyEngine();
      await engine.trigger('SessionStart', {
        matcherValue: source,
        inputData: {
          sessionId: this.context.sessionId,
          cwd: this.context.cwd,
          source,
        },
      });
    };
    const triggerSessionEnd = async (reason: SessionCloseReason): Promise<void> => {
      const engine = await readyEngine();
      await engine.trigger('SessionEnd', {
        matcherValue: reason,
        inputData: {
          sessionId: this.context.sessionId,
          cwd: this.context.cwd,
          reason,
        },
      });
    };
    this._register(
      lifecycle.hooks.onDidCreateSession.register('externalHooks', async (event, next) => {
        if (event.sessionId === this.context.sessionId && event.source !== 'fork') {
          await triggerSessionStart(event.source);
        }
        await next();
      }),
    );
    this._register(
      lifecycle.hooks.onWillCloseSession.register('externalHooks', async (event, next) => {
        if (event.sessionId === this.context.sessionId) {
          await triggerSessionEnd(event.reason);
        }
        await next();
      }),
    );
    this._register(
      plugins.onDidReload(() => {
        void loadDynamicHooksSafe();
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionExternalHooksService,
  SessionExternalHooksService,
  InstantiationType.Eager,
  'externalHooks',
);
