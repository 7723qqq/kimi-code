// Public API surface for the kimi-cli → kimi-code migration tool.

// The task-kind declaration merges live in agent-core-v2's tool modules, which
// a subpath-only import graph may not reach; pull all three in for the checker.
import type {} from '@moonshot-ai/agent-core-v2/agent/tools/agent/subagent-task';
import type {} from '@moonshot-ai/agent-core-v2/agent/tools/ask-user-question/question-background-task';
import type {} from '@moonshot-ai/agent-core-v2/agent/tools/os/bash/process-task';

export * from './types.js';
export { detectMigration } from './detect.js';
export {
  shouldSuppressMigration,
  type MigrationSuppressionInput,
} from './marker.js';
export { defaultPlansSourceDir } from './steps/plans.js';
export { runMigration, type RunMigrationInput } from './run-migration.js';
export {
  resolveMigrationScope,
  type MigrationPromptResult,
  type AnyChoice,
  type Prompt1Choice,
  type Prompt2Choice,
} from './prompt.js';
