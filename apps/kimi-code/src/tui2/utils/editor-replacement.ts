/**
 * Command-layer editor replacement helpers.
 *
 * Mirrors v1 `host.mountEditorReplacement(panel)` / `host.restoreEditor()`
 * with the response store as the mount point: slash commands set
 * `store.state.editorReplacement` (component + props) and MainShell renders
 * it in the editor slot. The command's onSelect / onCancel callbacks clear
 * it (and carry the Promise resolution).
 *
 * Status: REAL (tui2). New helper — no v1 counterpart.
 */

import type { JSX } from 'solid-js';

import type { SlashCommandHost } from '../commands/dispatch';

export type ReplacementComponent = (props: Record<string, unknown>) => JSX.Element;

/** Mount a component in the editor slot (v1 `mountEditorReplacement`). */
export function mountEditorReplacement(
  host: SlashCommandHost,
  component: ReplacementComponent,
  props: Record<string, unknown>,
): void {
  host.store?.setState('editorReplacement', { component, props });
}

/** Clear the editor replacement, restoring the normal editor (v1 `restoreEditor`). */
export function restoreEditor(host: SlashCommandHost): void {
  host.store?.setState('editorReplacement', undefined);
}

/** Cast a typed SolidJS component to the replacement slot shape. */
export function asReplacement<Props>(component: (props: Props) => JSX.Element): ReplacementComponent {
  return component as unknown as ReplacementComponent;
}
