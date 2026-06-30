import type { ResolvedToolExecutionHookContext } from '#/tool';
import { IAgentPermissionRulesService } from '../../permissionRules/permissionRules';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../types';
import { evaluateUserConfiguredRule } from './user-configured-rule';

export class UserConfiguredAllowPermissionPolicyService implements PermissionPolicy {
  readonly name = 'user-configured-allow';

  constructor(@IAgentPermissionRulesService private readonly rulesService: IAgentPermissionRulesService) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    return evaluateUserConfiguredRule(context, 'allow', this.rulesService);
  }
}
