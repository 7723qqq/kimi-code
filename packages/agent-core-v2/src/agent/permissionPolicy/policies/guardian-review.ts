import { IAgentGuardianService } from '#/agent/guardian/guardianService';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionPolicy, PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';

export class GuardianReviewPermissionPolicyService implements PermissionPolicy {
  readonly name = 'guardian-review';

  constructor(
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IAgentGuardianService private readonly guardian: IAgentGuardianService,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    if (this.modeService.mode !== 'yolo') return undefined;
    if (!this.guardian.enabled) return undefined;
    if (!isHighRisk(context)) return undefined;

    const verdict = await this.guardian.review(context);
    switch (verdict.verdict) {
      case 'allow':
        if (verdict.riskLevel === 'low' || verdict.userAuthorization === 'explicit') {
          return { kind: 'approve', reason: { guardian: verdict.rationale } };
        }
        return {
          kind: 'ask',
          reason: {
            guardian: `guardian allowed but risk=${verdict.riskLevel}, authorization=${verdict.userAuthorization}: ${verdict.rationale}`,
          },
        };
      case 'deny':
        return {
          kind: 'ask',
          reason: { guardian: `denied (${verdict.riskLevel}): ${verdict.rationale}` },
        };
      case 'bypass':
        return undefined;
    }
  }
}

function isHighRisk(context: ResolvedToolExecutionHookContext): boolean {
  if (context.toolCall.name === 'Bash') return true;
  for (const access of context.execution.accesses ?? []) {
    if (
      access.kind === 'file' &&
      (access.operation === 'write' || access.operation === 'readwrite')
    ) {
      return true;
    }
  }
  return false;
}
