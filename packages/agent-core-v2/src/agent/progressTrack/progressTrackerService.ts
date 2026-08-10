/**
 * `progressTrack` service (Agent scope) — wires the outcome tracker to the
 * tool-execution pipeline and injects the Evidence-Before-More-Mutation
 * reminder (ported from Reasonix's Auto Guard EBM trigger).
 *
 * Observes every tool round through the executor's `onDidExecuteTool` hook,
 * feeds normalized receipts into {@link ProgressTracker}, and — when the
 * agent has mutated files repeatedly without any discriminating observation
 * (verification run, or a command exercising a mutated file) — appends a
 * model-visible reminder to verify before mutating further. The reminder is
 * injected at most once per turn; a verification run resets the debt.
 */

import { Service } from '#/_base/di/service';
import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ToolDidExecuteContext } from '#/agent/toolExecutor/toolHooks';

import {
  ProgressTracker,
  type ToolReceipt,
} from './progressTracker';

export const EBM_REMINDER_VARIANT = 'progress-track-ebm';

/** Mutations without a discriminating observation that trip the reminder. */
export const EBM_BLIND_MUTATION_THRESHOLD = 3;

const EBM_REMINDER = [
  `You have made ${EBM_BLIND_MUTATION_THRESHOLD} or more changes since the last time`,
  'a test or check was run, and none of your recent commands could have verified',
  'them. Run a verification command (tests, typecheck, linter) before making',
  'further changes, so failures are caught while they are still attributable.',
].join(' ');

export interface IProgressTrackerService {
  readonly _serviceBrand: undefined;
}

export const IProgressTrackerService =
  createDecorator<IProgressTrackerService>('agentProgressTrackerService');

export class ProgressTrackerService
  extends Service
  implements IProgressTrackerService
{
  declare readonly _serviceBrand: undefined;

  private readonly tracker = new ProgressTracker();
  private ebmInjectedThisTurn = false;

  constructor(
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IEventBus eventBus: IEventBus,
  ) {
    super();
    this._register(
      toolExecutor.hooks.onDidExecuteTool.register(
        'progress-track',
        async (ctx, next) => {
          this.observeToolRound(ctx);
          await next(ctx);
        },
      ),
    );
    this._register(
      eventBus.subscribe('turn.started', () => {
        this.ebmInjectedThisTurn = false;
      }),
    );
  }

  private observeToolRound(ctx: ToolDidExecuteContext): void {
    const receipt = receiptFromContext(ctx);
    const sample = this.tracker.scoreRound([receipt]);
    if (sample.blindMutations >= EBM_BLIND_MUTATION_THRESHOLD) {
      this.maybeInjectEbmReminder();
    }
  }

  private maybeInjectEbmReminder(): void {
    if (this.ebmInjectedThisTurn) return;
    this.reminders.appendSystemReminder(EBM_REMINDER, {
      kind: 'injection',
      variant: EBM_REMINDER_VARIANT,
    });
    this.ebmInjectedThisTurn = true;
  }
}

function receiptFromContext(ctx: ToolDidExecuteContext): ToolReceipt {
  const args = ctx.args as Record<string, unknown> | undefined;
  const command =
    typeof args?.['command'] === 'string' ? (args['command'] as string) : undefined;
  const read: string[] = [];
  const write: string[] = [];
  for (const access of ctx.accesses ?? []) {
    if (access.kind !== 'file') continue;
    if (access.operation === 'read' || access.operation === 'search') {
      read.push(access.path);
    } else if (access.operation === 'write') {
      write.push(access.path);
    } else if (access.operation === 'readwrite') {
      read.push(access.path);
      write.push(access.path);
    }
  }
  const executed = ctx.outcome === 'executed';
  return {
    toolName: ctx.toolCall.name,
    command,
    paths: read.length > 0 || write.length > 0 ? { read, write } : undefined,
    success: executed && ctx.result.isError !== true,
    isError: ctx.result.isError,
  };
}

registerScopedService(
  LifecycleScope.Agent,
  IProgressTrackerService,
  ProgressTrackerService,
  ScopeActivation.OnScopeCreated,
  'progressTrack',
);
