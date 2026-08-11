/**
 * `guardian-review` permission policy (ported from Reasonix's Auto Guard).
 *
 * Sits immediately before `yolo-mode-approve` in the policy chain: under yolo
 * mode, high-risk tool calls (file writes, shell commands) are first reviewed
 * by the bounded AI guardian. `allow` proceeds to the yolo approval; `deny`
 * degrades to a human `ask` (the reviewer never silently blocks); `bypass`
 * (review unavailable or circuit open) falls through to the yolo approval.
 * Manual/auto modes are untouched — manual already has a human in the loop.
 */

import { IAgentGuardianService } from '#/agent/guardian/guardianService';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
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
        // An LLM-written `allow` only auto-approves when it claims low risk
        // or explicit user authorization; anything else is downgraded to a
        // human ask so a prompt-injected reviewer cannot keep waving through
        // high-risk operations.
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

/**
 * High-risk calls are the ones worth a reviewer round-trip: anything that
 * writes files or runs a shell command. Pure read-only tools skip the review
 * entirely (no extra LLM cost for the common safe path).
 */
function isHighRisk(context: ResolvedToolExecutionHookContext): boolean {
  if (context.toolCall.name === 'Bash') return true;
  for (const access of context.execution.accesses ?? []) {
    if (access.kind === 'file' && (access.operation === 'write' || access.operation === 'readwrite')) {
      return true;
    }
  }
  return false;
}
