import { ErrorCodes, KimiError, type KimiErrorCode } from '@moonshot-ai/agent-core';
import { ErrorCode } from '@moonshot-ai/protocol';

/** Map KAP integer codes back to SDK string KimiErrorCodes where a clear equivalent exists. */
const INTEGER_TO_KIMI_CODE: Partial<Record<number, KimiErrorCode>> = {
  [ErrorCode.SESSION_NOT_FOUND]: ErrorCodes.SESSION_NOT_FOUND,
  [ErrorCode.SESSION_BUSY]: ErrorCodes.TURN_AGENT_BUSY,
  [ErrorCode.COMPACTION_UNABLE]: ErrorCodes.COMPACTION_UNABLE,
  [ErrorCode.GOAL_ALREADY_EXISTS]: ErrorCodes.GOAL_ALREADY_EXISTS,
  [ErrorCode.GOAL_NOT_FOUND]: ErrorCodes.GOAL_NOT_FOUND,
  [ErrorCode.GOAL_STATUS_INVALID]: ErrorCodes.GOAL_STATUS_INVALID,
  [ErrorCode.GOAL_NOT_RESUMABLE]: ErrorCodes.GOAL_NOT_RESUMABLE,
  [ErrorCode.GOAL_OBJECTIVE_EMPTY]: ErrorCodes.GOAL_OBJECTIVE_EMPTY,
  [ErrorCode.GOAL_OBJECTIVE_TOO_LONG]: ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
  [ErrorCode.AUTH_PROVISIONING_REQUIRED]: ErrorCodes.AUTH_LOGIN_REQUIRED,
  [ErrorCode.AUTH_TOKEN_MISSING]: ErrorCodes.AUTH_LOGIN_REQUIRED,
  [ErrorCode.AUTH_TOKEN_UNAUTHORIZED]: ErrorCodes.AUTH_LOGIN_REQUIRED,
};

export function mapKapError(code: number, msg: string, details?: unknown): KimiError {
  const kimiCode = INTEGER_TO_KIMI_CODE[code] ?? ErrorCodes.INTERNAL;
  const detailRecord =
    typeof details === 'object' && details !== null && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : {};
  return new KimiError(kimiCode, msg, {
    details: { ...detailRecord, kapCode: code },
  });
}
