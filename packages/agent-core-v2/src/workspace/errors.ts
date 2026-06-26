/**
 * `workspace` domain error codes and error classes.
 *
 * Codes are sourced from the protocol `KimiErrorCode` set so the wire shape
 * matches the existing REST routes (`workspace.not_found`, `fs.path_not_found`,
 * `fs.permission_denied`, `validation.failed`). A single `ErrorDomain` owns all
 * codes so a shared code (e.g. `fs.path_not_found`, used by both the registry
 * and the fs browser) is registered exactly once.
 */

import { KimiError, registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const WorkspaceErrors = {
  codes: {
    WORKSPACE_NOT_FOUND: 'workspace.not_found',
    PATH_NOT_ABSOLUTE: 'validation.failed',
    PATH_NOT_FOUND: 'fs.path_not_found',
    PERMISSION_DENIED: 'fs.permission_denied',
  },
  info: {
    'workspace.not_found': {
      title: 'Workspace not found',
      retryable: false,
      public: true,
    },
    'validation.failed': {
      title: 'Path must be absolute',
      retryable: false,
      public: true,
    },
    'fs.path_not_found': {
      title: 'Path not found',
      retryable: false,
      public: true,
    },
    'fs.permission_denied': {
      title: 'Permission denied',
      retryable: false,
      public: true,
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(WorkspaceErrors);

export type WorkspaceErrorCode = (typeof WorkspaceErrors.codes)[keyof typeof WorkspaceErrors.codes];

export class WorkspaceError extends KimiError {
  constructor(code: WorkspaceErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, { details });
    this.name = 'WorkspaceError';
  }
}

export class WorkspaceFsError extends KimiError {
  constructor(code: WorkspaceErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, { details });
    this.name = 'WorkspaceFsError';
  }
}
