/**
 * TUI2 shared Markdown behavior options (distinct from the visual theme).
 *
 * Mirrors `tui/utils/markdown-options.ts` — holds the process-wide LaTeX
 * toggle from tui.toml so transcript components don't each need the config
 * threaded through construction.
 *
 * Status: REAL (tui2). Mirrors `tui/utils/markdown-options.ts`.
 */

/**
 * Markdown rendering options, mirrored from pi-tui so tui2 does not depend on
 * pi-tui for this type.
 */
export interface MarkdownOptions {
  /** Preserve source list markers instead of normalizing them. */
  preserveOrderedListMarkers?: boolean;
  /** Preserve source backslash escapes instead of normalizing escaped punctuation. */
  preserveBackslashEscapes?: boolean;
  /** Transform source Markdown before parsing, with the exact width available for content. */
  transform?: (markdown: string, availableWidth: number) => string;
  /** Render supported LaTeX math expressions as Unicode text (default: true). */
  renderLatex?: boolean;
}

// Default on, matching upstream pi-tui; overridden from tui.toml at startup
// and on /reload.
let renderLatex = true;

export function setMarkdownRenderLatex(value: boolean): void {
  renderLatex = value;
}

export function createMarkdownOptions(): MarkdownOptions {
  return { renderLatex };
}
