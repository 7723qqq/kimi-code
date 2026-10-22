import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ILogService, type ILogger } from '#/_base/log/log';
import { IAgentProfileService } from '#/agent/profile/profile';
import { loadCuratedAdaptation } from '#/app/agentProfileCatalog/modelAdaptations';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { systemReminderContent } from '#/features/reminder/systemReminder';
import type { ContextInjectionContext } from '#/features/reminder/types';

import { resolveTailContract, TAIL_ANCHOR_INJECTION_VARIANT } from './tailAnchorInjection';

export interface IDeepseekAdaptationService {
  readonly _serviceBrand: undefined;
}

export const IDeepseekAdaptationService =
  createDecorator<IDeepseekAdaptationService>('deepseekAdaptationService');

export const DEEPSEEK_ADAPTATION_INJECTION_VARIANT = 'deepseek_adaptation';

export class PendingAdaptationCache<T> {
  private readonly entries = new Map<string, Promise<T | undefined>>();

  get(key: string): Promise<T | undefined> | undefined {
    return this.entries.get(key);
  }

  load(key: string, load: () => Promise<T | undefined>): Promise<T | undefined> {
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing;
    const pending = load();
    this.entries.set(key, pending);
    return pending;
  }

  get size(): number {
    return this.entries.size;
  }
}

export class DeepseekAdaptationService extends Service implements IDeepseekAdaptationService {
  declare readonly _serviceBrand: undefined;

  private readonly adaptationCache = new PendingAdaptationCache<string>();

  constructor(
    @IAgentReminderService reminder: IAgentReminderService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ILogService private readonly log: ILogger,
  ) {
    super();
    this._register(
      reminder.register(DEEPSEEK_ADAPTATION_INJECTION_VARIANT, (injection) =>
        this.resolve(injection),
      ),
    );
    this._register(
      reminder.register(TAIL_ANCHOR_INJECTION_VARIANT, (injection) =>
        resolveTailContract(injection, this.profile.getModelWireName()),
      ),
    );
  }

  private async resolve(injection: ContextInjectionContext): Promise<string | undefined> {
    const wire = this.profile.getModelWireName();
    if (wire === undefined) return undefined;

    const latest = injection.lastInjection;
    if (latest !== undefined) {
      const present = systemReminderContent(latest)?.trim();
      if (present !== undefined && present.length > 0) return undefined;
    }

    return this.adaptationCache.load(wire, () => loadCuratedAdaptation(wire, this.log));
  }
}
