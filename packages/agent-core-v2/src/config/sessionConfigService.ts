/**
 * `config` domain (L2) — `ISessionConfigService` implementation.
 *
 * Owns the active session's runtime config overrides; reads global defaults
 * through `config`, persists session-level overrides through `records`, and logs
 * through `log`. Bound at Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/log/log';
import { ISessionMetaStore } from '#/sessionMetaStore';

import {
  type SessionConfigChangedEvent,
  type SessionConfigPatch,
  type SessionConfigSection,
  IConfigService,
  ISessionConfigService,
} from './config';
import { describeUnknownError, omitUndefined } from './configPure';

export class SessionConfigService extends Disposable implements ISessionConfigService {
  declare readonly _serviceBrand: undefined;
  private readonly _onDidChange = this._register(new Emitter<SessionConfigChangedEvent>());
  readonly onDidChange: Event<SessionConfigChangedEvent> = this._onDidChange.event;
  readonly ready: Promise<void>;

  private modelAliasValue: string | undefined;
  private thinkingLevelValue: string | undefined;
  private systemPromptValue: string | undefined;
  private providerValue: string | undefined;

  constructor(
    @IConfigService config: IConfigService,
    @ISessionMetaStore private readonly meta: ISessionMetaStore,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    const section = config.get<SessionConfigSection>('session') ?? {};
    this.apply(section, false);
    this.ready = this.restore();
  }

  get modelAlias(): string | undefined {
    return this.modelAliasValue;
  }
  get thinkingLevel(): string | undefined {
    return this.thinkingLevelValue;
  }
  get systemPrompt(): string | undefined {
    return this.systemPromptValue;
  }
  get provider(): string | undefined {
    return this.providerValue;
  }

  async update(patch: SessionConfigPatch): Promise<void> {
    const clean = omitUndefined(patch as Record<string, unknown>) as SessionConfigPatch;
    if (Object.keys(clean).length === 0) return;
    await this.meta.write(clean);
    this.apply(clean, true);
  }

  setModel(alias: string): Promise<void> {
    return this.update({ modelAlias: alias });
  }

  setThinking(level: string): Promise<void> {
    return this.update({ thinkingLevel: level });
  }

  private async restore(): Promise<void> {
    try {
      const stored = await this.meta.read();
      this.apply(stored as Partial<SessionConfigSection>, false);
    } catch (error) {
      this.log.warn('session config restore failed', { error: describeUnknownError(error) });
    }
  }

  private apply(patch: Partial<SessionConfigSection>, emit: boolean): void {
    const changed: (keyof SessionConfigSection)[] = [];
    if (patch.modelAlias !== undefined && patch.modelAlias !== this.modelAliasValue) {
      this.modelAliasValue = patch.modelAlias;
      changed.push('modelAlias');
    }
    if (patch.thinkingLevel !== undefined && patch.thinkingLevel !== this.thinkingLevelValue) {
      this.thinkingLevelValue = patch.thinkingLevel;
      changed.push('thinkingLevel');
    }
    if (patch.systemPrompt !== undefined && patch.systemPrompt !== this.systemPromptValue) {
      this.systemPromptValue = patch.systemPrompt;
      changed.push('systemPrompt');
    }
    if (patch.provider !== undefined && patch.provider !== this.providerValue) {
      this.providerValue = patch.provider;
      changed.push('provider');
    }
    if (emit && changed.length > 0) {
      this._onDidChange.fire({ changed });
    }
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionConfigService,
  SessionConfigService,
  InstantiationType.Delayed,
  'config',
);
