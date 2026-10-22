import { CoreErrors } from '#/_base/errors/codes';
import type { KimiErrorPayload } from '#/_base/errors/serialize';
import { FullCompactionErrors } from '#/agent/fullCompaction/errors';
import { LoopErrors } from '#/agent/loop/errors';
import { ProfileErrors } from '#/agent/profile/errors';
import { PromptErrors } from '#/agent/prompt/errors';
import { TaskErrors } from '#/agent/task/errors';
import { UsageErrors } from '#/agent/usage/errors';
import { AuthErrors } from '#/app/auth/errors';
import { CapabilityErrors } from '#/app/capability/errors';
import { ConfigErrors } from '#/app/config/errors';
import { EventErrors } from '#/app/event/errors';
import { FileErrors } from '#/app/file/fileService';
import { ModelsDevImportErrors } from '#/app/kosongConfig/errors';
import { PluginErrors } from '#/app/plugin/errors';
import { SessionExportErrors } from '#/app/sessionExport/errors';
import { WebErrors } from '#/app/web/errors';
import { WorkspaceErrors } from '#/app/workspace/errors';
import { DebugErrors } from '#/debug/errors';
import { AttachmentErrors } from '#/features/attachment/errors';
import { CronErrors } from '#/features/cron/errors';
import { GoalErrors } from '#/features/goal/errors';
import { LspErrors } from '#/features/lsp/errors';
import { PromptOptimizerErrors } from '#/features/promptOptimizer/errors';
import { SessionQueryErrors } from '#/features/sessionQuery/errors';
import { SkillErrors } from '#/features/skill/catalog/errors';
import { SpecErrors } from '#/features/spec/errors';
import { ModelCatalogErrors } from '#/llm-adapter/model/errors';
import { ProtocolErrors } from '#/llm-adapter/protocol/errors';
import { McpErrors } from '#/mcpCore/errors';
import { OsFsErrors } from '#/os/interface/hostFsErrors';
import { OsProcessErrors } from '#/os/interface/hostProcess';
import { TerminalErrors } from '#/os/interface/terminalErrors';
import { StorageErrors } from '#/persistence/interface/storage';
import { AgentLifecycleErrors } from '#/session/agentLifecycle/errors';
import { SessionErrors } from '#/session/errors';
import { StateErrors } from '#/state/errors';
import { WireErrors } from '#/wire/errors';
import { FsErrors } from '#/workspace/workspaceFs/internal/errors';

export * from '#/_base/errors/codes';
export * from '#/_base/errors/errorMessage';
export * from '#/_base/errors/errors';
export * from '#/_base/errors/serialize';
export * from '#/_base/errors/unexpectedError';
export { AgentLifecycleErrors } from '#/session/agentLifecycle/errors';
export { AuthErrors } from '#/app/auth/errors';
export { TaskErrors } from '#/agent/task/errors';
export { ProtocolErrors } from '#/llm-adapter/protocol/errors';
export { ConfigErrors } from '#/app/config/errors';
export { CapabilityErrors } from '#/app/capability/errors';
export { CronErrors } from '#/features/cron/errors';
export { DebugErrors } from '#/debug/errors';
export { AttachmentErrors } from '#/features/attachment/errors';
export { FileErrors } from '#/app/file/fileService';
export { FsErrors } from '#/workspace/workspaceFs/internal/errors';
export { FullCompactionErrors } from '#/agent/fullCompaction/errors';
export { GoalErrors } from '#/features/goal/errors';
export { LspErrors } from '#/features/lsp/errors';
export { SessionQueryErrors } from '#/features/sessionQuery/errors';
export { LoopErrors } from '#/agent/loop/errors';
export { McpErrors } from '#/mcpCore/errors';
export { ModelCatalogErrors } from '#/llm-adapter/model/errors';
export { OsFsErrors } from '#/os/interface/hostFsErrors';
export { OsProcessErrors } from '#/os/interface/hostProcess';
export { PluginErrors } from '#/app/plugin/errors';
export { ProfileErrors } from '#/agent/profile/errors';
export { PromptErrors } from '#/agent/prompt/errors';
export { PromptOptimizerErrors } from '#/features/promptOptimizer/errors';
export { SpecErrors } from '#/features/spec/errors';
export { ModelsDevImportErrors } from '#/app/kosongConfig/errors';
export { SessionExportErrors } from '#/app/sessionExport/errors';
export { SessionErrors } from '#/session/errors';
export { SkillErrors } from '#/features/skill/catalog/errors';
export { StorageErrors } from '#/persistence/interface/storage';
export { TerminalErrors } from '#/os/interface/terminalErrors';
export { UsageErrors } from '#/agent/usage/errors';
export { WebErrors } from '#/app/web/errors';
export { WireErrors } from '#/wire/errors';
export { WorkspaceErrors } from '#/app/workspace/errors';
export { EventErrors } from '#/app/event/errors';
export { StateErrors } from '#/state/errors';

export const ErrorCodes = {
  ...CoreErrors.codes,
  ...AgentLifecycleErrors.codes,
  ...AuthErrors.codes,
  ...TaskErrors.codes,
  ...ProtocolErrors.codes,
  ...ConfigErrors.codes,
  ...CapabilityErrors.codes,
  ...CronErrors.codes,
  ...DebugErrors.codes,
  ...AttachmentErrors.codes,
  ...FileErrors.codes,
  ...FsErrors.codes,
  ...FullCompactionErrors.codes,
  ...GoalErrors.codes,
  ...LspErrors.codes,
  ...SessionQueryErrors.codes,
  ...LoopErrors.codes,
  ...McpErrors.codes,
  ...ModelCatalogErrors.codes,
  ...OsFsErrors.codes,
  ...OsProcessErrors.codes,
  ...PluginErrors.codes,
  ...ProfileErrors.codes,
  ...PromptErrors.codes,
  ...PromptOptimizerErrors.codes,
  ...SpecErrors.codes,
  ...ModelsDevImportErrors.codes,
  ...SessionExportErrors.codes,
  ...SessionErrors.codes,
  ...SkillErrors.codes,
  ...StorageErrors.codes,
  ...TerminalErrors.codes,
  ...UsageErrors.codes,
  ...WebErrors.codes,
  ...WireErrors.codes,
  ...WorkspaceErrors.codes,
  ...EventErrors.codes,
  ...StateErrors.codes,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export type KimiErrorCode = ErrorCode;

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
