import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

/**
 * The review modes that a session may be in at most one of. `plan` and `swarm`
 * are the one deliberate exception and may be active together; see
 * `AgentModeMutexService` for the full conflict table.
 */
export type ExclusiveReviewMode = 'plan' | 'spec' | 'swarm' | 'tower';

export interface IAgentModeMutexService {
  readonly _serviceBrand: undefined;

  /**
   * The exclusive mode the agent is currently in, or `null`. `plan` is reported
   * ahead of `swarm` because `plan`+`swarm` is a legal pair and `plan` is the
   * mode whose guard is stricter.
   */
  activeMode(): ExclusiveReviewMode | null;

  /**
   * Become `target`, evicting every mode that conflicts with it first.
   *
   * If `target` is already active this is a no-op. If entering `target` throws
   * after the previous mode was evicted, the previous mode is restored so a
   * failed switch never leaves the session with no mode at all.
   */
  switchTo(target: ExclusiveReviewMode): Promise<void>;

  /** Leave `target` if it is currently active. No-op otherwise. */
  leave(target: ExclusiveReviewMode): Promise<void>;
}

export const IAgentModeMutexService: ServiceIdentifier<IAgentModeMutexService> =
  createDecorator<IAgentModeMutexService>('agentModeMutexService');
