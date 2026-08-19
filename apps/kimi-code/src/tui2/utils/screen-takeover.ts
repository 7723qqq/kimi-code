/**
 * TUI2 mode-aware full-screen viewer takeover.
 *
 * Mirrors `tui/utils/screen-takeover.ts`. The tui2 shell renders through the
 * opentui reconciler (no imperative root swapping), so takeovers are
 * no-ops kept for export compatibility with the v1 surface.
 *
 * Status: REAL (tui2). Mirrors `tui/utils/screen-takeover.ts`.
 */

import type { Component, TUI } from '@moonshot-ai/pi-tui';
import { TuiAltScreen } from '@moonshot-ai/pi-tui';

/** Restore data for a screen takeover; opaque to callers. */
export type ScreenTakeover =
  | { readonly kind: 'children'; readonly children: readonly Component[] }
  | { readonly kind: 'root'; readonly root: Component | undefined };

export function beginScreenTakeover(ui: TUI, viewer: Component): ScreenTakeover {
  if (ui instanceof TuiAltScreen) {
    const root = ui.getLayoutRoot();
    ui.setLayoutRoot(viewer);
    return { kind: 'root', root };
  }
  const children = [...ui.children];
  ui.clear();
  ui.addChild(viewer);
  return { kind: 'children', children };
}

export function endScreenTakeover(ui: TUI, takeover: ScreenTakeover): void {
  if (takeover.kind === 'root') {
    if (ui instanceof TuiAltScreen) ui.setLayoutRoot(takeover.root);
    return;
  }
  ui.clear();
  for (const child of takeover.children) ui.addChild(child);
}
