import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicy';
import type { PermissionData } from '#/agent/permissionPolicy/types';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  BeforeToolExecuteEvent,
  ResolvedToolExecutionHookContext,
  ToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { ITelemetryService } from '#/app/telemetry/telemetry';

import { IAgentPermissionGate } from './permissionGate';

const APPROVAL_MEMO_TTL_MS = 60_000;
const APPROVAL_MEMO_MAX = 64;

interface ApprovalMemoEntry {
  readonly toolName: string;
  readonly argsFingerprint: string;
  readonly executionMetadata: unknown;
  readonly grantedAt: number;
}

function memoKey(turnId: number, toolCallId: string): string {
  return `${turnId}\u0000${toolCallId}`;
}

function fingerprintArgs(args: unknown): string {
  return JSON.stringify(args) ?? '';
}

export class AgentPermissionGate extends Service implements IAgentPermissionGate {
  declare readonly _serviceBrand: undefined;
  private readonly approvalMemo = new Map<string, ApprovalMemoEntry>();
  constructor(
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IAgentPermissionRulesService private readonly rulesService: IAgentPermissionRulesService,
    @IAgentPermissionPolicyService private readonly policyService: IAgentPermissionPolicyService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();
    this._register(toolExecutor.onBeforeExecuteTool((event) => this.adjudicate(event)));
  }

  data(): PermissionData {
    return {
      mode: this.modeService.mode,
      rules: [...this.rulesService.rules],
    };
  }

  private rememberApproval(context: ToolExecutionHookContext, executionMetadata: unknown): void {
    const now = Date.now();
    for (const [key, entry] of this.approvalMemo) {
      if (now - entry.grantedAt > APPROVAL_MEMO_TTL_MS) this.approvalMemo.delete(key);
    }
    while (this.approvalMemo.size >= APPROVAL_MEMO_MAX) {
      const oldest = this.approvalMemo.keys().next().value;
      if (oldest === undefined) break;
      this.approvalMemo.delete(oldest);
    }
    this.approvalMemo.set(memoKey(context.turnId, context.toolCall.id), {
      toolName: context.toolCall.name,
      argsFingerprint: fingerprintArgs(context.args),
      executionMetadata,
      grantedAt: now,
    });
  }

  private consumeApproval(context: ToolExecutionHookContext): ApprovalMemoEntry | undefined {
    const key = memoKey(context.turnId, context.toolCall.id);
    const entry = this.approvalMemo.get(key);
    if (entry === undefined) return undefined;
    this.approvalMemo.delete(key);
    if (Date.now() - entry.grantedAt > APPROVAL_MEMO_TTL_MS) return undefined;
    if (entry.toolName !== context.toolCall.name) return undefined;
    if (entry.argsFingerprint !== fingerprintArgs(context.args)) return undefined;
    return entry;
  }

  private async adjudicate(event: BeforeToolExecuteEvent): Promise<void> {
    const approved = this.consumeApproval(event);
    if (approved !== undefined) {
      if (approved.executionMetadata !== undefined) event.pass(approved.executionMetadata);
      return;
    }
    const evaluation = await this.policyService.evaluate(event);
    if (evaluation === undefined) return;
    this.telemetry.track2('permission_policy_decision', {
      turn_id: event.turnId,
      tool_call_id: event.toolCall.id,
      policy_name: evaluation.policyName,
      tool_name: event.toolCall.name,
      permission_mode: this.modeService.mode,
      decision: evaluation.result.kind,
      ...evaluation.result.reason,
    });
    const { result, policyName } = evaluation;
    if (result.kind === 'ask') {
      event.waitUntil(() => this.toolApproval.requestToolApproval(event, result, policyName));
      return;
    }
    if (result.kind === 'approve') {
      event.pass(result.executionMetadata);
      return;
    }
    const resolved = await this.toolApproval.resolvePermissionResolution(result, event, policyName);
    if (resolved?.veto !== undefined) {
      event.veto(resolved.veto);
    }
  }

  async authorize(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    const evaluation = await this.policyService.evaluate(context);
    if (evaluation === undefined) return undefined;
    this.telemetry.track2('permission_policy_decision', {
      turn_id: context.turnId,
      tool_call_id: context.toolCall.id,
      policy_name: evaluation.policyName,
      tool_name: context.toolCall.name,
      permission_mode: this.modeService.mode,
      decision: evaluation.result.kind,
      ...evaluation.result.reason,
    });
    const resolved = await this.toolApproval.resolvePermissionResolution(
      evaluation.result,
      context,
      evaluation.policyName,
    );
    if (evaluation.result.kind === 'ask' && resolved?.veto === undefined) {
      this.rememberApproval(context, resolved?.executionMetadata);
    }
    return resolved;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionGate,
  AgentPermissionGate,
  ScopeActivation.OnScopeCreated,
  'permissionGate',
);
