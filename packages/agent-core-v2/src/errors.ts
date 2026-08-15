/**
 * Error facade — aggregates every domain's error contribution into the unified
 * `ErrorCodes` const and re-exports the error primitives. Importing this
 * module registers every domain's codes.
 */

import { CoreErrors } from '#/_base/errors/codes';
import { FullCompactionErrors } from '#/agent/fullCompaction/errors';
import { GoalErrors } from '#/agent/goal/errors';
import { LoopErrors } from '#/agent/loop/errors';
import { ProfileErrors } from '#/agent/profile/errors';
import { PromptErrors } from '#/agent/prompt/errors';
import { TaskErrors } from '#/agent/task/errors';
import { UsageErrors } from '#/agent/usage/errors';
import { AuthErrors } from '#/app/auth/errors';
import { CapabilityErrors } from '#/app/capability/errors';
import { ConfigErrors } from '#/app/config/errors';
import { CronErrors } from '#/app/cron/errors';
import { FileErrors } from '#/app/file/fileService';
import { ModelsDevImportErrors } from '#/app/kosongConfig/errors';
import { PluginErrors } from '#/app/plugin/errors';
import { SessionExportErrors } from '#/app/sessionExport/errors';
import { SkillErrors } from '#/app/skillCatalog/errors';
import { WebErrors } from '#/app/web/errors';
import { WorkspaceErrors } from '#/app/workspace/errors';
import { DebugErrors } from '#/debug/errors';
import { AttachmentErrors } from '#/features/attachment/errors';
import { LspErrors } from '#/features/lsp/errors';
import { SessionQueryErrors } from '#/features/sessionQuery/errors';
import { ModelCatalogErrors } from '#/kosong/model/errors';
import { ProtocolErrors } from '#/kosong/protocol/errors';
import { McpErrors } from '#/mcpCore/errors';
import { OsFsErrors } from '#/os/interface/hostFsErrors';
import { OsProcessErrors } from '#/os/interface/hostProcess';
import { TerminalErrors } from '#/os/interface/terminalErrors';
import { StorageErrors } from '#/persistence/interface/storage';
import { AgentLifecycleErrors } from '#/session/agentLifecycle/errors';
import { SessionErrors } from '#/session/errors';
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
export { ProtocolErrors } from '#/kosong/protocol/errors';
export { ConfigErrors } from '#/app/config/errors';
export { CapabilityErrors } from '#/app/capability/errors';
export { CronErrors } from '#/app/cron/errors';
export { DebugErrors } from '#/debug/errors';
export { FileErrors } from '#/app/file/fileService';
export { FsErrors } from '#/workspace/workspaceFs/internal/errors';
export { FullCompactionErrors } from '#/agent/fullCompaction/errors';
export { GoalErrors } from '#/agent/goal/errors';
export { LoopErrors } from '#/agent/loop/errors';
export { LspErrors } from '#/features/lsp/errors';
export { McpErrors } from '#/mcpCore/errors';
export { ModelCatalogErrors } from '#/kosong/model/errors';
export { OsFsErrors } from '#/os/interface/hostFsErrors';
export { OsProcessErrors } from '#/os/interface/hostProcess';
export { PluginErrors } from '#/app/plugin/errors';
export { ProfileErrors } from '#/agent/profile/errors';
export { PromptErrors } from '#/agent/prompt/errors';
export { ModelsDevImportErrors } from '#/app/kosongConfig/errors';
export { SessionExportErrors } from '#/app/sessionExport/errors';
export { SessionErrors } from '#/session/errors';
export { SessionQueryErrors } from '#/features/sessionQuery/errors';
export { AttachmentErrors } from '#/features/attachment/errors';
export { SkillErrors } from '#/app/skillCatalog/errors';
export { StorageErrors } from '#/persistence/interface/storage';
export { TerminalErrors } from '#/os/interface/terminalErrors';
export { UsageErrors } from '#/agent/usage/errors';
export { WebErrors } from '#/app/web/errors';
export { WireErrors } from '#/wire/errors';
export { WorkspaceErrors } from '#/app/workspace/errors';

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
  ...FileErrors.codes,
  ...FsErrors.codes,
  ...FullCompactionErrors.codes,
  ...GoalErrors.codes,
  ...LoopErrors.codes,
  ...LspErrors.codes,
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
  ...SessionQueryErrors.codes,
  ...AttachmentErrors.codes,
  ...SkillErrors.codes,
  ...StorageErrors.codes,
  ...TerminalErrors.codes,
  ...UsageErrors.codes,
  ...WebErrors.codes,
  ...WireErrors.codes,
  ...WorkspaceErrors.codes,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
