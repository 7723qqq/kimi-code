import type { KimiErrorCode } from '@moonshot-ai/protocol';

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
  PROVIDER_RATE_LIMIT: 'provider.rate_limit',
  PROVIDER_AUTH_ERROR: 'provider.auth_error',
  PROVIDER_CONNECTION_ERROR: 'provider.connection_error',
  SKILL_NOT_FOUND: 'skill.not_found',
  SKILL_TYPE_UNSUPPORTED: 'skill.type_unsupported',
  SKILL_NAME_EMPTY: 'skill.name_empty',
  RECORDS_WRITE_FAILED: 'records.write_failed',
  COMPACTION_FAILED: 'compaction.failed',
  COMPACTION_UNABLE: 'compaction.unable',
  BACKGROUND_TASK_ID_EMPTY: 'background.task_id_empty',
  MCP_SERVER_NOT_FOUND: 'mcp.server_not_found',
  MCP_SERVER_DISABLED: 'mcp.server_disabled',
  MCP_STARTUP_FAILED: 'mcp.startup_failed',
  MCP_TOOL_NAME_COLLISION: 'mcp.tool_name_collision',
  PLUGIN_NOT_FOUND: 'plugin.not_found',
  PLUGIN_LOAD_FAILED: 'plugin.load_failed',
  REQUEST_INVALID: 'request.invalid',
  REQUEST_WORK_DIR_REQUIRED: 'request.work_dir_required',
  REQUEST_PROMPT_INPUT_EMPTY: 'request.prompt_input_empty',
  SHELL_GIT_BASH_NOT_FOUND: 'shell.git_bash_not_found',
  NOT_IMPLEMENTED: 'not_implemented',
  INTERNAL: 'internal',
} as const satisfies Record<string, KimiErrorCode>;

export type ErrorCode = KimiErrorCode;

export interface ErrorInfo {
  readonly title: string;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action?: string;
}

const RETRYABLE_ERROR_CODES = new Set<ErrorCode>([
  ErrorCodes.SESSION_FORK_ACTIVE_TURN,
  ErrorCodes.TURN_AGENT_BUSY,
  ErrorCodes.CONTEXT_OVERFLOW,
  ErrorCodes.PROVIDER_RATE_LIMIT,
  ErrorCodes.PROVIDER_CONNECTION_ERROR,
]);

const KIMI_ERROR_CODES = new Set<ErrorCode>(Object.values(ErrorCodes));

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && KIMI_ERROR_CODES.has(code as ErrorCode);
}

export function errorInfo(code: ErrorCode): ErrorInfo {
  return {
    title: code,
    retryable: RETRYABLE_ERROR_CODES.has(code),
    public: true,
  };
}
