/**
 * TUI2 editor input registry.
 *
 * Maps the response store to its live opentui `<input>` renderable so the
 * editor-keyboard controller can insert text at the real cursor position
 * (paste placeholders) without threading the renderable through props or
 * importing the SolidJS component into controller tests.
 *
 * The registry is keyed by the response store, mirroring paste-markers.ts.
 *
 * Status: REAL (tui2). New file.
 */

import type { InputRenderable } from '@opentui/core';

import type { Tui2Store } from '../../state';

const editorInputs = new WeakMap<Tui2Store, InputRenderable>();

/** Register/unregister the live input renderable for `store`'s editor. */
export function setEditorInput(store: Tui2Store, input: InputRenderable | undefined): void {
  if (input === undefined) {
    editorInputs.delete(store);
    return;
  }
  editorInputs.set(store, input);
}

/** The live input renderable, when its component is mounted. */
export function getEditorInput(store: Tui2Store): InputRenderable | undefined {
  return editorInputs.get(store);
}
