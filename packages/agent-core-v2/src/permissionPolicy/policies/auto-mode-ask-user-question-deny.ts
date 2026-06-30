import type { ResolvedToolExecutionHookContext } from '#/tool';
import { IAgentPermissionModeService } from '../../permissionMode/permissionMode';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../types';

export class AutoModeAskUserQuestionDenyPermissionPolicyService implements PermissionPolicy {
  readonly name = 'auto-mode-ask-user-question-deny';

  constructor(
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    if (this.modeService.mode !== 'auto') return undefined;
    if (context.toolCall.name !== 'AskUserQuestion') return undefined;
    return {
      kind: 'deny',
      message:
        'AskUserQuestion is disabled while auto permission mode is active. Make a reasonable decision and continue without asking the user.',
    };
  }
}
