/**
 * `stepRetry` domain (L4) — `IAgentStepRetryService` implementation.
 *
 * Loop error-recovery plugin: claims retryable provider failures (HTTP 429 /
 * 5xx, connection, timeout, empty response — `isRetryableGenerateError`) from
 * the loop's error-handler registry and re-runs the failed step's driver
 * after exponential backoff (`retryBackoffDelays`). The retry resumes the
 * failed step's number, so attempts consume no `maxSteps` budget; each
 * claimed failure publishes `turn.step.retrying`. Consecutive attempts are
 * counted per failed driver and reset when any step succeeds (`afterStep`)
 * or a new turn starts. Bound at Agent scope; Eager so the handler registers
 * before the first turn runs (same rationale as `fullCompaction`).
 */

import type { TurnStepRetryingEvent } from '@moonshot-ai/protocol';

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  retryBackoffDelays,
  retryErrorFields,
  sleepForRetry,
} from '#/_base/utils/retry';
import { isRetryableGenerateError } from '#/app/llmProtocol/errors';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { unwrapErrorCause } from '#/errors';
import {
  IAgentLoopService,
  type LoopErrorContext,
  type LoopErrorRecovery,
} from '#/agent/loop/loop';
import { LOOP_CONTROL_SECTION, type LoopControl } from '#/agent/loop/configSection';

import { IAgentStepRetryService } from './stepRetry';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'turn.step.retrying': TurnStepRetryingEvent;
  }
}

export class AgentStepRetryService extends Disposable implements IAgentStepRetryService {
  declare readonly _serviceBrand: undefined;

  private lastFailedDriverId: string | undefined;
  private failedAttempts = 0;

  constructor(
    @IAgentLoopService loopService: IAgentLoopService,
    @IConfigService private readonly config: IConfigService,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    super();
    this._register(
      loopService.registerLoopErrorHandler({
        id: 'step-retry',
        match: (context) => isRetryableGenerateError(unwrapErrorCause(context.error)),
        handle: (context) => this.recover(context),
      }),
    );
    this._register(
      loopService.hooks.afterStep.register('step-retry', async (_ctx, next) => {
        this.resetAttempts();
        await next();
      }),
    );
    this._register(this.eventBus.subscribe('turn.started', () => this.resetAttempts()));
  }

  private resetAttempts(): void {
    this.lastFailedDriverId = undefined;
    this.failedAttempts = 0;
  }

  private async recover(context: LoopErrorContext): Promise<LoopErrorRecovery | undefined> {
    const driver = context.failedDriver;
    if (driver === undefined || context.step === undefined) return undefined;

    if (this.lastFailedDriverId !== driver.id) {
      this.lastFailedDriverId = driver.id;
      this.failedAttempts = 0;
    }
    this.failedAttempts += 1;

    const maxAttempts = Math.max(
      this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxRetriesPerStep ??
        DEFAULT_MAX_RETRY_ATTEMPTS,
      1,
    );
    if (this.failedAttempts >= maxAttempts) {
      this.resetAttempts();
      return undefined;
    }

    const delayMs = retryBackoffDelays(maxAttempts)[this.failedAttempts - 1] ?? 0;
    this.eventBus.publish({
      type: 'turn.step.retrying',
      turnId: context.turnId,
      step: context.step,
      stepId: context.stepId,
      failedAttempt: this.failedAttempts,
      nextAttempt: this.failedAttempts + 1,
      maxAttempts,
      delayMs,
      ...retryErrorFields(unwrapErrorCause(context.error)),
    });
    await sleepForRetry(delayMs, context.signal);

    // The driver is already materialized, so its messages are not appended a
    // second time; re-running it resumes the same step number.
    return { requests: [driver], resumeStep: true };
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentStepRetryService,
  AgentStepRetryService,
  InstantiationType.Eager,
  'stepRetry',
);
