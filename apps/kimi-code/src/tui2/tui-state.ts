/**
 * TUI2 state — response store entry.
 *
 * The v1 `TUIState` was an imperative pi-tui Container tree; the tui2
 * replacement is the SolidJS response store in `state.tsx`. This file is a
 * thin forwarding layer so callers can keep importing `tui2/tui-state`
 * while the tree migrates.
 *
 * Status: REAL (tui2). Forwards to `state.tsx`.
 */
export * from './state.tsx';
