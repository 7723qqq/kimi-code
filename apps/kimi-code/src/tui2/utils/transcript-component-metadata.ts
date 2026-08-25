/**
 * TUI2 transcript component metadata — associate render objects with their
 * transcript entries.
 *
 * Mirrors `tui/utils/transcript-component-metadata.ts` without the pi-tui
 * `Component` type: the tui2 tree keys by plain object identity, so any
 * render handle (component instance, DOM node, …) can carry its entry.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { TranscriptEntry } from '../types';

const componentEntries = new WeakMap<object, TranscriptEntry>();

export function markTranscriptComponent(component: object, entry: TranscriptEntry): void {
  componentEntries.set(component, entry);
}

export function getTranscriptComponentEntry(component: object): TranscriptEntry | undefined {
  return componentEntries.get(component);
}
