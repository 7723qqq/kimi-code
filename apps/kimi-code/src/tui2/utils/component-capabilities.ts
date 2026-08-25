/**
 * Framework-agnostic structural guards used to detect optional component
 * capabilities (`setExpanded`, `dispose`) without importing the renderer.
 *
 * Status: REAL (tui2). Self-contained; no v1 re-export.
 */

export interface Expandable {
  setExpanded(expanded: boolean): void;
}

export interface Disposable {
  dispose(): void;
}

export function isExpandable(obj: unknown): obj is Expandable {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'setExpanded' in obj &&
    typeof (obj as Expandable).setExpanded === 'function'
  );
}

export function hasDispose(value: unknown): value is Disposable {
  return (
    typeof value === 'object' &&
    value !== null &&
    'dispose' in value &&
    typeof (value as Disposable).dispose === 'function'
  );
}
