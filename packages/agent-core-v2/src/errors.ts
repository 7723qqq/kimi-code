import { CoreErrors } from '#/_base/errors/codes';
import type { KimiErrorPayload } from '#/_base/errors/serialize';
import { SpecErrors } from '#/features/spec/errors';
import { SessionQueryErrors } from '#/features/sessionQuery/errors';
import { PromptOptimizerErrors } from '#/features/promptOptimizer/errors';
import { LspErrors } from '#/features/lsp/errors';
import { AttachmentErrors } from '#/features/attachment/errors';
import { AgentLifecycleErrors } from '#/session/agentLifecycle/errors';
import { AuthErrors } from '#/app/auth/errors';
import { TaskErrors } from '#/agent/task/errors';
import { ProtocolErrors } from '#/llm-adapter/protocol/errors';
import { ConfigErrors } from '#/app/config/errors';
import { CapabilityErrors } from '#/app/capability/errors';
import { CronErrors } from '#/features/cron/errors';
import { DebugErrors } from '#/debug/errors';
import { EventErrors } from '#/app/event/errors';
import { FileErrors } from '#/app/file/fileService';
import { FsErrors } from '#/workspace/workspaceFs/internal/errors';
import { FullCompactionErrors } from '#/agent/fullCompaction/errors';
import { GoalErrors } from '#/features/goal/errors';
import { LoopErrors } from '#/agent/loop/errors';
import { McpErrors } from '#/mcpCore/errors';
import { ModelCatalogErrors } from '#/llm-adapter/model/errors';
import { OsFsErrors } from '#/os/interface/hostFsErrors';
import { OsProcessErrors } from '#/os/interface/hostProcess';
import { PluginErrors } from '#/app/plugin/errors';
import { ProfileErrors } from '#/agent/profile/errors';
import { PromptErrors } from '#/agent/prompt/errors';
import { ModelsDevImportErrors } from '#/app/kosongConfig/errors';
import { SessionExportErrors } from '#/app/sessionExport/errors';
import { SessionErrors } from '#/session/errors';
import { SkillErrors } from '#/features/skill/catalog/errors';
import { StateErrors } from '#/state/errors';
import { StorageErrors } from '#/persistence/interface/storage';
import { UsageErrors } from '#/agent/usage/errors';
import { WebErrors } from '#/app/web/errors';
import { WireErrors } from '#/wire/errors';
import { WorkspaceErrors } from '#/app/workspace/errors';

export * from '#/_base/errors/codes';
export * from '#/_base/errors/errorMessage';
export * from '#/_base/errors/errors';
export * from '#/_base/errors/serialize';
export { AttachmentErrors } from '#/features/attachment/errors';
export { LspErrors } from '#/features/lsp/errors';
export { SessionQueryErrors } from '#/features/sessionQuery/errors';
export { PromptOptimizerErrors } from '#/features/promptOptimizer/errors';
export { SpecErrors } from '#/features/spec/errors';
export * from '#/_base/errors/unexpectedError';
export { AgentLifecycleErrors } from '#/session/agentLifecycle/errors';
export { AuthErrors } from '#/app/auth/errors';
export { TaskErrors } from '#/agent/task/errors';
export { ProtocolErrors } from '#/llm-adapter/protocol/errors';
export { ConfigErrors } from '#/app/config/errors';
export { CapabilityErrors } from '#/app/capability/errors';
export { CronErrors } from '#/features/cron/errors';
export { DebugErrors } from '#/debug/errors';
export { FileErrors } from '#/app/file/fileService';
export { FsErrors } from '#/workspace/workspaceFs/internal/errors';
export { FullCompactionErrors } from '#/agent/fullCompaction/errors';
export { GoalErrors } from '#/features/goal/errors';
export { LoopErrors } from '#/agent/loop/errors';
export { McpErrors } from '#/mcpCore/errors';
export { ModelCatalogErrors } from '#/llm-adapter/model/errors';
export { OsFsErrors } from '#/os/interface/hostFsErrors';
export { OsProcessErrors } from '#/os/interface/hostProcess';
export { PluginErrors } from '#/app/plugin/errors';
export { ProfileErrors } from '#/agent/profile/errors';
export { PromptErrors } from '#/agent/prompt/errors';
export { ModelsDevImportErrors } from '#/app/kosongConfig/errors';
export { SessionExportErrors } from '#/app/sessionExport/errors';
export { SessionErrors } from '#/session/errors';
export { SkillErrors } from '#/features/skill/catalog/errors';
export { StorageErrors } from '#/persistence/interface/storage';
export { UsageErrors } from '#/agent/usage/errors';
export { WebErrors } from '#/app/web/errors';
export { WireErrors } from '#/wire/errors';
export { WorkspaceErrors } from '#/app/workspace/errors';
export { EventErrors } from '#/app/event/errors';
export { StateErrors } from '#/state/errors';

export const ErrorCodes = {
  ...CoreErrors.codes,
  ...AttachmentErrors.codes,
  ...LspErrors.codes,
  ...SessionQueryErrors.codes,
  ...PromptOptimizerErrors.codes,
  ...SpecErrors.codes,
  ...AgentLifecycleErrors.codes,
  ...AuthErrors.codes,
  ...TaskErrors.codes,
  ...ProtocolErrors.codes,
  ...ConfigErrors.codes,
  ...CapabilityErrors.codes,
  ...CronErrors.codes,
  ...DebugErrors.codes,
  ...FileErrors.codes,
  ...FsErrors.codes,
  ...FullCompactionErrors.codes,
  ...GoalErrors.codes,
  ...LoopErrors.codes,
  ...McpErrors.codes,
  ...ModelCatalogErrors.codes,
  ...OsFsErrors.codes,
  ...OsProcessErrors.codes,
  ...PluginErrors.codes,
  ...ProfileErrors.codes,
  ...PromptErrors.codes,
  ...ModelsDevImportErrors.codes,
  ...SessionExportErrors.codes,
  ...SessionErrors.codes,
  ...SkillErrors.codes,
  ...StorageErrors.codes,
  ...UsageErrors.codes,
  ...WebErrors.codes,
  ...WireErrors.codes,
  ...WorkspaceErrors.codes,
  ...EventErrors.codes,
  ...StateErrors.codes,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export type KimiErrorCode =
  | 'agent.already_exists'
  | 'agent.already_running'
  | 'agent.max_tokens_exceeded'
  | 'agent.no_final_message'
  | 'agent.not_a_subagent'
  | 'agent.not_found'
  | 'agent.not_owned'
  | 'agent.subagent_depth_exceeded'
  | 'agent.type_not_allowed'
  | 'attachment.image_too_large'
  | 'attachment.image_too_many_pixels'
  | 'attachment.image_type_mismatch'
  | 'attachment.invalid_image'
  | 'attachment.invalid_ref'
  | 'auth.login_required'
  | 'auth.model_not_resolved'
  | 'auth.provisioning_required'
  | 'auth.token_missing'
  | 'auth.token_unauthorized'
  | 'capability.install_in_progress'
  | 'capability.not_found'
  | 'capability.unsupported'
  | 'compaction.failed'
  | 'compaction.unable'
  | 'config.invalid'
  | 'config.persist_blocked'
  | 'context.overflow'
  | 'cron.expression_invalid'
  | 'debug.scope_not_found'
  | 'debug.token_not_found'
  | 'event.duplicate_event'
  | 'event.schema_missing'
  | 'file.not_found'
  | 'file.too_large'
  | 'fs.already_exists'
  | 'fs.git_unavailable'
  | 'fs.grep_timeout'
  | 'fs.is_binary'
  | 'fs.is_directory'
  | 'fs.path_escapes'
  | 'fs.path_not_found'
  | 'fs.permission_denied'
  | 'fs.too_large'
  | 'fs.too_many_results'
  | 'goal.already_exists'
  | 'goal.metadata_reserved'
  | 'goal.not_found'
  | 'goal.not_resumable'
  | 'goal.objective_empty'
  | 'goal.objective_too_long'
  | 'goal.status_invalid'
  | 'goal.unsupported_agent'
  | 'internal'
  | 'loop.max_steps_exceeded'
  | 'lsp.conflict'
  | 'lsp.malformed_response'
  | 'lsp.server_failed'
  | 'lsp.unavailable'
  | 'lsp.unsupported_operation'
  | 'lsp.workspace_required'
  | 'mcp.oauth_failed'
  | 'mcp.server_disabled'
  | 'mcp.server_not_found'
  | 'mcp.startup_failed'
  | 'mcp.tool_name_collision'
  | 'message.not_found'
  | 'model.config_invalid'
  | 'model.not_configured'
  | 'model.not_found'
  | 'not_implemented'
  | 'os.fs.already_exists'
  | 'os.fs.is_directory'
  | 'os.fs.not_directory'
  | 'os.fs.not_empty'
  | 'os.fs.not_found'
  | 'os.fs.permission_denied'
  | 'os.fs.unavailable'
  | 'os.fs.unknown'
  | 'os.process.kill_failed'
  | 'os.process.spawn_failed'
  | 'plugin.load_failed'
  | 'plugin.not_found'
  | 'profile.already_bound'
  | 'profile.not_bound'
  | 'profile.thinking_alias_conflict'
  | 'profile.unknown'
  | 'prompt.id_conflict'
  | 'prompt.not_found'
  | 'prompt_optimizer.busy'
  | 'prompt_optimizer.disabled'
  | 'prompt_optimizer.empty_draft'
  | 'prompt_optimizer.input_too_long'
  | 'prompt_optimizer.no_output'
  | 'prompt_optimizer.output_too_long'
  | 'prompt_optimizer.timeout'
  | 'provider.api_error'
  | 'provider.auth_error'
  | 'provider.connection_error'
  | 'provider.filtered'
  | 'provider.not_found'
  | 'provider.oauth_managed'
  | 'provider.overloaded'
  | 'provider.rate_limit'
  | 'records.write_failed'
  | 'request.invalid'
  | 'request.prompt_input_empty'
  | 'request.work_dir_required'
  | 'session.already_exists'
  | 'session.approval_handler_error'
  | 'session.busy'
  | 'session.closed'
  | 'session.export_missing_version'
  | 'session.export_not_found'
  | 'session.export_output_conflict'
  | 'session.export_too_large'
  | 'session.fork_active_turn'
  | 'session.id_empty'
  | 'session.id_invalid'
  | 'session.id_required'
  | 'session.init_failed'
  | 'session.model_empty'
  | 'session.not_found'
  | 'session.occupied'
  | 'session.permission_mode_invalid'
  | 'session.plan_mode_invalid'
  | 'session.question_handler_error'
  | 'session.stale'
  | 'session.state_invalid'
  | 'session.state_not_found'
  | 'session.thinking_empty'
  | 'session.title_empty'
  | 'session.tower_mode_invalid'
  | 'session.undo_unavailable'
  | 'session_query.index_unavailable'
  | 'session_query.invalid_filter'
  | 'session_query.session_not_found'
  | 'shell.git_bash_not_found'
  | 'skill.name_empty'
  | 'skill.nested_too_deep'
  | 'skill.not_found'
  | 'skill.parse_failed'
  | 'skill.type_unsupported'
  | 'spec.incomplete'
  | 'spec.mode_invalid'
  | 'spec.write_denied'
  | 'state.cycle'
  | 'state.duplicate_fold'
  | 'state.durability_mismatch'
  | 'storage.corrupted'
  | 'storage.decode_failed'
  | 'storage.disk_full'
  | 'storage.io_failed'
  | 'storage.locked'
  | 'storage.not_found'
  | 'storage.permission_denied'
  | 'task.limit_exceeded'
  | 'task.task_id_empty'
  | 'turn.agent_busy'
  | 'usage.turn_id_conflict'
  | 'validation.failed'
  | 'web.fetch_failed'
  | 'web.invalid_url'
  | 'web.private_address'
  | 'wire.cycle'
  | 'wire.duplicate_op'
  | 'wire.migration_missing'
  | 'wire.unknown_record'
  | 'modelsDev.catalog_entry_not_found'
  | 'modelsDev.catalog_unavailable'
  | 'modelsDev.import_invalid'
  | 'modelsDev.registry_import_invalid'
  | 'workspace.not_found'
  | 'workspace.not_found';

export interface ErrorEvent {
  readonly type: 'error';
  readonly code: KimiErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
  readonly cause?: KimiErrorPayload;
}

export interface WarningEvent {
  readonly type: 'warning';
  readonly message: string;
  readonly code?: string;
}
