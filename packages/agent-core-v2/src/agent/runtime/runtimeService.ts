/**
 * `runtime` domain (L5) — `IAgentRuntimeService` implementation.
 *
 * Derives the agent's live phase from the existing `IEventBus` facts and folds
 * it into the `wire` `RuntimeModel` (mutated only through the
 * `runtime.set_phase` Op, read through `wire.getModel`). Subscriptions are
 * edge-triggered: a handler builds the candidate phase and `setPhase` only
 * dispatches when `phaseEqual` says it changed, so high-frequency delta streams
 * collapse into a single `streaming` record. The current phase and the
 * approval-resume target are kept as live-only fields (never in the Model) so
 * `wire.replay` stays silent and resumes into `idle`. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import type { PermissionApprovalRequestContext } from '#/agent/permissionGate/permissionGateService';
import type { TurnEndReason } from '@moonshot-ai/protocol';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';

import { type AgentPhase, IAgentRuntimeService } from './runtime';
import { phaseEqual, RuntimeModel, setRuntimePhase } from './runtimeOps';

interface TurnCursor {
  readonly turnId: number;
  readonly step: number;
  readonly stepId: string;
}

export class AgentRuntimeService extends Disposable implements IAgentRuntimeService {
  declare readonly _serviceBrand: undefined;

  private cursor: TurnCursor = { turnId: -1, step: 0, stepId: '' };
  private current: AgentPhase = { kind: 'idle' };
  private priorForApproval: AgentPhase | undefined;

  constructor(
    @IAgentWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    super();
    this._register(this.eventBus.subscribe('turn.started', (e) => this.onTurnStarted(e.turnId)));
    this._register(
      this.eventBus.subscribe('turn.step.started', (e) =>
        this.onStepStarted(e.turnId, e.step, e.stepId ?? ''),
      ),
    );
    this._register(
      this.eventBus.subscribe('assistant.delta', () => this.onDelta('assistant')),
    );
    this._register(
      this.eventBus.subscribe('thinking.delta', () => this.onDelta('thinking')),
    );
    this._register(
      this.eventBus.subscribe('tool.call.delta', (e) =>
        this.onToolCallDelta(e.toolCallId, e.name),
      ),
    );
    this._register(
      this.eventBus.subscribe('tool.call.started', (e) =>
        this.onToolCallStarted(e.toolCallId, e.name),
      ),
    );
    this._register(this.eventBus.subscribe('tool.result', () => this.onToolResult()));
    this._register(
      this.eventBus.subscribe('turn.step.retrying', (e) =>
        this.setPhase({
          kind: 'retrying',
          turnId: e.turnId,
          step: e.step,
          stepId: e.stepId ?? '',
          failedAttempt: e.failedAttempt,
          nextAttempt: e.nextAttempt,
          maxAttempts: e.maxAttempts,
          delayMs: e.delayMs,
          errorName: e.errorName,
          statusCode: e.statusCode,
          since: Date.now(),
        }),
      ),
    );
    this._register(
      this.eventBus.subscribe('turn.step.interrupted', (e) =>
        this.setPhase({
          kind: 'interrupted',
          turnId: e.turnId,
          step: e.step,
          reason: e.reason as 'aborted' | 'max_steps' | 'error',
          message: e.message,
          at: Date.now(),
        }),
      ),
    );
    this._register(
      this.eventBus.subscribe('turn.step.completed', () => this.setPhase(this.running())),
    );
    this._register(
      this.eventBus.subscribe('turn.ended', (e) =>
        this.onTurnEnded(e.turnId, e.reason, e.durationMs),
      ),
    );
    this._register(
      this.eventBus.subscribe('permission.approval.requested', (e) =>
        this.onApprovalRequested(e),
      ),
    );
    this._register(
      this.eventBus.subscribe('permission.approval.resolved', () => this.onApprovalResolved()),
    );
  }

  phase(): AgentPhase {
    return this.wire.getModel(RuntimeModel).phase;
  }

  private onTurnStarted(turnId: number): void {
    this.cursor = { turnId, step: 0, stepId: '' };
    this.priorForApproval = undefined;
    this.setPhase(this.running());
  }

  private onStepStarted(turnId: number, step: number, stepId: string): void {
    this.cursor = { turnId, step, stepId };
    this.setPhase(this.running());
  }

  private onDelta(stream: 'assistant' | 'thinking'): void {
    this.setPhase({
      kind: 'streaming',
      turnId: this.cursor.turnId,
      step: this.cursor.step,
      stepId: this.cursor.stepId,
      stream,
      since: Date.now(),
    });
  }

  private onToolCallDelta(toolCallId: string, name: string | undefined): void {
    this.setPhase({
      kind: 'streaming',
      turnId: this.cursor.turnId,
      step: this.cursor.step,
      stepId: this.cursor.stepId,
      stream: 'tool_call',
      toolCallId,
      toolName: name,
      since: Date.now(),
    });
  }

  private onToolCallStarted(toolCallId: string, name: string): void {
    this.setPhase({
      kind: 'tool_call',
      turnId: this.cursor.turnId,
      step: this.cursor.step,
      toolCallId,
      name,
      since: Date.now(),
    });
  }

  private onToolResult(): void {
    this.setPhase(this.running());
  }

  private onTurnEnded(turnId: number, reason: TurnEndReason, durationMs: number | undefined): void {
    this.setPhase({ kind: 'ended', turnId, reason, durationMs, at: Date.now() });
    this.cursor = { turnId: -1, step: 0, stepId: '' };
    this.priorForApproval = undefined;
  }

  private onApprovalRequested(approval: PermissionApprovalRequestContext): void {
    this.priorForApproval = this.current;
    this.setPhase({
      kind: 'awaiting_approval',
      turnId: approval.turnId,
      step: this.cursor.step || undefined,
      approval,
      since: Date.now(),
    });
  }

  private onApprovalResolved(): void {
    const resume = this.priorForApproval;
    this.priorForApproval = undefined;
    if (resume !== undefined && resume.kind !== 'idle' && resume.kind !== 'ended') {
      this.setPhase(resume);
    } else {
      this.setPhase(this.running());
    }
  }

  private running(): AgentPhase {
    return {
      kind: 'running',
      turnId: this.cursor.turnId,
      step: this.cursor.step,
      stepId: this.cursor.stepId,
      since: Date.now(),
    };
  }

  private setPhase(phase: AgentPhase): void {
    if (phaseEqual(this.current, phase)) return;
    this.current = phase;
    this.wire.dispatch(setRuntimePhase({ phase }));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentRuntimeService,
  AgentRuntimeService,
  InstantiationType.Delayed,
  'runtime',
);
