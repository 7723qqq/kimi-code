/**
 * Integer namespaces:
 *   - 0          success
 *   - 4xxxx      client errors (HTTP-4xx analog)
 *   - 5xxxx      daemon internal errors
 *   - 6xxxx      tool runtime
 *   - 7xxxx      LLM provider passthrough (msg = original upstream text)
 *   - 8xxxx      MCP server passthrough (msg = original upstream text)
 *   - 9xxxx      reserved
 */

export const ErrorCode = {
  /** Success */
  SUCCESS: 0,

  /** Zod validation failed; `details` contains the list of field paths */
  VALIDATION_FAILED: 40001,
  /** JSON parse failure or wrong field type */
  REQUEST_MALFORMED: 40002,

  /** The daemon has no provider configured */
  AUTH_PROVISIONING_REQUIRED: 40110,
  /** The provider exists but token / api_key is missing */
  AUTH_TOKEN_MISSING: 40111,
  /** Refreshing the token got a 401 (the user revoked authorization) */
  AUTH_TOKEN_UNAUTHORIZED: 40112,
  /** The default / requested model does not resolve to a provider */
  AUTH_MODEL_NOT_RESOLVED: 40113,

  /** session_id does not exist */
  SESSION_NOT_FOUND: 40401,
  /** prompt_id does not exist */
  PROMPT_NOT_FOUND: 40402,
  /** message_id does not exist */
  MESSAGE_NOT_FOUND: 40403,
  /** approval_id does not exist */
  APPROVAL_NOT_FOUND: 40404,
  /** question_id does not exist */
  QUESTION_NOT_FOUND: 40405,
  /** task_id does not exist */
  TASK_NOT_FOUND: 40406,
  /** file_id does not exist */
  FILE_NOT_FOUND: 40407,
  /** mcp_server_id does not exist */
  MCP_SERVER_NOT_FOUND: 40408,
  /** fs path does not exist */
  FS_PATH_NOT_FOUND: 40409,
  /** workspace_id does not exist */
  WORKSPACE_NOT_FOUND: 40410,
  /** The fs path exists but the current process has no permission to read it */
  FS_PERMISSION_DENIED: 40411,
  /** provider_id does not exist */
  PROVIDER_NOT_FOUND: 40412,
  /** model_id does not exist */
  MODEL_NOT_FOUND: 40413,
  /** terminal_id does not exist */
  TERMINAL_NOT_FOUND: 40414,
  /** skill_name does not exist */
  SKILL_NOT_FOUND: 40415,
  /** tool_call_id does not exist, or the call has no corresponding plan (not ExitPlanMode) */
  TOOL_CALL_NOT_FOUND: 40416,

  /** The session has an in-flight prompt; new requests are rejected */
  SESSION_BUSY: 40901,
  /** The approval has already been answered by another client */
  APPROVAL_ALREADY_RESOLVED: 40902,
  /** The prompt has already ended (abort is idempotent and returns 0) */
  PROMPT_ALREADY_COMPLETED: 40903,
  /** The task has finished and cannot be cancelled */
  TASK_ALREADY_FINISHED: 40904,
  /** mcp restart while already connecting/connected */
  MCP_ALREADY_CONNECTED: 40905,
  /** fs.read requested a file, but the path is a directory */
  FS_IS_DIRECTORY: 40906,
  /** fs.read requested utf-8, but the path is binary; the client should use `:download` instead */
  FS_IS_BINARY: 40907,
  /** fs.git_status called but session.cwd is not a git repo */
  FS_GIT_UNAVAILABLE: 40908,
  /** The user pressed ESC / closed the panel to dismiss the whole group (the client calls `:dismiss`) */
  QUESTION_DISMISSED: 40909,
  /** The current history has no prefix that can be compacted */
  COMPACTION_UNABLE: 40910,
  /** The current history does not have enough user prompts to undo */
  SESSION_UNDO_UNAVAILABLE: 40911,
  /** The skill exists but its type does not support user activation (e.g. reference type) */
  SKILL_NOT_ACTIVATABLE: 40912,

  /** The current session already has an active goal */
  GOAL_ALREADY_EXISTS: 40913,
  /** The goal does not exist */
  GOAL_NOT_FOUND: 40914,
  /** The goal state does not allow this operation */
  GOAL_STATUS_INVALID: 40915,
  /** The goal is not resumable in its current state */
  GOAL_NOT_RESUMABLE: 40916,
  /** The goal objective is empty */
  GOAL_OBJECTIVE_EMPTY: 40917,
  /** The goal objective exceeds the length limit */
  GOAL_OBJECTIVE_TOO_LONG: 40918,
  /** The fs.mkdir target path already exists (file or directory) */
  FS_ALREADY_EXISTS: 40919,
  /** The goal is only available to the main agent */
  GOAL_UNSUPPORTED_AGENT: 40920,

  /** The approval timed out after 60s */
  APPROVAL_EXPIRED: 41001,
  /** The question timed out after 60s */
  QUESTION_EXPIRED: 41002,
  /** The temporary file has expired */
  FILE_EXPIRED: 41003,

  /** The file is too large (e.g. session export over the limit; /files uploads have no cap) */
  FILE_TOO_LARGE: 41301,
  /** fs.read exceeds 10MB */
  FS_TOO_LARGE: 41302,
  /** fs.list / fs.search / fs.grep hit the result limit */
  FS_TOO_MANY_RESULTS: 41303,
  /** The path escapes the session cwd boundary */
  FS_PATH_ESCAPES_SESSION: 41304,
  /** fs.grep ran for >30s */
  FS_GREP_TIMEOUT: 41305,

  /** WS single-connection watch_paths > 100 */
  FS_WATCH_LIMIT_EXCEEDED: 42902,

  /** Fallback */
  INTERNAL_ERROR: 50001,
  /** Failed to write session persistence */
  PERSISTENCE_FAILURE: 50003,

  /** Tool execution threw an error */
  TOOL_EXECUTION_FAILED: 60001,
  /** The tool is not enabled in this session */
  TOOL_NOT_AVAILABLE: 60002,

  /** provider.* — the provider's original code meaning is preserved; the `msg` field passes through the upstream error text. */
  /** mcp.* — the mcp server's original code meaning is preserved; the `msg` field passes through the upstream error text. */
} as const;

/**
 * Reserved (intentionally unallocated; do NOT reuse for new variants):
 *   - 40101 auth.invalid_token        (daemon's own token; future)
 *   - 40102 auth.missing_token        (daemon's own token; future)
 *   - 40103 auth.forbidden_origin     (daemon's own token; future)
 *   - 42901 rate.limited
 *   - 50002 protocol.version_mismatch
 */

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ErrorCodeReason: Readonly<Record<ErrorCode, string>> = {
  [ErrorCode.SUCCESS]: 'success',

  [ErrorCode.VALIDATION_FAILED]: 'validation.failed',
  [ErrorCode.REQUEST_MALFORMED]: 'request.malformed',

  [ErrorCode.AUTH_PROVISIONING_REQUIRED]: 'auth.provisioning_required',
  [ErrorCode.AUTH_TOKEN_MISSING]: 'auth.token_missing',
  [ErrorCode.AUTH_TOKEN_UNAUTHORIZED]: 'auth.token_unauthorized',
  [ErrorCode.AUTH_MODEL_NOT_RESOLVED]: 'auth.model_not_resolved',

  [ErrorCode.SESSION_NOT_FOUND]: 'session.not_found',
  [ErrorCode.PROMPT_NOT_FOUND]: 'prompt.not_found',
  [ErrorCode.MESSAGE_NOT_FOUND]: 'message.not_found',
  [ErrorCode.APPROVAL_NOT_FOUND]: 'approval.not_found',
  [ErrorCode.QUESTION_NOT_FOUND]: 'question.not_found',
  [ErrorCode.TASK_NOT_FOUND]: 'task.not_found',
  [ErrorCode.FILE_NOT_FOUND]: 'file.not_found',
  [ErrorCode.MCP_SERVER_NOT_FOUND]: 'mcp.server_not_found',
  [ErrorCode.FS_PATH_NOT_FOUND]: 'fs.path_not_found',
  [ErrorCode.WORKSPACE_NOT_FOUND]: 'workspace.not_found',
  [ErrorCode.FS_PERMISSION_DENIED]: 'fs.permission_denied',
  [ErrorCode.PROVIDER_NOT_FOUND]: 'provider.not_found',
  [ErrorCode.MODEL_NOT_FOUND]: 'model.not_found',
  [ErrorCode.TERMINAL_NOT_FOUND]: 'terminal.not_found',
  [ErrorCode.SKILL_NOT_FOUND]: 'skill.not_found',
  [ErrorCode.TOOL_CALL_NOT_FOUND]: 'tool_call.not_found',

  [ErrorCode.SESSION_BUSY]: 'session.busy',
  [ErrorCode.APPROVAL_ALREADY_RESOLVED]: 'approval.already_resolved',
  [ErrorCode.PROMPT_ALREADY_COMPLETED]: 'prompt.already_completed',
  [ErrorCode.TASK_ALREADY_FINISHED]: 'task.already_finished',
  [ErrorCode.MCP_ALREADY_CONNECTED]: 'mcp.already_connected',
  [ErrorCode.FS_IS_DIRECTORY]: 'fs.is_directory',
  [ErrorCode.FS_IS_BINARY]: 'fs.is_binary',
  [ErrorCode.FS_GIT_UNAVAILABLE]: 'fs.git_unavailable',
  [ErrorCode.QUESTION_DISMISSED]: 'question.dismissed',
  [ErrorCode.COMPACTION_UNABLE]: 'compaction.unable',
  [ErrorCode.SESSION_UNDO_UNAVAILABLE]: 'session.undo_unavailable',
  [ErrorCode.SKILL_NOT_ACTIVATABLE]: 'skill.not_activatable',

  [ErrorCode.GOAL_ALREADY_EXISTS]: 'goal.already_exists',
  [ErrorCode.GOAL_NOT_FOUND]: 'goal.not_found',
  [ErrorCode.GOAL_STATUS_INVALID]: 'goal.status_invalid',
  [ErrorCode.GOAL_NOT_RESUMABLE]: 'goal.not_resumable',
  [ErrorCode.GOAL_OBJECTIVE_EMPTY]: 'goal.objective_empty',
  [ErrorCode.GOAL_OBJECTIVE_TOO_LONG]: 'goal.objective_too_long',
  [ErrorCode.FS_ALREADY_EXISTS]: 'fs.already_exists',
  [ErrorCode.GOAL_UNSUPPORTED_AGENT]: 'goal.unsupported_agent',

  [ErrorCode.APPROVAL_EXPIRED]: 'approval.expired',
  [ErrorCode.QUESTION_EXPIRED]: 'question.expired',
  [ErrorCode.FILE_EXPIRED]: 'file.expired',

  [ErrorCode.FILE_TOO_LARGE]: 'file.too_large',
  [ErrorCode.FS_TOO_LARGE]: 'fs.too_large',
  [ErrorCode.FS_TOO_MANY_RESULTS]: 'fs.too_many_results',
  [ErrorCode.FS_PATH_ESCAPES_SESSION]: 'fs.path_escapes_session',
  [ErrorCode.FS_GREP_TIMEOUT]: 'fs.grep_timeout',

  [ErrorCode.FS_WATCH_LIMIT_EXCEEDED]: 'fs.watch_limit_exceeded',

  [ErrorCode.INTERNAL_ERROR]: 'internal.error',
  [ErrorCode.PERSISTENCE_FAILURE]: 'persistence.failure',

  [ErrorCode.TOOL_EXECUTION_FAILED]: 'tool.execution_failed',
  [ErrorCode.TOOL_NOT_AVAILABLE]: 'tool.not_available',
};
