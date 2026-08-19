/**
 * Gutter container — NOT NEEDED in tui2.
 *
 * The v1 `GutterContainer` was a pi-tui `Container` subclass that reserved
 * left/right gutter columns around its children so the chrome (statusline,
 * transcript, panels) lined up with the input box's inner content area.
 * The opentui layout tree replaces this with plain `Box` padding — the
 * gutter width is `CHROME_GUTTER` in `tui2/constant/rendering.ts` and any
 * component applies it via `paddingLeft` / `paddingRight` on its own Box.
 * There is no container class to port, and no render cache to maintain:
 * the reconciler diffs the layout tree itself.
 *
 * The v1 class name is kept as a type-only marker so a leftover v1-shaped
 * import resolves to a documented no-op instead of a pi-tui dependency.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

/**
 * v1 `GutterContainer` — a pi-tui `Container` subclass. Not part of the
 * tui2 component vocabulary; use `Box` padding (see `CHROME_GUTTER` in
 * `tui2/constant/rendering.ts`) instead. The `never` type makes any
 * leftover `new GutterContainer(...)` call a compile error.
 */
export type GutterContainer = never;
