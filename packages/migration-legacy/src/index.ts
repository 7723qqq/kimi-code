// Public API surface for the kimi-cli → kimi-code migration tool.

export * from './types.js';
export { detectMigration } from './detect.js';
export { shouldSuppressMigration, type MigrationSuppressionInput } from './marker.js';
export { runMigration, type RunMigrationInput } from './run-migration.js';
export {
  resolveMigrationScope,
  type MigrationPromptResult,
  type AnyChoice,
  type Prompt1Choice,
  type Prompt2Choice,
} from './prompt.js';
export * from './v2-home.js';
export {
  detectV2Data,
  formatReport,
  formatSubdirLine,
  type V2DetectReport,
  type V2SubdirReport,
} from './v2-detect.js';
export { exportV2Data, type V2ExportOptions, type V2ExportResult } from './v2-export.js';
