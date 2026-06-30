/**
 * `approval` test stubs — shared doubles for `IApprovalService`.
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../approval/stubs`).
 */

import type { ApprovalResponse, IApprovalService } from '#/approval/approval';

export function stubApprovalService(respond: () => ApprovalResponse): IApprovalService {
  return {
    _serviceBrand: undefined,
    request: async () => respond(),
    enqueue: (req) => ({ ...req, id: 'stub-approval-id' }),
    decide: () => {},
    listPending: () => [],
  };
}
