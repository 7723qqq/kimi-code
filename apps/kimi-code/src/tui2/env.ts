/**
 * TUI2 env switch.
 *
 * The TUI has two parallel implementations: the original pi-tui based
 * stack under `tui/` and the new opentui + SolidJS stack under `tui2/`.
 * Both implementations expose the same public surface (KimiTUI,
 * KimiTUIOptions, KimiTUIStartupInput, ...). Callers pick one via the
 * `KIMI_TUI` env var:
 *
 *   - unset / "v1"  (default)  -> tui/  (pi-tui)
 *   - "v2"                     -> tui2/ (opentui + SolidJS)
 *
 * The default stays on v1 until tui2/ reaches feature parity. The
 * skeleton of tui2/ currently re-exports the v1 surface, so flipping
 * the env var must not break the build. As real tui2 implementations
 * land, the env var becomes the rollout switch.
 *
 * Implementation note: this file is part of the "always-loaded" path
 * (imported by the CLI entry), so it must stay dependency-free of
 * opentui / solid-js. The whole point is that v1 keeps working even
 * when v2 is partially built.
 */

export type TuiVariant = 'v1' | 'v2'

const DEFAULT_VARIANT: TuiVariant = 'v1'

/**
 * Resolve the active TUI variant from the process environment.
 *
 * The lookup is intentionally permissive: any non-"v2" value (including
 * unset, empty, or typo'd values like "v3" / "true") falls back to v1.
 * Production rollouts flip a single env var, not arbitrary strings.
 */
export function resolveTuiVariant(env: NodeJS.ProcessEnv = process.env): TuiVariant {
  const raw = env['KIMI_TUI']
  if (typeof raw === 'string' && raw.toLowerCase() === 'v2') return 'v2'
  return DEFAULT_VARIANT
}

/**
 * True when the v2 (opentui + SolidJS) stack should serve the next
 * `new KimiTUI(...)` call. False for the default v1 (pi-tui) path.
 */
export function isTuiV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveTuiVariant(env) === 'v2'
}