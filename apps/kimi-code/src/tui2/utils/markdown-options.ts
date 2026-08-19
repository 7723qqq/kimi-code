/**
 * TUI2 shared Markdown behavior options (distinct from the visual theme).
 *
 * Mirrors `tui/utils/markdown-options.ts` — holds the process-wide LaTeX
 * toggle from tui.toml so transcript components don't each need the config
 * threaded through construction.
 *
 * Status: REAL (tui2). Mirrors `tui/utils/markdown-options.ts`.
 */

import type { MarkdownOptions } from '@moonshot-ai/pi-tui';

// Default on, matching upstream pi-tui; overridden from tui.toml at startup
// and on /reload.
let renderLatex = true;

export function setMarkdownRenderLatex(value: boolean): void {
  renderLatex = value;
}

export function createMarkdownOptions(): MarkdownOptions {
  return { renderLatex };
}
