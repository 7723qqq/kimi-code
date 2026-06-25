/**
 * Public error-code registry (`ErrorCodes`, `ErrorCode`) and per-code metadata
 * (`ERROR_INFO`, `errorInfo`) surfaced to SDK/RPC consumers.
 */

export const ErrorCodes = {
  CONFIG_INVALID: 'config.invalid',
  INTERNAL: 'internal',
  NOT_IMPLEMENTED: 'not_implemented',
  CANCELED: 'canceled',
  TURN_AGENT_BUSY: 'turn.agent_busy',
  GOAL_ALREADY_EXISTS: 'goal.already_exists',
  GOAL_NOT_FOUND: 'goal.not_found',
  GOAL_OBJECTIVE_EMPTY: 'goal.objective_empty',
  GOAL_OBJECTIVE_TOO_LONG: 'goal.objective_too_long',
  GOAL_STATUS_INVALID: 'goal.status_invalid',
  GOAL_NOT_RESUMABLE: 'goal.not_resumable',
  MODEL_NOT_CONFIGURED: 'model.not_configured',
  MODEL_CONFIG_INVALID: 'model.config_invalid',
  AUTH_LOGIN_REQUIRED: 'auth.login_required',
  LOOP_MAX_STEPS_EXCEEDED: 'loop.max_steps_exceeded',
  CONTEXT_OVERFLOW: 'context.overflow',
  PROVIDER_RATE_LIMIT: 'provider.rate_limit',
  PROVIDER_AUTH_ERROR: 'provider.auth_error',
  SKILL_NOT_FOUND: 'skill.not_found',
  SKILL_TYPE_UNSUPPORTED: 'skill.type_unsupported',
  COMPACTION_FAILED: 'compaction.failed',
  COMPACTION_UNABLE: 'compaction.unable',
  MCP_SERVER_NOT_FOUND: 'mcp.server_not_found',
  MCP_SERVER_DISABLED: 'mcp.server_disabled',
  MCP_TOOL_NAME_COLLISION: 'mcp.tool_name_collision',
  REQUEST_INVALID: 'request.invalid',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ErrorInfo {
  readonly title: string;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action?: string;
}

export const ERROR_INFO = {
  'config.invalid': {
    title: 'Invalid configuration',
    retryable: false,
    public: true,
    action: 'Check configuration values.',
  },
  internal: {
    title: 'Internal error',
    retryable: false,
    public: true,
    action: 'Inspect logs or report the issue with diagnostics.',
  },
  not_implemented: {
    title: 'Not implemented',
    retryable: false,
    public: true,
    action: 'This feature is not implemented yet.',
  },
  canceled: {
    title: 'Canceled',
    retryable: false,
    public: true,
    action: 'The operation was canceled by the user or an abort signal.',
  },
  'turn.agent_busy': {
    title: 'Agent is busy',
    retryable: true,
    public: true,
    action: 'Wait for the current turn to finish.',
  },
  'goal.already_exists': {
    title: 'A goal is already active',
    retryable: false,
    public: true,
    action: 'Replace, pause, or complete the current goal first.',
  },
  'goal.not_found': {
    title: 'No goal found',
    retryable: false,
    public: true,
    action: 'Start a goal first.',
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
    action: 'Shorten the objective.',
  },
  'goal.status_invalid': {
    title: 'Invalid goal status transition',
    retryable: false,
    public: true,
    action: 'Use a valid goal lifecycle transition.',
  },
  'goal.not_resumable': {
    title: 'Goal is not resumable',
    retryable: false,
    public: true,
    action: 'Only paused or blocked goals can be resumed.',
  },
  'model.not_configured': {
    title: 'No model configured',
    retryable: false,
    public: true,
    action: 'Configure a model before starting a request.',
  },
  'model.config_invalid': {
    title: 'Invalid model configuration',
    retryable: false,
    public: true,
    action: 'Check provider and model configuration.',
  },
  'auth.login_required': {
    title: 'Login required',
    retryable: false,
    public: true,
    action: 'Run the login flow before retrying.',
  },
  'loop.max_steps_exceeded': {
    title: 'Loop max steps exceeded',
    retryable: false,
    public: true,
    action: 'Raise the max step limit or inspect the tool loop for non-convergence.',
  },
  'context.overflow': {
    title: 'Context overflow',
    retryable: true,
    public: true,
    action: 'Compact the conversation or retry with fewer tokens.',
  },
  'provider.rate_limit': {
    title: 'Provider rate limit',
    retryable: true,
    public: true,
    action: 'Retry after the provider rate limit resets.',
  },
  'provider.auth_error': {
    title: 'Provider authentication failed',
    retryable: false,
    public: true,
    action: 'Check provider credentials and authentication configuration.',
  },
  'skill.not_found': {
    title: 'Skill not found',
    retryable: false,
    public: true,
    action: 'Check the requested skill name.',
  },
  'skill.type_unsupported': {
    title: 'Skill type not supported',
    retryable: false,
    public: true,
    action: 'Use a supported skill type.',
  },
  'compaction.failed': {
    title: 'Compaction failed',
    retryable: false,
    public: true,
    action: 'Inspect logs and retry later.',
  },
  'compaction.unable': {
    title: 'Unable to compact',
    retryable: false,
    public: true,
    action: 'Start a new turn or reduce history manually.',
  },
  'mcp.server_not_found': {
    title: 'MCP server not found',
    retryable: false,
    public: true,
    action: 'Check the configured MCP server name.',
  },
  'mcp.server_disabled': {
    title: 'MCP server is disabled',
    retryable: false,
    public: true,
    action: 'Enable the MCP server before reconnecting.',
  },
  'mcp.tool_name_collision': {
    title: 'MCP tool name collision',
    retryable: false,
    public: true,
    action: 'Rename one of the colliding MCP tools or servers.',
  },
  'request.invalid': {
    title: 'Invalid request',
    retryable: false,
    public: true,
    action: 'Check the input shape.',
  },
} as const satisfies Record<ErrorCode, ErrorInfo>;

export function errorInfo(code: ErrorCode): ErrorInfo {
  return ERROR_INFO[code];
}
