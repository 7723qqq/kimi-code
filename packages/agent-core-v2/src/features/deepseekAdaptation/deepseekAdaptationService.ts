import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ILogService, type ILogger } from '#/_base/log/log';
import { IAgentProfileService } from '#/agent/profile/profile';
import { loadCuratedAdaptation } from '#/app/agentProfileCatalog/modelAdaptations';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { systemReminderContent } from '#/features/reminder/systemReminder';
import type { ContextInjectionContext } from '#/features/reminder/types';

export interface IDeepseekAdaptationService {
  readonly _serviceBrand: undefined;
}

export const IDeepseekAdaptationService =
  createDecorator<IDeepseekAdaptationService>('deepseekAdaptationService');

export const DEEPSEEK_ADAPTATION_INJECTION_VARIANT = 'deepseek_adaptation';

export const loadCuratedDeepseekAdaptation = loadCuratedAdaptation;

export class DeepseekAdaptationService extends Service implements IDeepseekAdaptationService {
  declare readonly _serviceBrand: undefined;

  private readonly adaptationCache = new Map<string, string | undefined>();

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
  }

  private async resolve(injection: ContextInjectionContext): Promise<string | undefined> {
    const wire = this.profile.getModelWireName();
    if (wire === undefined) return undefined;
    let desired = this.adaptationCache.get(wire);
    if (!this.adaptationCache.has(wire)) {
      desired = await loadCuratedDeepseekAdaptation(wire, this.log);
      this.adaptationCache.set(wire, desired);
    }
    if (desired === undefined) return undefined;
    const latest = injection.lastInjection;
    if (latest !== undefined && systemReminderContent(latest)?.trim() === desired.trim()) {
      return undefined;
    }
    return desired;
  }
}
