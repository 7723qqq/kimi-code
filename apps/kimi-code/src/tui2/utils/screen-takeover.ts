/**
 * TUI2 mode-aware full-screen viewer takeover.
 *
 * Mirrors `tui/utils/screen-takeover.ts`. The tui2 shell renders through the
 * opentui reconciler (no imperative root swapping), so takeovers are no-ops
 * kept for export compatibility with the v1 surface. Self-contained; no
 * pi-tui dependency.
 *
 * Status: REAL (tui2). Mirrors `tui/utils/screen-takeover.ts`.
 */

/** Restore data for a screen takeover; opaque to callers. */
export type ScreenTakeover = {
  readonly kind: 'children';
  readonly children: readonly unknown[];
};

export function beginScreenTakeover(_ui?: unknown, _viewer?: unknown): ScreenTakeover {
  return { kind: 'children', children: [] };
}

export function endScreenTakeover(_takeover?: unknown): void {}