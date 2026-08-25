/**
 * TUI2 public surface.
 *
 * The tui2 tree hosts real opentui + SolidJS implementations for the
 * interactive shell (store-driven, no pi-tui Containers). This index keeps
 * the same external shape as v1 so callers (the CLI entry, the web
 * harness) never need to update, while the internals swap to tui2
 * modules. The handful of not-yet-migrated utility modules forward to
 * v1 (stub layers); the interactive components are all tui2-native.
 *
 * The env switch lives in `tui2/env.ts` -- this file is reached only
 * when the variant is already resolved to v2.
 */
export * from './kimi-tui'
export type { KimiTUIStartupInput, KimiTUIOptions, Tui2Terminal } from './kimi-tui'
export { isTuiV2Enabled, resolveTuiVariant, type TuiVariant } from './env'