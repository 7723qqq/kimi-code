/**
 * `sessionLifecycle` domain — persistence addressing along the handler chain.
 *
 * Pure functions deriving the persistence scope strings and on-disk
 * directories from the handler's `persistenceScope` (`sessions/{wd_id}`):
 * session = `{handlerScope}/{session_id}`, agent =
 * `{sessionScope}/agents/{agent_id}`. Under the local/local runtime these
 * are byte-identical to the layout the pre-Workspace engine wrote, so v1
 * readers (`session_index.jsonl`, snapshot readers) keep working unchanged.
 * Own no scoped state.
 */

import { join as nativeJoin } from 'node:path';

import { join } from 'pathe';

import { ErrorCodes, Error2 } from '#/errors';

export function workspacePersistenceScope(sessionsScope: string, workspaceId: string): string {
  return join(sessionsScope, workspaceId);
}

export function assertValidSessionId(sessionId: string): void {
  if (
    sessionId.length === 0 ||
    sessionId.includes('/') ||
    sessionId.includes('\\') ||
    sessionId.includes('..')
  ) {
    throw new Error2(ErrorCodes.SESSION_ID_INVALID, `invalid session id: ${sessionId}`);
  }
}

export function sessionScopeOf(handlerScope: string, sessionId: string): string {
  assertValidSessionId(sessionId);
  return `${handlerScope}/${sessionId}`;
}

export function sessionDirOf(homeDir: string, handlerScope: string, sessionId: string): string {
  // Native separators: the on-disk session dir is part of the byte-for-byte
  // v1 layout contract (session_index.jsonl / state.json readers compare it
  // with node:path-built paths). The scope strings above stay '/' -joined.
  assertValidSessionId(sessionId);
  return nativeJoin(homeDir, sessionScopeOf(handlerScope, sessionId));
}

export function agentScopeOf(sessionScope: string, agentId: string): string {
  return `${sessionScope}/agents/${agentId}`;
}
