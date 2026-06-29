/**
 * `agentFs` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const FsErrors = {
  codes: {
    FS_PATH_NOT_FOUND: 'fs.path_not_found',
    FS_PERMISSION_DENIED: 'fs.permission_denied',
    FS_PATH_ESCAPES: 'fs.path_escapes',
    FS_TOO_MANY_RESULTS: 'fs.too_many_results',
    FS_GREP_TIMEOUT: 'fs.grep_timeout',
    FS_GIT_UNAVAILABLE: 'fs.git_unavailable',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(FsErrors);
