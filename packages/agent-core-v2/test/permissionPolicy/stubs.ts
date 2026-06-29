/**
 * `permissionPolicy` test stubs — shared doubles for
 * `IPermissionPolicyService`.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../permissionPolicy/stubs`).
 */

import type {
  IPermissionPolicyService,
  PermissionPolicyEvaluation,
} from '#/permissionPolicy';

export function stubPermissionPolicyService(
  next: () => PermissionPolicyEvaluation | undefined,
): IPermissionPolicyService {
  return {
    _serviceBrand: undefined,
    configure: () => {},
    evaluate: () => Promise.resolve(next()),
  };
}
