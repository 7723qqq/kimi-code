import {
  Disposable,
  IInstantiationService,
} from "#/_base/di";
import type { ResolvedToolExecutionHookContext } from '#/tool';
import { AgentSwarmExclusiveDenyPermissionPolicyService } from './policies/agent-swarm-exclusive-deny';
import { AutoModeApprovePermissionPolicyService } from './policies/auto-mode-approve';
import { AutoModeAskUserQuestionDenyPermissionPolicyService } from './policies/auto-mode-ask-user-question-deny';
import { DefaultToolApprovePermissionPolicyService } from './policies/default-tool-approve';
import { ExitPlanModeReviewAskPermissionPolicyService } from './policies/exit-plan-mode-review-ask';
import { FallbackAskPermissionPolicyService } from './policies/fallback-ask';
import { GitControlPathAccessAskPermissionPolicyService } from './policies/git-control-path-access-ask';
import { GitCwdWriteApprovePermissionPolicyService } from './policies/git-cwd-write-approve';
import { GoalStartReviewAskPermissionPolicyService } from './policies/goal-start-review-ask';
import { PlanModeGuardDenyPermissionPolicyService } from './policies/plan-mode-guard-deny';
import { PlanModeToolApprovePermissionPolicyService } from './policies/plan-mode-tool-approve';
import { SensitiveFileAccessAskPermissionPolicyService } from './policies/sensitive-file-access-ask';
import { SessionApprovalHistoryPermissionPolicyService } from './policies/session-approval-history';
import { SwarmModeAgentSwarmApprovePermissionPolicyService } from './policies/swarm-mode-agent-swarm-approve';
import { UserConfiguredAllowPermissionPolicyService } from './policies/user-configured-allow';
import { UserConfiguredAskPermissionPolicyService } from './policies/user-configured-ask';
import { UserConfiguredDenyPermissionPolicyService } from './policies/user-configured-deny';
import { YoloModeApprovePermissionPolicyService } from './policies/yolo-mode-approve';
import {
  IAgentPermissionPolicyService,
  type PermissionPolicyEvaluation,
} from './permissionPolicy';
import type { PermissionPolicy } from "./types";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

export class AgentPermissionPolicyService
  extends Disposable
  implements IAgentPermissionPolicyService
{
  declare readonly _serviceBrand: undefined;

  private readonly policies: readonly PermissionPolicy[];

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
  ) {
    super();
    this.policies = [
      this.instantiation.createInstance(AgentSwarmExclusiveDenyPermissionPolicyService),
      this.instantiation.createInstance(AutoModeAskUserQuestionDenyPermissionPolicyService),
      this.instantiation.createInstance(PlanModeGuardDenyPermissionPolicyService),
      this.instantiation.createInstance(UserConfiguredDenyPermissionPolicyService),
      this.instantiation.createInstance(AutoModeApprovePermissionPolicyService),
      this.instantiation.createInstance(SessionApprovalHistoryPermissionPolicyService),
      this.instantiation.createInstance(UserConfiguredAskPermissionPolicyService),
      this.instantiation.createInstance(UserConfiguredAllowPermissionPolicyService),
      this.instantiation.createInstance(ExitPlanModeReviewAskPermissionPolicyService),
      this.instantiation.createInstance(GoalStartReviewAskPermissionPolicyService),
      this.instantiation.createInstance(PlanModeToolApprovePermissionPolicyService),
      this.instantiation.createInstance(SensitiveFileAccessAskPermissionPolicyService),
      this.instantiation.createInstance(GitControlPathAccessAskPermissionPolicyService),
      this.instantiation.createInstance(YoloModeApprovePermissionPolicyService),
      this.instantiation.createInstance(SwarmModeAgentSwarmApprovePermissionPolicyService),
      this.instantiation.createInstance(DefaultToolApprovePermissionPolicyService),
      this.instantiation.createInstance(GitCwdWriteApprovePermissionPolicyService),
      this.instantiation.createInstance(FallbackAskPermissionPolicyService),
    ];
  }

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyEvaluation | undefined> {
    for (const policy of this.policies) {
      const result = await policy.evaluate(context);
      if (result !== undefined) return { policyName: policy.name, result };
    }
    return undefined;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionPolicyService,
  AgentPermissionPolicyService,
  InstantiationType.Delayed,
  'permissionPolicy',
);
