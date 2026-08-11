/** localized from retired @moonshot-ai/migration-legacy (G-6) */
// Localized entry: dependency closure of
// apps/vscode/src/migration/legacy-migration.manager.ts. The package's
// `prompt.ts` (CLI-interactive scopes) is not part of this closure.

export * from './types.js';
export { detectMigration } from './detect.js';
export {
  shouldSuppressMigration,
  type MigrationSuppressionInput,
} from './marker.js';
export { runMigration, type RunMigrationInput } from './run-migration.js';
