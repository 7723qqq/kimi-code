/**
 * The numeric wire error-code table carried in envelope `code` fields.
 *
 * Integer namespaces:
 *   - 0          success
 *   - 4xxxx      client errors (HTTP-4xx analog)
 *   - 5xxxx      server internal errors
 *   - 6xxxx      tool runtime
 *   - 7xxxx      LLM provider passthrough (msg = original upstream text)
 *   - 8xxxx      MCP server passthrough (msg = original upstream text)
 *   - 9xxxx      reserved
 *
 * Domain `KimiError` string codes are mapped onto these numbers at the
 * transport boundary (`transport/errors.ts`, route-level `sendMappedError`).
 */

export const ErrorCode = {
  /** Success. */
  SUCCESS: 0,

  /** Zod validation failed; `details` carries the field path list. */
  VALIDATION_FAILED: 40001,
  /** JSON parse failure or wrong field type. */
  REQUEST_MALFORMED: 40002,
  /** Provider is managed by OAuth-hosted login; deleting via REST is forbidden (use /oauth/logout). */
  PROVIDER_OAUTH_MANAGED: 40003,
  /** Catalog entry cannot be imported (rejected protocol / missing base_url / invalid base_url). */
  CATALOG_IMPORT_INVALID: 40004,
  /** Registry (api.json) cannot be imported (URL unreachable / document validation failed / no valid entries). */
  REGISTRY_IMPORT_INVALID: 40005,

  /** The daemon has no provider configuration. */
  AUTH_PROVISIONING_REQUIRED: 40110,
  /** Provider exists but token / api_key is missing. */
  AUTH_TOKEN_MISSING: 40111,
  /** Token refresh received 401 (the user revoked authorization). */
  AUTH_TOKEN_UNAUTHORIZED: 40112,
  /** The default / requested model resolves to no provider. */
  AUTH_MODEL_NOT_RESOLVED: 40113,

  /** session_id does not exist. */
  SESSION_NOT_FOUND: 40401,
  /** prompt_id does not exist. */
  PROMPT_NOT_FOUND: 40402,
  /** message_id does not exist. */
  MESSAGE_NOT_FOUND: 40403,
  /** approval_id does not exist. */
  APPROVAL_NOT_FOUND: 40404,
  /** question_id does not exist. */
  QUESTION_NOT_FOUND: 40405,
  /** task_id does not exist. */
  TASK_NOT_FOUND: 40406,
  /** file_id does not exist. */
  FILE_NOT_FOUND: 40407,
  /** mcp_server_id does not exist. */
  MCP_SERVER_NOT_FOUND: 40408,
  /** fs path does not exist. */
  FS_PATH_NOT_FOUND: 40409,
  /** workspace_id does not exist. */
  WORKSPACE_NOT_FOUND: 40410,
  /** The fs path exists but the current process lacks read permission. */
  FS_PERMISSION_DENIED: 40411,
  /** provider_id does not exist. */
  PROVIDER_NOT_FOUND: 40412,
  /** model_id does not exist. */
  MODEL_NOT_FOUND: 40413,
  /** terminal_id does not exist. */
  TERMINAL_NOT_FOUND: 40414,
  /** skill_name does not exist. */
  SKILL_NOT_FOUND: 40415,
  /** tool_call_id does not exist, or the call has no associated plan (not ExitPlanMode). */
  TOOL_CALL_NOT_FOUND: 40416,
  /** The entry does not exist in the catalog (models.dev catalog). */
  CATALOG_ENTRY_NOT_FOUND: 40417,
  /** capability_id does not exist. */
  CAPABILITY_NOT_FOUND: 40418,
  /** plugin_id does not exist. */
  PLUGIN_NOT_FOUND: 40419,

  /** The session has a prompt in progress; new requests are rejected. */
  SESSION_BUSY: 40901,
  /** The approval has already been answered by another client. */
  APPROVAL_ALREADY_RESOLVED: 40902,
  /** The prompt has ended (abort is idempotent and returns 0). */
  PROMPT_ALREADY_COMPLETED: 40903,
  /** The task has finished and cannot be cancelled. */
  TASK_ALREADY_FINISHED: 40904,
  /** mcp restart while already connecting/connected. */
  MCP_ALREADY_CONNECTED: 40905,
  /** fs.read requested a file, but the path is a directory. */
  FS_IS_DIRECTORY: 40906,
  /** fs.read requested utf-8, but the path is binary; the client should use `:download` instead. */
  FS_IS_BINARY: 40907,
  /** fs.git_status but session.cwd is not a git repo. */
  FS_GIT_UNAVAILABLE: 40908,
  /** The user pressed ESC / closed the panel to abandon the whole group (client calls `:dismiss`). */
  QUESTION_DISMISSED: 40909,
  /** The current history has no prefix that can be compacted. */
  COMPACTION_UNABLE: 40910,
  /** The current history lacks enough user prompts to undo. */
  SESSION_UNDO_UNAVAILABLE: 40911,
  /** The skill exists but its type does not support user activation (e.g. reference type). */
  SKILL_NOT_ACTIVATABLE: 40912,

  /** The current session already has an active goal. */
  GOAL_ALREADY_EXISTS: 40913,
  /** The goal does not exist. */
  GOAL_NOT_FOUND: 40914,
  /** The goal state does not allow this operation. */
  GOAL_STATUS_INVALID: 40915,
  /** The goal's current state is not resumable. */
  GOAL_NOT_RESUMABLE: 40916,
  /** The goal objective is empty. */
  GOAL_OBJECTIVE_EMPTY: 40917,
  /** The goal objective exceeds the length limit. */
  GOAL_OBJECTIVE_TOO_LONG: 40918,
  /** The fs.mkdir target path already exists (file or directory). */
  FS_ALREADY_EXISTS: 40919,
  /** Goals are only allowed for the main agent. */
  GOAL_UNSUPPORTED_AGENT: 40920,
  /** provider_id already exists at creation. */
  PROVIDER_ALREADY_EXISTS: 40921,
  /** page_token is corrupted / version mismatch / does not match the current query conditions; refetch from the first page. */
  PAGE_TOKEN_MISMATCH: 40922,
  /** Session title generation unavailable (flag off / no managed OAuth login / no prompt yet / backend failure). */
  SESSION_TITLE_UNAVAILABLE: 40923,
  /** The capability is being installed; concurrent installs are rejected. */
  CAPABILITY_INSTALL_IN_PROGRESS: 40924,
  /** The current platform/architecture does not support this capability. */
  CAPABILITY_UNSUPPORTED: 40925,

  /** Approval timed out after 60s. */
  APPROVAL_EXPIRED: 41001,
  /** Question timed out after 60s. */
  QUESTION_EXPIRED: 41002,
  /** The temporary file has expired. */
  FILE_EXPIRED: 41003,

  /** File too large (e.g. session export over the limit; /files uploads have no cap). */
  FILE_TOO_LARGE: 41301,
  /** fs.read exceeds 10MB. */
  FS_TOO_LARGE: 41302,
  /** fs.list / fs.search / fs.grep hits exceed the cap. */
  FS_TOO_MANY_RESULTS: 41303,
  /** The path escapes the session cwd boundary. */
  FS_PATH_ESCAPES_SESSION: 41304,
  /** fs.grep ran for >30s. */
  FS_GREP_TIMEOUT: 41305,

  /** WS single-connection watch_paths > 100. */
  FS_WATCH_LIMIT_EXCEEDED: 42902,

  /** Fallback. */
  INTERNAL_ERROR: 50001,
  /** Failed to write session persistence. */
  PERSISTENCE_FAILURE: 50003,
  /** Failed to fetch the models.dev catalog and no built-in snapshot is available as fallback. */
  CATALOG_UNAVAILABLE: 50004,

  /** Tool execution threw an error. */
  TOOL_EXECUTION_FAILED: 60001,
  /** The tool is not enabled in this session. */
  TOOL_NOT_AVAILABLE: 60002,

  /** provider.* — the provider's original code semantics are preserved; the `msg` field passes through the upstream error text. */
  /** mcp.* — the mcp server's original code semantics are preserved; the `msg` field passes through the upstream error text. */
} as const;

/**
 * Allocated outside the enum — the auth hook and its failure limiter use them
 * directly (not via `ErrorCode`):
 *   - 40101 auth.invalid_token        (global HTTP auth hook, `middleware/auth.ts`)
 *   - 42901 rate.limited              (auth failure limiter, `middleware/rateLimit.ts`)
 *
 * Reserved (intentionally unallocated; do NOT reuse for new variants):
 *   - 40102 auth.missing_token        (daemon's own token; future)
 *   - 40103 auth.forbidden_origin     (daemon's own token; future)
 *   - 50002 protocol.version_mismatch
 *
 * (`ErrorCodeReason` does not migrate with this table: the server side has no
 * consumers; the mapping from numeric codes to string reasons is still held by
 * the protocol package for the v1 chain and server-e2e.)
 */

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
