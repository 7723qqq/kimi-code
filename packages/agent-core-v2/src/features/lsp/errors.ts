/**
 * `lsp` domain error codes — semantic navigation failures.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const LspErrors = {
  codes: {
    LSP_UNAVAILABLE: 'lsp.unavailable',
    LSP_CONFLICT: 'lsp.conflict',
    LSP_UNSUPPORTED_OPERATION: 'lsp.unsupported_operation',
    LSP_MALFORMED_RESPONSE: 'lsp.malformed_response',
    LSP_WORKSPACE_REQUIRED: 'lsp.workspace_required',
    LSP_SERVER_FAILED: 'lsp.server_failed',
  },
  retryable: ['lsp.server_failed'],
} as const satisfies ErrorDomain;

registerErrorDomain(LspErrors);
