/**
 * TUI2 diff preview — forwarding layer.
 *
 * The diff-line computation is framework-agnostic utility code (the v1
 * implementation has no pi-tui component dependency), so the tui2 module
 * forwards to v1 until a dedicated tui2 implementation lands.
 *
 * Status: STUB (tui2). Re-exports v1.
 */
export * from '../../../tui/components/media/diff-preview'
