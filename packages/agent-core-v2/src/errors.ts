/**
 * Error facade — aggregates every domain's error contribution into the unified
 * `ErrorCodes` const and re-exports the error primitives.
 *
 * Importing this module registers every domain's codes (each domain self-
 * registers on import). Throw sites and cross-domain consumers should import
 * from here: `import { ErrorCodes, KimiError } from '#/errors'`.
 */

import { CoreErrors } from '#/_base/errors';
import { AgentLifecycleErrors } from '#/agent-lifecycle/errors';
import { AuthErrors } from '#/auth/errors';
import { BackgroundErrors } from '#/background/errors';
import { ChatProviderErrors } from '#/chatProvider/errors';
import { ConfigErrors } from '#/config/errors';
import { FileErrors } from '#/filestore/errors';
import { FsErrors } from '#/agentFs/errors';
import { FullCompactionErrors } from '#/fullCompaction/errors';
import { GoalErrors } from '#/goal/errors';
import { LoopErrors } from '#/loop/errors';
import { McpErrors } from '#/mcp/errors';
import { ModelCatalogErrors } from '#/modelCatalog/errors';
import { PluginErrors } from '#/plugin/errors';
import { ProfileErrors } from '#/profile/errors';
import { PromptErrors } from '#/prompt/errors';
import { PromptLegacyErrors } from '#/promptLegacy/errors';
import { SessionErrors } from '#/session/errors';
import { SkillErrors } from '#/skill/errors';
import { TerminalErrors } from '#/terminal/errors';
import { TurnErrors } from '#/turn/errors';
import { WireRecordErrors } from '#/wireRecord/errors';

export * from '#/_base/errors';
export { AgentLifecycleErrors } from '#/agent-lifecycle/errors';
export { AuthErrors } from '#/auth/errors';
export { BackgroundErrors } from '#/background/errors';
export { ChatProviderErrors } from '#/chatProvider/errors';
export { ConfigErrors } from '#/config/errors';
export { FileErrors } from '#/filestore/errors';
export { FsErrors } from '#/agentFs/errors';
export { FullCompactionErrors } from '#/fullCompaction/errors';
export { GoalErrors } from '#/goal/errors';
export { LoopErrors } from '#/loop/errors';
export { McpErrors } from '#/mcp/errors';
export { ModelCatalogErrors } from '#/modelCatalog/errors';
export { PluginErrors } from '#/plugin/errors';
export { ProfileErrors } from '#/profile/errors';
export { PromptErrors } from '#/prompt/errors';
export { PromptLegacyErrors } from '#/promptLegacy/errors';
export { SessionErrors } from '#/session/errors';
export { SkillErrors } from '#/skill/errors';
export { TerminalErrors } from '#/terminal/errors';
export { TurnErrors } from '#/turn/errors';
export { WireRecordErrors } from '#/wireRecord/errors';

export const ErrorCodes = {
  ...CoreErrors.codes,
  ...AgentLifecycleErrors.codes,
  ...AuthErrors.codes,
  ...BackgroundErrors.codes,
  ...ChatProviderErrors.codes,
  ...ConfigErrors.codes,
  ...FileErrors.codes,
  ...FsErrors.codes,
  ...FullCompactionErrors.codes,
  ...GoalErrors.codes,
  ...LoopErrors.codes,
  ...McpErrors.codes,
  ...ModelCatalogErrors.codes,
  ...PluginErrors.codes,
  ...ProfileErrors.codes,
  ...PromptErrors.codes,
  ...PromptLegacyErrors.codes,
  ...SessionErrors.codes,
  ...SkillErrors.codes,
  ...TerminalErrors.codes,
  ...TurnErrors.codes,
  ...WireRecordErrors.codes,
} as const;
