/**
 * TUI2 editor paste markers.
 *
 * Multi-line / oversized terminal pastes used to be flattened into the
 * single-line input (newlines stripped), silently mangling the content.
 * Mirroring v1 (`tui/components/editor/custom-editor.ts` + pi-tui
 * Editor.handlePaste), a large paste is instead stored in a registry and a
 * `[paste #N (+X lines|Y chars)]` marker is inserted into the draft; the
 * marker is expanded back to the full content on submit / steer / live
 * `/goal` length checks via {@link PasteRegistry.expand}.
 *
 * The registry is keyed by the response store so the editor component (which
 * inserts markers on paste) and the editor-keyboard controller (which expands
 * them before dispatch) share one instance per shell without threading state
 * through component props.
 *
 * Status: REAL (tui2). New file — mirrors pi-tui/v1 semantics.
 */

import type { Tui2Store } from '../../state';

/** Pastes longer than this many characters become markers (pi-tui threshold). */
export const PASTE_MARKER_THRESHOLD_CHARS = 1000;

/** Matches `[paste #1]`, `[paste #2 +12 lines]` and `[paste #3 456 chars]`. */
export const PASTE_MARKER_RE = /\[paste #(\d+)(?: (?:\+\d+ lines|\d+ chars))?\]/g;

export interface PasteRegistry {
  /** Store `content` and return the marker text to insert into the draft. */
  insert(content: string): string;
  /** Replace every known marker in `text` with its stored content. */
  expand(text: string): string;
  /** Drop all stored pastes (the draft holding them was discarded). */
  clear(): void;
}

export function createPasteRegistry(): PasteRegistry {
  const pastes = new Map<number, string>();
  let counter = 0;
  return {
    insert(content) {
      counter += 1;
      const id = counter;
      const lineCount = content.split('\n').length;
      pastes.set(id, content);
      return lineCount > 1
        ? `[paste #${String(id)} +${String(lineCount)} lines]`
        : `[paste #${String(id)} ${String(content.length)} chars]`;
    },
    expand(text) {
      if (!text.includes('[paste #')) return text;
      return text.replace(PASTE_MARKER_RE, (marker, id: string) => {
        return pastes.get(Number(id)) ?? marker;
      });
    },
    clear() {
      pastes.clear();
      counter = 0;
    },
  };
}

const registries = new WeakMap<Tui2Store, PasteRegistry>();

/** Per-shell shared registry (editor component + keyboard controller). */
export function getPasteRegistry(store: Tui2Store): PasteRegistry {
  const existing = registries.get(store);
  if (existing !== undefined) return existing;
  const created = createPasteRegistry();
  registries.set(store, created);
  return created;
}

/**
 * Whether a paste must become a marker: anything multi-line (the tui2 input
 * is single-line and would otherwise be flattened) or over the size threshold.
 */
export function pasteNeedsMarker(content: string): boolean {
  return content.includes('\n') || content.length > PASTE_MARKER_THRESHOLD_CHARS;
}

/**
 * Normalize raw clipboard text the way pi-tui does before storing: strip
 * carriage returns from CRLF pairs and drop non-printable control characters
 * except newlines.
 */
export function normalizePastedText(text: string): string {
  return text
    .replaceAll('\r\n', '\n')
    .split('')
    .filter((char) => char === '\n' || (char.codePointAt(0) ?? 0) >= 32)
    .join('');
}
