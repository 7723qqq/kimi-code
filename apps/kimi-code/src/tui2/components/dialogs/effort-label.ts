/**
 * Capitalised label for a thinking-effort segment.
 *
 * Mirrors `tui/components/dialogs/model-selector.ts`'s `effortLabel`.
 * Extracted as a tiny shared helper so the effort selector and any
 * future inline-thinking control can share the casing rule.
 *
 * Status: REAL (tui2). Mirrors v1 helper.
 */

export function effortLabel(effort: string): string {
  if (effort.length === 0) return effort;
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}