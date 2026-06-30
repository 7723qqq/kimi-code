import type { ResolvedToolExecutionHookContext } from '#/tool';
import { IPermissionRulesService } from '../../permissionRules/permissionRules';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../types';
import { evaluateUserConfiguredRule } from './user-configured-rule';

export class UserConfiguredAllowPermissionPolicyService implements PermissionPolicy {
  readonly name = 'user-configured-allow';

  constructor(@IPermissionRulesService private readonly rulesService: IPermissionRulesService) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    return evaluateUserConfiguredRule(context, 'allow', this.rulesService);
  }
}
