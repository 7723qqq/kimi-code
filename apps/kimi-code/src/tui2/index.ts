/**
 * TUI2 public surface.
 *
 * In the current skeleton, every module under `tui2/` re-exports the
 * matching `tui/` module, so the public surface is identical to v1.
 * As real tui2 implementations land, this index keeps the same shape
 * and only the internal re-exports change. External callers (the CLI
 * entry, the web harness) never need to update.
 *
 * The env switch lives in `tui2/env.ts` -- this file is reached only
 * when the variant is already resolved to v2.
 */
export * from './kimi-tui'
export type { KimiTUIStartupInput, KimiTUIOptions, Tui2Terminal } from './kimi-tui'
export { isTuiV2Enabled, resolveTuiVariant, type TuiVariant } from './env'