/**
 * `permissionRules` test stubs — shared doubles for
 * `IPermissionRulesService`.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../permissionRules/stubs`).
 */

import { createHooks } from '#/hooks';
import type { Hooks } from '#/hooks';
import type {
  IPermissionRulesService,
  PermissionRule,
} from '#/permissionRules';

export function stubPermissionRulesService(
  rules: () => readonly PermissionRule[],
): IPermissionRulesService {
  return {
    _serviceBrand: undefined,
    get rules() {
      return rules();
    },
    sessionApprovalRulePatterns: [],
    addRules: () => {},
    recordApprovalResult: () => {},
    hooks: createHooks(['onChanged', 'onApprovalRecorded']) as Hooks<{
      onChanged: { rules: readonly PermissionRule[] };
      onApprovalRecorded: { record: never };
    }>,
  };
}
