import type { ResolvedToolExecutionHookContext } from '#/tool';
import { IPermissionRulesService } from '../../permissionRules/permissionRules';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '../types';
import { evaluateUserConfiguredRule } from './user-configured-rule';

export class UserConfiguredDenyPermissionPolicyService implements PermissionPolicy {
  readonly name = 'user-configured-deny';

  constructor(@IPermissionRulesService private readonly rulesService: IPermissionRulesService) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    return evaluateUserConfiguredRule(context, 'deny', this.rulesService);
  }
}
