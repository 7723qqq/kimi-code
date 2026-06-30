/**
 * `permissionMode` test stubs — shared doubles for
 * `IAgentPermissionModeService`.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../permissionMode/stubs`).
 */

import { createHooks } from '#/hooks';
import type { Hooks } from '#/hooks';
import type { IAgentPermissionModeService } from '#/permissionMode';
import type { PermissionMode } from '#/permissionPolicy';

export function stubPermissionModeService(
  mode: () => PermissionMode,
): IAgentPermissionModeService {
  return {
    _serviceBrand: undefined,
    get mode() {
      return mode();
    },
    setMode: () => {},
    hooks: createHooks(['onChanged']) as Hooks<{
      onChanged: { mode: PermissionMode; previousMode: PermissionMode };
    }>,
  };
}
