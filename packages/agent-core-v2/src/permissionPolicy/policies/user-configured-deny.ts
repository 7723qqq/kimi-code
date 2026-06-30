import type { ResolvedToolExecutionHookContext } from '#/tool';
import { IAgentPermissionRulesService } from '../../permissionRules/permissionRules';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../types';
import { evaluateUserConfiguredRule } from './user-configured-rule';

export class UserConfiguredDenyPermissionPolicyService implements PermissionPolicy {
  readonly name = 'user-configured-deny';

  constructor(@IAgentPermissionRulesService private readonly rulesService: IAgentPermissionRulesService) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    return evaluateUserConfiguredRule(context, 'deny', this.rulesService);
  }
}
