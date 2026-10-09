import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { createDecorator } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { ILogService, type ILogger } from '#/_base/log/log';
import { IAgentProfileService } from '#/agent/profile/profile';
import {
  MODEL_ADAPTATIONS_ENV,
  resolveModelAdaptationText,
} from '#/app/agentProfileCatalog/modelAdaptations';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { systemReminderContent } from '#/features/reminder/systemReminder';
import type { ContextInjectionContext } from '#/features/reminder/types';

export interface IDeepseekAdaptationService {
  readonly _serviceBrand: undefined;
}

export const IDeepseekAdaptationService =
  createDecorator<IDeepseekAdaptationService>('deepseekAdaptationService');

export const DEEPSEEK_ADAPTATION_INJECTION_VARIANT = 'deepseek_adaptation';

/**
 * Caches the in-flight load per wire name, not the settled value.
 *
 * The provider is async and the reminder service can ask for it during any step,
 * so two callers can overlap before either write completes; caching the promise
 * means the file is read once no matter how many callers race it. A resolved
 * `undefined` is a real entry, so a model with no adaptation does not re-read
 * the directory on every step.
 */
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
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @ILogService private readonly log: ILogger,
  ) {
    super();
    this._register(
      reminder.register(DEEPSEEK_ADAPTATION_INJECTION_VARIANT, (injection) =>
        this.resolve(injection),
      ),
    );
  }

  /**
   * Resolves the family guidance for this model.
   *
   * The text is standing guidance for the whole session, so it is computed from
   * the wire name and the opt-in flag — neither of which changes mid-session —
   * rather than re-derived from the conversation on every step. Re-deriving cost
   * a file read per step and put the injection point back at the end of the
   * context repeatedly, which is where a cache prefix is most likely to be
   * invalidated; the value only needs rebuilding once compaction has dropped it.
   */
  private async resolve(injection: ContextInjectionContext): Promise<string | undefined> {
    const wire = this.profile.getModelWireName();
    if (wire === undefined) return undefined;

    const latest = injection.lastInjection;
    if (latest !== undefined) {
      const present = systemReminderContent(latest)?.trim();
      if (present !== undefined && present.length > 0) return undefined;
    }

    return this.adaptationCache.load(wire, () =>
      resolveModelAdaptationText({
        model: wire,
        optIn: this.bootstrap.getEnv(MODEL_ADAPTATIONS_ENV),
        log: this.log,
      }),
    );
  }
}
