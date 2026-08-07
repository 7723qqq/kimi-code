/**
 * Workspace file-index preheat.
 *
 * Preheats the workspace index off the hot path so the first Read tool call
 * can return an instant prediction. The native workspace index is not wired
 * in this build; the call degrades silently to precise reads — the same
 * fallback path a missing/broken native module would take.
 */
export function preheatWorkspaceIndex(_workDir: string): void {
  // No-op: the native workspace index is unavailable in this build.
}
