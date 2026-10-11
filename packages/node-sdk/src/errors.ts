import {
  APIConnectionError,
  APIEmptyResponseError,
  APIProviderQuotaExhaustedError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
} from '@moonshot-ai/kosong';

/**
 * Error codes for Kimi Core's public error protocol.
 *
 * `ErrorCodes` is the source of truth for every code Kimi Core may emit.
 * Downstream consumers (SDK, RPC clients, telemetry, agent-facing docs)
 * should depend on these string values rather than on class identity.
 *
 * Codes follow `domain.reason`. Adding a code is a minor change; renaming
 * or removing one is a major change.
 */
export const ErrorCodes = {
  CONFIG_INVALID: 'config.invalid',

  SESSION_NOT_FOUND: 'session.not_found',
  SESSION_ALREADY_EXISTS: 'session.already_exists',
  SESSION_ID_INVALID: 'session.id_invalid',
  SESSION_ID_REQUIRED: 'session.id_required',
  SESSION_ID_EMPTY: 'session.id_empty',
  SESSION_TITLE_EMPTY: 'session.title_empty',
  SESSION_STATE_NOT_FOUND: 'session.state_not_found',
  SESSION_STATE_INVALID: 'session.state_invalid',
  SESSION_FORK_ACTIVE_TURN: 'session.fork_active_turn',
  SESSION_EXPORT_NOT_FOUND: 'session.export_not_found',
  SESSION_EXPORT_MISSING_VERSION: 'session.export_missing_version',
  SESSION_CLOSED: 'session.closed',
  SESSION_PERMISSION_MODE_INVALID: 'session.permission_mode_invalid',
  SESSION_THINKING_EMPTY: 'session.thinking_empty',
  SESSION_MODEL_EMPTY: 'session.model_empty',
  SESSION_PLAN_MODE_INVALID: 'session.plan_mode_invalid',
  SESSION_APPROVAL_HANDLER_ERROR: 'session.approval_handler_error',
  SESSION_QUESTION_HANDLER_ERROR: 'session.question_handler_error',
  SESSION_INIT_FAILED: 'session.init_failed',

  AGENT_NOT_FOUND: 'agent.not_found',
  TURN_AGENT_BUSY: 'turn.agent_busy',

  GOAL_ALREADY_EXISTS: 'goal.already_exists',
  GOAL_NOT_FOUND: 'goal.not_found',
  GOAL_OBJECTIVE_EMPTY: 'goal.objective_empty',
  GOAL_OBJECTIVE_TOO_LONG: 'goal.objective_too_long',
  GOAL_STATUS_INVALID: 'goal.status_invalid',
  GOAL_METADATA_RESERVED: 'goal.metadata_reserved',
  GOAL_NOT_RESUMABLE: 'goal.not_resumable',

  MODEL_NOT_CONFIGURED: 'model.not_configured',
  MODEL_CONFIG_INVALID: 'model.config_invalid',
  AUTH_LOGIN_REQUIRED: 'auth.login_required',

  CONTEXT_OVERFLOW: 'context.overflow',
  LOOP_MAX_STEPS_EXCEEDED: 'loop.max_steps_exceeded',
  PROVIDER_API_ERROR: 'provider.api_error',
  PROVIDER_FILTERED: 'provider.filtered',
  PROVIDER_RATE_LIMIT: 'provider.rate_limit',
  PROVIDER_AUTH_ERROR: 'provider.auth_error',
  PROVIDER_CONNECTION_ERROR: 'provider.connection_error',

  SKILL_NOT_FOUND: 'skill.not_found',
  SKILL_TYPE_UNSUPPORTED: 'skill.type_unsupported',
  SKILL_NAME_EMPTY: 'skill.name_empty',

  RECORDS_WRITE_FAILED: 'records.write_failed',
  COMPACTION_FAILED: 'compaction.failed',
  COMPACTION_UNABLE: 'compaction.unable',

  BACKGROUND_TASK_ID_EMPTY: 'task.task_id_empty',
  MCP_SERVER_NOT_FOUND: 'mcp.server_not_found',
  MCP_SERVER_DISABLED: 'mcp.server_disabled',
  MCP_STARTUP_FAILED: 'mcp.startup_failed',
  MCP_TOOL_NAME_COLLISION: 'mcp.tool_name_collision',
  MCP_OAUTH_FAILED: 'mcp.oauth_failed',

  PLUGIN_NOT_FOUND: 'plugin.not_found',
  PLUGIN_LOAD_FAILED: 'plugin.load_failed',

  REQUEST_INVALID: 'request.invalid',
  REQUEST_WORK_DIR_REQUIRED: 'request.work_dir_required',
  REQUEST_PROMPT_INPUT_EMPTY: 'request.prompt_input_empty',

  SHELL_GIT_BASH_NOT_FOUND: 'shell.git_bash_not_found',

  // --- engine registry mirror ---
  AGENT_ALREADY_EXISTS: 'agent.already_exists',
  AGENT_ALREADY_RUNNING: 'agent.already_running',
  AGENT_MAX_TOKENS_EXCEEDED: 'agent.max_tokens_exceeded',
  AGENT_NO_FINAL_MESSAGE: 'agent.no_final_message',
  AGENT_NOT_A_SUBAGENT: 'agent.not_a_subagent',
  AGENT_NOT_OWNED: 'agent.not_owned',
  SUBAGENT_DEPTH_EXCEEDED: 'agent.subagent_depth_exceeded',
  AGENT_TYPE_NOT_ALLOWED: 'agent.type_not_allowed',
  ATTACHMENT_IMAGE_TOO_LARGE: 'attachment.image_too_large',
  ATTACHMENT_IMAGE_TOO_MANY_PIXELS: 'attachment.image_too_many_pixels',
  ATTACHMENT_IMAGE_TYPE_MISMATCH: 'attachment.image_type_mismatch',
  ATTACHMENT_INVALID_IMAGE: 'attachment.invalid_image',
  ATTACHMENT_INVALID_REF: 'attachment.invalid_ref',
  AUTH_MODEL_NOT_RESOLVED: 'auth.model_not_resolved',
  AUTH_PROVISIONING_REQUIRED: 'auth.provisioning_required',
  AUTH_TOKEN_MISSING: 'auth.token_missing',
  AUTH_TOKEN_UNAUTHORIZED: 'auth.token_unauthorized',
  CAPABILITY_INSTALL_IN_PROGRESS: 'capability.install_in_progress',
  CAPABILITY_NOT_FOUND: 'capability.not_found',
  CAPABILITY_UNSUPPORTED: 'capability.unsupported',
  CONFIG_PERSIST_BLOCKED: 'config.persist_blocked',
  CRON_EXPRESSION_INVALID: 'cron.expression_invalid',
  DEBUG_SCOPE_NOT_FOUND: 'debug.scope_not_found',
  DEBUG_TOKEN_NOT_FOUND: 'debug.token_not_found',
  EVENT_DUPLICATE_EVENT: 'event.duplicate_event',
  EVENT_SCHEMA_MISSING: 'event.schema_missing',
  FILE_NOT_FOUND: 'file.not_found',
  FILE_TOO_LARGE: 'file.too_large',
  FS_ALREADY_EXISTS: 'fs.already_exists',
  FS_GIT_UNAVAILABLE: 'fs.git_unavailable',
  FS_GREP_TIMEOUT: 'fs.grep_timeout',
  FS_IS_BINARY: 'fs.is_binary',
  FS_IS_DIRECTORY: 'fs.is_directory',
  FS_PATH_ESCAPES: 'fs.path_escapes',
  FS_PATH_NOT_FOUND: 'fs.path_not_found',
  FS_PERMISSION_DENIED: 'fs.permission_denied',
  FS_TOO_LARGE: 'fs.too_large',
  FS_TOO_MANY_RESULTS: 'fs.too_many_results',
  GOAL_UNSUPPORTED_AGENT: 'goal.unsupported_agent',
  LSP_CONFLICT: 'lsp.conflict',
  LSP_MALFORMED_RESPONSE: 'lsp.malformed_response',
  LSP_SERVER_FAILED: 'lsp.server_failed',
  LSP_UNAVAILABLE: 'lsp.unavailable',
  LSP_UNSUPPORTED_OPERATION: 'lsp.unsupported_operation',
  LSP_WORKSPACE_REQUIRED: 'lsp.workspace_required',
  MESSAGE_NOT_FOUND: 'message.not_found',
  MODEL_NOT_FOUND: 'model.not_found',
  CATALOG_ENTRY_NOT_FOUND: 'modelsDev.catalog_entry_not_found',
  CATALOG_UNAVAILABLE: 'modelsDev.catalog_unavailable',
  CATALOG_IMPORT_INVALID: 'modelsDev.import_invalid',
  REGISTRY_IMPORT_INVALID: 'modelsDev.registry_import_invalid',
  OS_FS_ALREADY_EXISTS: 'os.fs.already_exists',
  OS_FS_IS_DIRECTORY: 'os.fs.is_directory',
  OS_FS_NOT_DIRECTORY: 'os.fs.not_directory',
  OS_FS_NOT_EMPTY: 'os.fs.not_empty',
  OS_FS_NOT_FOUND: 'os.fs.not_found',
  OS_FS_PERMISSION_DENIED: 'os.fs.permission_denied',
  OS_FS_UNAVAILABLE: 'os.fs.unavailable',
  OS_FS_UNKNOWN: 'os.fs.unknown',
  OS_PROCESS_KILL_FAILED: 'os.process.kill_failed',
  OS_PROCESS_SPAWN_FAILED: 'os.process.spawn_failed',
  PROFILE_ALREADY_BOUND: 'profile.already_bound',
  PROFILE_NOT_BOUND: 'profile.not_bound',
  THINKING_ALIAS_CONFLICT: 'profile.thinking_alias_conflict',
  PROFILE_UNKNOWN: 'profile.unknown',
  PROMPT_ID_CONFLICT: 'prompt.id_conflict',
  PROMPT_NOT_FOUND: 'prompt.not_found',
  PROMPT_OPTIMIZER_BUSY: 'prompt_optimizer.busy',
  PROMPT_OPTIMIZER_DISABLED: 'prompt_optimizer.disabled',
  PROMPT_OPTIMIZER_EMPTY_DRAFT: 'prompt_optimizer.empty_draft',
  PROMPT_OPTIMIZER_NO_OUTPUT: 'prompt_optimizer.no_output',
  PROMPT_OPTIMIZER_OUTPUT_TOO_LONG: 'prompt_optimizer.output_too_long',
  PROVIDER_NOT_FOUND: 'provider.not_found',
  PROVIDER_OAUTH_MANAGED: 'provider.oauth_managed',
  PROVIDER_OVERLOADED: 'provider.overloaded',
  SESSION_BUSY: 'session.busy',
  SESSION_EXPORT_OUTPUT_CONFLICT: 'session.export_output_conflict',
  SESSION_EXPORT_TOO_LARGE: 'session.export_too_large',
  SESSION_TOWER_MODE_INVALID: 'session.tower_mode_invalid',
  SESSION_UNDO_UNAVAILABLE: 'session.undo_unavailable',
  SESSION_QUERY_INDEX_UNAVAILABLE: 'session_query.index_unavailable',
  SESSION_QUERY_INVALID_FILTER: 'session_query.invalid_filter',
  SESSION_QUERY_SESSION_NOT_FOUND: 'session_query.session_not_found',
  SKILL_NESTED_TOO_DEEP: 'skill.nested_too_deep',
  SKILL_PARSE_FAILED: 'skill.parse_failed',
  SPEC_INCOMPLETE: 'spec.incomplete',
  SPEC_MODE_INVALID: 'spec.mode_invalid',
  SPEC_WRITE_DENIED: 'spec.write_denied',
  STATE_CYCLE: 'state.cycle',
  STATE_DUPLICATE_FOLD: 'state.duplicate_fold',
  STATE_DURABILITY_MISMATCH: 'state.durability_mismatch',
  STORAGE_CORRUPTED: 'storage.corrupted',
  STORAGE_DECODE_FAILED: 'storage.decode_failed',
  STORAGE_DISK_FULL: 'storage.disk_full',
  STORAGE_IO_FAILED: 'storage.io_failed',
  STORAGE_LOCKED: 'storage.locked',
  STORAGE_NOT_FOUND: 'storage.not_found',
  STORAGE_PERMISSION_DENIED: 'storage.permission_denied',
  TASK_LIMIT_EXCEEDED: 'task.limit_exceeded',
  TERMINAL_NOT_FOUND: 'terminal.not_found',
  TURN_ID_CONFLICT: 'usage.turn_id_conflict',
  VALIDATION_FAILED: 'validation.failed',
  WEB_FETCH_FAILED: 'web.fetch_failed',
  WEB_INVALID_URL: 'web.invalid_url',
  WEB_PRIVATE_ADDRESS: 'web.private_address',
  WIRE_CYCLE: 'wire.cycle',
  WIRE_DUPLICATE_OP: 'wire.duplicate_op',
  WIRE_MIGRATION_MISSING: 'wire.migration_missing',
  WIRE_UNKNOWN_RECORD: 'wire.unknown_record',
  WORKSPACE_NOT_FOUND: 'workspace.not_found',
  NOT_IMPLEMENTED: 'not_implemented',
  INTERNAL: 'internal',
} as const;

export type KimiErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface KimiErrorInfo {
  readonly title: string;
  readonly retryable: boolean;
  /**
   * Whether the code is a stable public contract. `false` reserves the
   * right to rename or remove without a major version bump.
   */
  readonly public: boolean;
  readonly action?: string;
}

export const KIMI_ERROR_INFO = {
  'config.invalid': {
    title: 'Invalid configuration',
    retryable: false,
    public: true,
    action: 'Check config.toml and provider/model settings.',
  },

  'session.not_found': {
    title: 'Session not found',
    retryable: false,
    public: true,
    action: 'Check the session id or list available sessions.',
  },
  'session.already_exists': {
    title: 'Session already exists',
    retryable: false,
    public: true,
    action: 'Use a different session id or remove the existing session first.',
  },
  'session.id_invalid': {
    title: 'Invalid session id',
    retryable: false,
    public: true,
    action: 'Use a session id without path-traversal characters.',
  },
  'session.id_required': {
    title: 'Session id required',
    retryable: false,
    public: true,
    action: 'Provide a session id when calling this method.',
  },
  'session.id_empty': {
    title: 'Session id is empty',
    retryable: false,
    public: true,
    action: 'Provide a non-empty session id.',
  },
  'session.title_empty': {
    title: 'Session title is empty',
    retryable: false,
    public: true,
    action: 'Provide a non-empty session title.',
  },
  'session.state_not_found': {
    title: 'Session state missing',
    retryable: false,
    public: true,
    action: 'The session directory is corrupted or missing state.json.',
  },
  'session.state_invalid': {
    title: 'Session state invalid',
    retryable: false,
    public: true,
    action: 'The session state.json is corrupted; remove the session or repair the file.',
  },
  'session.fork_active_turn': {
    title: 'Cannot fork session during active turn',
    retryable: true,
    public: true,
    action: 'Wait for the active turn to complete before forking.',
  },
  'session.export_not_found': {
    title: 'Session export directory missing',
    retryable: false,
    public: true,
    action: 'The session has not been persisted to disk yet.',
  },
  'session.export_missing_version': {
    title: 'Export version is missing',
    retryable: false,
    public: true,
    action: 'Provide a version when exporting the session.',
  },
  'session.closed': {
    title: 'Session is closed',
    retryable: false,
    public: true,
    action: 'Create a new session.',
  },
  'session.permission_mode_invalid': {
    title: 'Invalid permission mode',
    retryable: false,
    public: true,
    action: 'Use one of: yolo / manual / auto.',
  },
  'session.thinking_empty': {
    title: 'Thinking value is empty',
    retryable: false,
    public: true,
    action: 'Provide a non-empty thinking option.',
  },
  'session.model_empty': {
    title: 'Model is empty',
    retryable: false,
    public: true,
    action: 'Provide a non-empty model identifier.',
  },
  'session.plan_mode_invalid': {
    title: 'Invalid plan mode',
    retryable: false,
    public: true,
    action: 'Provide a boolean plan mode.',
  },
  'session.approval_handler_error': {
    title: 'Approval handler threw',
    retryable: false,
    public: true,
    action: 'Inspect the SDK approval handler for an unhandled exception.',
  },
  'session.question_handler_error': {
    title: 'Question handler threw',
    retryable: false,
    public: true,
    action: 'Inspect the SDK question handler for an unhandled exception.',
  },
  'session.init_failed': {
    title: 'Session init failed',
    retryable: false,
    public: false,
    action: 'Review the init failure details and try again.',
  },

  'agent.not_found': {
    title: 'Agent not found',
    retryable: false,
    public: true,
    action: 'Check the agent id or list available agents.',
  },
  'turn.agent_busy': {
    title: 'Agent is busy',
    retryable: true,
    public: true,
    action: 'Wait for the current turn to finish or steer it.',
  },

  'goal.already_exists': {
    title: 'A goal is already active',
    retryable: false,
    public: true,
    action: 'Use `/goal replace <objective>` to replace the current goal.',
  },
  'goal.not_found': {
    title: 'No goal found',
    retryable: false,
    public: true,
    action: 'Start a goal with `/goal <objective>` first.',
  },
  'goal.objective_empty': {
    title: 'Goal objective is empty',
    retryable: false,
    public: true,
    action: 'Provide a non-empty objective.',
  },
  'goal.objective_too_long': {
    title: 'Goal objective is too long',
    retryable: false,
    public: true,
    action: 'Keep the objective under 4000 characters; reference long details by file path.',
  },
  'goal.status_invalid': {
    title: 'Invalid goal status transition',
    retryable: false,
    public: true,
    action: 'Use a status allowed for this actor (complete, blocked, or impossible).',
  },
  'goal.metadata_reserved': {
    title: 'Goal metadata is reserved',
    retryable: false,
    public: true,
    action: 'Do not write metadata.custom.goal directly; use the goal lifecycle methods.',
  },
  'goal.not_resumable': {
    title: 'Goal is not resumable',
    retryable: false,
    public: true,
    action: 'Only paused goals can be resumed.',
  },

  'model.not_configured': {
    title: 'No model configured',
    retryable: false,
    public: true,
    action: 'Set a default model in config.toml or via setModel.',
  },
  'model.config_invalid': {
    title: 'Invalid model configuration',
    retryable: false,
    public: true,
    action: 'Check the model and provider entries in config.toml.',
  },
  'auth.login_required': {
    title: 'Login required',
    retryable: false,
    public: true,
    action: 'Run the login flow for the provider before retrying.',
  },

  'context.overflow': {
    title: 'Context window overflow',
    retryable: true,
    public: true,
    action: 'Compact the conversation or start a new session.',
  },
  'loop.max_steps_exceeded': {
    title: 'Turn exceeded max steps',
    retryable: false,
    public: true,
    action: 'Increase loop_control.max_steps_per_turn in config.toml or split the task.',
  },
  'provider.api_error': {
    title: 'Provider API error',
    retryable: false,
    public: true,
    action: 'Inspect details.statusCode / details.requestId; check provider status.',
  },
  'provider.filtered': {
    title: 'Provider filtered response',
    retryable: false,
    public: true,
    action: 'Revise the prompt or model configuration to avoid provider safety filtering.',
  },
  'provider.rate_limit': {
    title: 'Provider rate limit',
    retryable: true,
    public: true,
    action: 'Retry after a delay or reduce request frequency.',
  },
  'provider.auth_error': {
    title: 'Provider authentication error',
    retryable: false,
    public: true,
    action: 'Re-authenticate with the provider.',
  },
  'provider.connection_error': {
    title: 'Provider connection error',
    retryable: true,
    public: true,
    action: 'Check network connectivity and retry.',
  },

  'skill.not_found': {
    title: 'Skill not found',
    retryable: false,
    public: true,
    action: 'List available skills via the skill registry.',
  },
  'skill.type_unsupported': {
    title: 'Skill type not supported',
    retryable: false,
    public: true,
    action: 'Only inline skills can be activated by the user.',
  },
  'skill.name_empty': {
    title: 'Skill name is empty',
    retryable: false,
    public: true,
    action: 'Provide a non-empty skill name.',
  },

  'records.write_failed': {
    title: 'Failed to write records',
    retryable: true,
    public: true,
    action: 'Check disk space and permissions on the session directory.',
  },
  'compaction.failed': {
    title: 'Compaction failed',
    retryable: false,
    public: true,
    action: 'Inspect logs and consider increasing compaction limits.',
  },
  'compaction.unable': {
    title: 'Unable to compact',
    retryable: false,
    public: true,
    action:
      'The current history has no prefix that can be compacted (e.g. only a pending user message). Start a new turn or session instead.',
  },

  'task.task_id_empty': {
    title: 'Background task id is empty',
    retryable: false,
    public: true,
    action: 'Provide a non-empty task id.',
  },
  'mcp.server_not_found': {
    title: 'MCP server not found',
    retryable: false,
    public: true,
    action: 'List configured MCP servers and check the requested name.',
  },
  'mcp.server_disabled': {
    title: 'MCP server is disabled',
    retryable: false,
    public: true,
    action: 'Enable the MCP server entry in config before reconnecting.',
  },
  'mcp.startup_failed': {
    title: 'MCP server startup failed',
    retryable: true,
    public: true,
    action: 'Inspect the MCP server log or call reconnect once the server is healthy.',
  },
  'mcp.tool_name_collision': {
    title: 'MCP tool name collision',
    retryable: false,
    public: true,
    action: 'Rename one of the colliding MCP tools or servers so their qualified names are unique.',
  },
  'mcp.oauth_failed': {
    title: 'MCP OAuth authorization failed',
    retryable: true,
    public: true,
    action: 'Begin the authorization flow again; inspect the error details if it keeps failing.',
  },

  'plugin.not_found': {
    title: 'Plugin not found',
    retryable: false,
    public: true,
    action: 'List installed plugins via /plugins and check the requested id.',
  },
  'plugin.load_failed': {
    title: 'Plugin state failed to load',
    retryable: true,
    public: true,
    action: 'Fix the installed.json file under $KIMI_CODE_HOME/plugins/ and run /plugins reload.',
  },

  'request.invalid': {
    title: 'Invalid request',
    retryable: false,
    public: true,
    action: 'Check the input shape matches the API contract.',
  },
  'request.work_dir_required': {
    title: 'workDir is required',
    retryable: false,
    public: true,
    action: 'Provide workDir in the request payload.',
  },
  'request.prompt_input_empty': {
    title: 'Prompt input is empty',
    retryable: false,
    public: true,
    action: 'Provide non-empty prompt input.',
  },

  'shell.git_bash_not_found': {
    title: 'Git Bash not found',
    retryable: false,
    public: true,
    action:
      'Install Git for Windows from https://gitforwindows.org/ or set KIMI_SHELL_PATH to a bash.exe.',
  },

  'agent.already_exists': {
    title: 'Agent already exists',
    retryable: false,
    public: true,
    action: 'Use a different agent id or remove the existing agent first.',
  },
  'agent.already_running': {
    title: 'Agent is already running',
    retryable: false,
    public: true,
    action: 'Wait for the current turn to finish or cancel it before starting another.',
  },
  'agent.max_tokens_exceeded': {
    title: 'Agent token budget exceeded',
    retryable: false,
    public: true,
    action: 'Raise the agent token budget or compact the conversation.',
  },
  'agent.no_final_message': {
    title: 'Agent produced no final message',
    retryable: false,
    public: true,
    action: 'Retry the turn; the agent ended without a final assistant message.',
  },
  'agent.not_a_subagent': {
    title: 'Agent is not a subagent',
    retryable: false,
    public: true,
    action: 'Run this operation on a subagent, not the main agent.',
  },
  'agent.not_owned': {
    title: 'Agent is not owned by this session',
    retryable: false,
    public: true,
    action: 'Address the agent through the session that created it.',
  },
  'agent.subagent_depth_exceeded': {
    title: 'Subagent nesting too deep',
    retryable: false,
    public: true,
    action: 'Raise the delegation depth limit or flatten the subagent tree.',
  },
  'agent.type_not_allowed': {
    title: 'Agent type not allowed',
    retryable: false,
    public: true,
    action: 'Choose an agent type permitted in this context.',
  },
  'attachment.image_too_large': {
    title: 'Image too large',
    retryable: false,
    public: true,
    action: 'Attach a smaller image or raise the configured attachment byte limit.',
  },
  'attachment.image_too_many_pixels': {
    title: 'Image has too many pixels',
    retryable: false,
    public: true,
    action: 'Downscale the image before attaching it or raise the configured pixel limit.',
  },
  'attachment.image_type_mismatch': {
    title: 'Image type mismatch',
    retryable: false,
    public: true,
    action: 'The declared media type does not match the file bytes; re-attach the image.',
  },
  'attachment.invalid_image': {
    title: 'Invalid image attachment',
    retryable: false,
    public: true,
    action: 'Attach a supported, non-empty image file.',
  },
  'attachment.invalid_ref': {
    title: 'Invalid attachment reference',
    retryable: false,
    public: true,
    action: 'The attachment id is unknown or was removed; attach the file again.',
  },
  'auth.model_not_resolved': {
    title: 'Model not resolved',
    retryable: false,
    public: true,
    action: 'Set a default model or configure the requested model alias.',
  },
  'auth.provisioning_required': {
    title: 'Provider provisioning required',
    retryable: false,
    public: true,
    action: 'Configure a provider via /login or the providers endpoint.',
  },
  'auth.token_missing': {
    title: 'Provider credential missing',
    retryable: false,
    public: true,
    action: 'Configure an API key or complete OAuth login for the provider.',
  },
  'auth.token_unauthorized': {
    title: 'Provider credential unauthorized',
    retryable: false,
    public: true,
    action: 'Re-authenticate with the OAuth provider.',
  },
  'capability.install_in_progress': {
    title: 'Capability install already in progress',
    retryable: false,
    public: true,
    action: 'Wait for the running installation to finish.',
  },
  'capability.not_found': {
    title: 'Capability not found',
    retryable: false,
    public: true,
    action: 'Check the capability id against the listed catalog.',
  },
  'capability.unsupported': {
    title: 'Capability unsupported',
    retryable: false,
    public: true,
    action: 'The current host or runtime cannot provide this capability.',
  },
  'config.persist_blocked': {
    title: 'Configuration change blocked',
    retryable: false,
    public: true,
    action: 'Resolve the conflicting write before persisting configuration.',
  },
  'cron.expression_invalid': {
    title: 'Invalid cron expression',
    retryable: false,
    public: true,
    action: 'Provide a valid 5-field cron expression.',
  },
  'debug.scope_not_found': {
    title: 'Debug scope not found',
    retryable: false,
    public: true,
    action: 'Check the scope name against the debug channel listing.',
  },
  'debug.token_not_found': {
    title: 'Debug token not found',
    retryable: false,
    public: true,
    action: 'Check the token id or list the registered debug tokens.',
  },
  'event.duplicate_event': {
    title: 'Duplicate event type',
    retryable: false,
    public: true,
    action: 'Two event classes registered the same type; rename one. This is a build-time bug.',
  },
  'event.schema_missing': {
    title: 'Durable event without schema',
    retryable: false,
    public: true,
    action: 'A durable event class must declare a zod payload schema for replay.',
  },
  'file.not_found': {
    title: 'File not found',
    retryable: false,
    public: true,
    action: 'Check the file_id or upload the file again.',
  },
  'file.too_large': {
    title: 'File too large',
    retryable: false,
    public: true,
    action: 'Upload a smaller file or split it into parts.',
  },
  'fs.already_exists': {
    title: 'Path already exists',
    retryable: false,
    public: true,
    action: 'Choose another target path or remove the existing entry.',
  },
  'fs.git_unavailable': {
    title: 'Git is unavailable',
    retryable: false,
    public: true,
    action: 'Install Git or run the command outside a repository.',
  },
  'fs.grep_timeout': {
    title: 'Search timed out',
    retryable: false,
    public: true,
    action: 'Narrow the search pattern or scope it to fewer files.',
  },
  'fs.is_binary': {
    title: 'Path is a binary file',
    retryable: false,
    public: true,
    action: 'Read the file with the appropriate binary-aware tool.',
  },
  'fs.is_directory': {
    title: 'Path is a directory',
    retryable: false,
    public: true,
    action: 'Pass a file path, or list the directory instead.',
  },
  'fs.path_escapes': {
    title: 'Path escapes the workspace',
    retryable: false,
    public: true,
    action: 'Restrict the path to the workspace root.',
  },
  'fs.path_not_found': {
    title: 'Path not found',
    retryable: false,
    public: true,
    action: 'Check the path spelling and that it exists.',
  },
  'fs.permission_denied': {
    title: 'Permission denied',
    retryable: false,
    public: true,
    action: 'Grant read/write access to the target path.',
  },
  'fs.too_large': {
    title: 'File too large',
    retryable: false,
    public: true,
    action: 'Process a smaller file or read it in ranges.',
  },
  'fs.too_many_results': {
    title: 'Too many results',
    retryable: false,
    public: true,
    action: 'Narrow the query or raise the result limit.',
  },
  'goal.unsupported_agent': {
    title: 'Goals are unavailable for subagents',
    retryable: false,
    public: true,
    action: 'Run goal lifecycle commands on the main agent.',
  },
  'lsp.conflict': {
    title: 'Language server conflict',
    retryable: false,
    public: true,
    action: 'Wait for the running LSP request to finish or restart the server.',
  },
  'lsp.malformed_response': {
    title: 'Malformed LSP response',
    retryable: false,
    public: true,
    action: 'The language server returned an invalid payload; restart it.',
  },
  'lsp.server_failed': {
    title: 'Language server failed',
    retryable: true,
    public: true,
    action: 'Restart the language server for this workspace.',
  },
  'lsp.unavailable': {
    title: 'Language server unavailable',
    retryable: false,
    public: true,
    action: 'Install or start a language server for this file type.',
  },
  'lsp.unsupported_operation': {
    title: 'Unsupported LSP operation',
    retryable: false,
    public: true,
    action: 'This language server does not implement the requested operation.',
  },
  'lsp.workspace_required': {
    title: 'Workspace required for LSP',
    retryable: false,
    public: true,
    action: 'Open a workspace before using language-server features.',
  },
  'message.not_found': {
    title: 'Message not found',
    retryable: false,
    public: true,
    action: 'Check the message id against the session transcript.',
  },
  'model.not_found': {
    title: 'Model not found',
    retryable: false,
    public: true,
    action: 'Check the model alias or configure the model first.',
  },
  'modelsDev.catalog_entry_not_found': {
    title: 'Directory entry not found',
    retryable: false,
    public: true,
    action: 'Check the catalog id against the models.dev directory listing.',
  },
  'modelsDev.catalog_unavailable': {
    title: 'models.dev directory unavailable',
    retryable: false,
    public: true,
    action: 'Check the network connection to models.dev and try again.',
  },
  'modelsDev.import_invalid': {
    title: 'Directory entry not importable',
    retryable: false,
    public: true,
    action: 'Pick another entry or supply the required base_url.',
  },
  'modelsDev.registry_import_invalid': {
    title: 'Custom registry not importable',
    retryable: false,
    public: true,
    action: 'Check the registry URL and credentials.',
  },
  'os.fs.already_exists': {
    title: 'Path already exists',
    retryable: false,
    public: true,
  },
  'os.fs.is_directory': {
    title: 'Path is a directory',
    retryable: false,
    public: true,
  },
  'os.fs.not_directory': {
    title: 'Path is not a directory',
    retryable: false,
    public: true,
  },
  'os.fs.not_empty': {
    title: 'Directory not empty',
    retryable: false,
    public: true,
  },
  'os.fs.not_found': {
    title: 'Path not found',
    retryable: false,
    public: true,
  },
  'os.fs.permission_denied': {
    title: 'Permission denied',
    retryable: false,
    public: true,
    action: 'Check the file permissions of the target path.',
  },
  'os.fs.unavailable': {
    title: 'Filesystem unavailable',
    retryable: true,
    public: true,
  },
  'os.fs.unknown': {
    title: 'Filesystem error',
    retryable: true,
    public: true,
  },
  'os.process.kill_failed': {
    title: 'Failed to kill process',
    retryable: false,
    public: true,
  },
  'os.process.spawn_failed': {
    title: 'Failed to spawn process',
    retryable: false,
    public: true,
    action: 'Check that the command exists and is executable.',
  },
  'profile.already_bound': {
    title: 'Agent profile already bound',
    retryable: false,
    public: true,
    action: 'Unbind the current profile before binding another.',
  },
  'profile.not_bound': {
    title: 'No agent profile bound',
    retryable: false,
    public: true,
    action: 'Bind an agent profile before using profile features.',
  },
  'profile.thinking_alias_conflict': {
    title: 'Thinking alias conflict',
    retryable: false,
    public: true,
    action: 'Two profiles declared the same thinking alias; rename one.',
  },
  'profile.unknown': {
    title: 'Unknown agent profile',
    retryable: false,
    public: true,
    action: 'Check the profile id against the registered profiles.',
  },
  'prompt.id_conflict': {
    title: 'Prompt id conflict',
    retryable: false,
    public: true,
    action: 'Use a unique prompt id.',
  },
  'prompt.not_found': {
    title: 'Prompt not found',
    retryable: false,
    public: true,
    action: 'Check the prompt id against the session prompts.',
  },
  'prompt_optimizer.busy': {
    title: 'Prompt rewrite already in progress',
    retryable: true,
    public: true,
    action: 'Wait for the current rewrite to finish before starting another.',
  },
  'prompt_optimizer.disabled': {
    title: 'Prompt optimizer is disabled',
    retryable: false,
    public: true,
    action: 'Turn on the prompt_optimizer experimental flag to use it.',
  },
  'prompt_optimizer.empty_draft': {
    title: 'Prompt draft is empty',
    retryable: false,
    public: true,
    action: 'Provide a prompt draft to optimize.',
  },
  'prompt_optimizer.no_output': {
    title: 'Prompt optimizer returned no output',
    retryable: true,
    public: true,
    action: 'Retry the optimization.',
  },
  'prompt_optimizer.output_too_long': {
    title: 'Prompt rewrite exceeded the length limit',
    retryable: false,
    public: true,
    action: 'Retry, or shorten the draft so the rewrite fits the limit.',
  },
  'provider.not_found': {
    title: 'Provider not found',
    retryable: false,
    public: true,
    action: 'Check the provider id or configure the provider first.',
  },
  'provider.oauth_managed': {
    title: 'Provider managed by OAuth login',
    retryable: false,
    public: true,
    action: 'Log out via the OAuth flow instead of editing the provider.',
  },
  'provider.overloaded': {
    title: 'Provider overloaded',
    retryable: true,
    public: true,
    action: 'Retry after the provider recovers from overload.',
  },
  'session.busy': {
    title: 'Session is busy',
    retryable: false,
    public: true,
    action: 'Wait for the running turn to finish or cancel it.',
  },
  'session.export_output_conflict': {
    title: 'Export output already exists',
    retryable: false,
    public: true,
    action: 'Choose another output path or remove the existing file.',
  },
  'session.export_too_large': {
    title: 'Export too large',
    retryable: false,
    public: true,
    action: 'Narrow the export range or raise the export size limit.',
  },
  'session.tower_mode_invalid': {
    title: 'Invalid tower mode transition',
    retryable: false,
    public: true,
    action: 'Follow the documented tower-mode transitions.',
  },
  'session.undo_unavailable': {
    title: 'Undo unavailable',
    retryable: false,
    public: true,
    action: 'There are no undoable steps in this session.',
  },
  'session_query.index_unavailable': {
    title: 'Session index unavailable',
    retryable: true,
    public: true,
    action: 'The session search index is not ready; retry shortly.',
  },
  'session_query.invalid_filter': {
    title: 'Invalid session query filter',
    retryable: false,
    public: true,
    action: 'Check filter fields against the query schema.',
  },
  'session_query.session_not_found': {
    title: 'Session not found in the index',
    retryable: false,
    public: true,
    action: 'Reindex the session or pick another one.',
  },
  'skill.nested_too_deep': {
    title: 'Skill nesting too deep',
    retryable: false,
    public: true,
    action: 'Reduce the nesting depth of the skill chain.',
  },
  'skill.parse_failed': {
    title: 'Skill failed to parse',
    retryable: false,
    public: true,
    action: 'Fix the skill frontmatter and body syntax.',
  },
  'spec.incomplete': {
    title: 'Spec is incomplete',
    retryable: false,
    public: true,
    action: 'Fill in the required spec sections before exiting spec mode.',
  },
  'spec.mode_invalid': {
    title: 'Invalid spec mode transition',
    retryable: false,
    public: true,
    action: 'Follow the documented spec-mode transitions.',
  },
  'spec.write_denied': {
    title: 'Spec write denied',
    retryable: false,
    public: true,
    action: 'Spec files are read-only in this mode.',
  },
  'state.cycle': {
    title: 'Event dispatch cycle',
    retryable: false,
    public: true,
    action: 'A subscriber re-dispatches endlessly; break the event cycle.',
  },
  'state.duplicate_fold': {
    title: 'Duplicate state fold',
    retryable: false,
    public: true,
    action: 'A state registered two folds for the same event; merge them.',
  },
  'state.durability_mismatch': {
    title: 'Transient state folds durable event',
    retryable: false,
    public: true,
    action: 'A non-durable state cannot fold a durable event; mark the state durable.',
  },
  'storage.corrupted': {
    title: 'Stored data is corrupted',
    retryable: false,
    public: true,
    action: 'Inspect the backing store; the corrupted entry must be repaired or dropped.',
  },
  'storage.decode_failed': {
    title: 'Stored value could not be decoded',
    retryable: false,
    public: true,
    action: 'Inspect the stored document; it is not valid for its declared format.',
  },
  'storage.disk_full': {
    title: 'Storage disk full',
    retryable: false,
    public: true,
    action: 'Free up disk space and retry.',
  },
  'storage.io_failed': {
    title: 'Storage I/O failed',
    retryable: true,
    public: true,
  },
  'storage.locked': {
    title: 'Storage is locked',
    retryable: true,
    public: true,
    action: 'Another process holds the store; close it or retry later.',
  },
  'storage.not_found': {
    title: 'Stored value not found',
    retryable: false,
    public: true,
  },
  'storage.permission_denied': {
    title: 'Storage permission denied',
    retryable: false,
    public: true,
    action: 'Check the permissions of the storage directory.',
  },
  'task.limit_exceeded': {
    title: 'Task limit exceeded',
    retryable: true,
    public: true,
    action: 'Wait for running tasks to finish or raise the concurrency limit.',
  },
  'terminal.not_found': {
    title: 'Terminal not found',
    retryable: false,
    public: true,
    action: 'Check the terminal id or open a new terminal.',
  },
  'usage.turn_id_conflict': {
    title: 'Usage turn id conflict',
    retryable: false,
    public: true,
    action: 'Use a unique turn id when recording usage.',
  },
  'validation.failed': {
    title: 'Validation failed',
    retryable: false,
    public: true,
    action: 'Check the request fields against the documented schema.',
  },
  'web.fetch_failed': {
    title: 'Web fetch failed',
    retryable: true,
    public: true,
    action: 'Check the URL and network connectivity, then retry.',
  },
  'web.invalid_url': {
    title: 'Invalid URL',
    retryable: false,
    public: true,
    action: 'Provide a well-formed absolute URL.',
  },
  'web.private_address': {
    title: 'URL points to a private address',
    retryable: false,
    public: true,
    action: 'Only public addresses can be fetched.',
  },
  'wire.cycle': {
    title: 'Wire record cycle',
    retryable: false,
    public: true,
    action: 'The wire record chain references itself; the session may be corrupt.',
  },
  'wire.duplicate_op': {
    title: 'Duplicate wire op type',
    retryable: false,
    public: true,
    action: 'Two ops registered the same type; rename one of them. This is a build-time error.',
  },
  'wire.migration_missing': {
    title: 'Wire migration missing',
    retryable: false,
    public: true,
    action: 'The wire file predates the supported migration chain; start a new session.',
  },
  'wire.unknown_record': {
    title: 'Unknown wire record',
    retryable: false,
    public: true,
    action: 'The record was written by a newer version; upgrade or drop it.',
  },
  'workspace.not_found': {
    title: 'Workspace not found',
    retryable: false,
    public: true,
    action: 'Check the workspace root or open a workspace first.',
  },
  not_implemented: {
    title: 'Not implemented',
    retryable: false,
    public: true,
    action: 'This feature is not implemented yet.',
  },
  internal: {
    title: 'Internal error',
    retryable: false,
    public: true,
    action: 'Inspect logs or report the issue with diagnostics.',
  },
} as const satisfies Record<KimiErrorCode, KimiErrorInfo>;

/**
 * Runtime membership check against the registry. Errors arriving from another
 * process or engine generation may carry codes this build does not declare;
 * branch on this before indexing `KIMI_ERROR_INFO` with an untrusted code.
 */
export function isKimiErrorCode(code: unknown): code is KimiErrorCode {
  return typeof code === 'string' && Object.hasOwn(KIMI_ERROR_INFO, code);
}

export function resolveErrorTitle(code: KimiErrorCode): string {
  const info = KIMI_ERROR_INFO[code];
  return info ? info.title : code;
}

export interface KimiErrorOptions {
  /** JSON-serializable structured details. */
  readonly details?: Record<string, unknown>;
  /** Original error or value. Local-only; never serialized to the wire. */
  readonly cause?: unknown;
}

/**
 * The single Kimi error class.
 *
 * Discrimination is always by `code`. Cross-process consumers receive
 * `KimiErrorPayload` and must branch on `code` rather than class identity.
 */
export class KimiError extends Error {
  readonly code: KimiErrorCode;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(code: KimiErrorCode, message: string, options: KimiErrorOptions = {}) {
    super(message);
    this.name = 'KimiError';
    this.code = code;
    this.details = options.details;
    this.cause = options.cause;
  }
}

/**
 * Wire-safe payload of a Kimi error.
 *
 * The structure passed across process / language boundaries (RPC, events,
 * telemetry, SDK wrappers). Class identity does not survive the boundary;
 * downstream code must branch on `code` rather than `instanceof`.
 *
 * `details` is JSON-serialized. `cause` is intentionally absent -- it is
 * local-only diagnostic state and must not cross the boundary.
 */
export interface KimiErrorPayload {
  readonly code: KimiErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
}

/** Type guard for KimiError. */
export function isKimiError(error: unknown): error is KimiError {
  return error instanceof KimiError;
}

/**
 * Build a KimiErrorPayload directly from a code + message (no Error instance
 * needed). Use this for synthetic error events that are signaled, not thrown
 * -- e.g. "turn busy" or "compaction failed". `retryable` is filled from
 * KIMI_ERROR_INFO so callers cannot drift out of sync with the registry.
 */
export function makeErrorPayload(
  code: KimiErrorCode,
  message: string,
  options?: { readonly details?: Record<string, unknown>; readonly name?: string },
): KimiErrorPayload {
  return {
    code,
    message,
    name: options?.name,
    details: options?.details,
    retryable: KIMI_ERROR_INFO[code].retryable,
  };
}

/**
 * Normalize any value into a KimiErrorPayload.
 *
 * Recognized errors:
 * - `KimiError`: passthrough.
 * - `APIStatusError`: 429 -> rate_limit, 401 -> auth_error, otherwise -> api_error.
 *   Exception: a quota-exhausted 429 maps to api_error (retryable: false) —
 *   the rate_limit code would re-mint a rate-limit error across the wire
 *   boundary and drive the swarm requeue/suspend loop, which cannot help
 *   until the account is recharged.
 * - `APIConnectionError` / `APITimeoutError`: connection_error.
 * - `ChatProviderError`: api_error.
 *
 * Anything else collapses to `internal`. We never echo `cause` or stack on
 * the wire.
 */
export function toKimiErrorPayload(error: unknown): KimiErrorPayload {
  if (isKimiError(error)) {
    return {
      code: error.code,
      message: error.message,
      name: error.name,
      details: error.details,
      retryable: KIMI_ERROR_INFO[error.code].retryable,
    };
  }

  if (error instanceof APIStatusError) {
    const code: KimiErrorCode =
      error instanceof APIProviderQuotaExhaustedError
        ? ErrorCodes.PROVIDER_API_ERROR
        : error.statusCode === 429
          ? ErrorCodes.PROVIDER_RATE_LIMIT
          : error.statusCode === 401
            ? ErrorCodes.PROVIDER_AUTH_ERROR
            : ErrorCodes.PROVIDER_API_ERROR;
    return {
      code,
      message: sanitizeStatusErrorMessage(error.message),
      name: error.name,
      details: {
        statusCode: error.statusCode,
        requestId: error.requestId,
      },
      retryable: KIMI_ERROR_INFO[code].retryable,
    };
  }

  if (error instanceof APIConnectionError || error instanceof APITimeoutError) {
    return {
      code: ErrorCodes.PROVIDER_CONNECTION_ERROR,
      message: error.message,
      name: error.name,
      retryable: KIMI_ERROR_INFO[ErrorCodes.PROVIDER_CONNECTION_ERROR].retryable,
    };
  }

  if (error instanceof APIEmptyResponseError) {
    const code =
      error.finishReason === 'filtered'
        ? ErrorCodes.PROVIDER_FILTERED
        : ErrorCodes.PROVIDER_API_ERROR;
    return {
      code,
      message: error.message,
      name: error.name,
      details: {
        finishReason: error.finishReason,
        rawFinishReason: error.rawFinishReason,
      },
      retryable: KIMI_ERROR_INFO[code].retryable,
    };
  }

  if (error instanceof ChatProviderError) {
    return {
      code: ErrorCodes.PROVIDER_API_ERROR,
      message: error.message,
      name: error.name,
      retryable: KIMI_ERROR_INFO[ErrorCodes.PROVIDER_API_ERROR].retryable,
    };
  }

  if (error instanceof Error) {
    return {
      code: ErrorCodes.INTERNAL,
      message: error.message,
      name: error.name,
      retryable: KIMI_ERROR_INFO[ErrorCodes.INTERNAL].retryable,
    };
  }

  return {
    code: ErrorCodes.INTERNAL,
    message: String(error),
    retryable: KIMI_ERROR_INFO[ErrorCodes.INTERNAL].retryable,
  };
}

function sanitizeStatusErrorMessage(message: string): string {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(message);
  const extracted = titleMatch?.[1]?.trim();
  const normalized = extracted !== undefined && extracted.length > 0 ? extracted : message;
  return normalized.replaceAll('\r', '');
}

export function fromKimiErrorPayload(payload: KimiErrorPayload): KimiError {
  return new KimiError(payload.code, payload.message, {
    details: payload.details,
  });
}
