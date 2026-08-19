/**
 * TUI2 shell output sanitizer — strip terminal control sequences from
 * captured command output.
 *
 * Mirrors `tui/utils/shell-output.ts` with imports converged onto the tui2
 * tree. Pure logic — no pi-tui dependency.
 *
 * Status: REAL (tui2). Mirrors `tui/utils/shell-output.ts`.
 */

import { t } from '#/i18n';

import type { ColorToken } from '../theme';

// Captured command output can contain terminal control sequences — colours,
// cursor moves, alternate-screen switches, hyperlinks, `\r` spinners, bells, …
// We render through the TUI, which passes strings straight to the terminal, so
// any sequence left intact is executed by the terminal and fights with the
// TUI's own cursor control (the "blank screen + leftover characters" symptom).
// Strip everything a terminal would interpret as a command rather than
// printable text, keeping only `\n` and `\t` (which the renderer understands).

// ESC [ <params> <intermediates> <final> — colours, cursor moves, clear, and
// private modes such as ESC[?1049h (alt screen) / ESC[?25l (hide cursor).
const CSI_PATTERN = /\u001B\[[0-9:;<=>?]*[ -/]*[@-~]/g;
// ESC ] … <BEL>  or  ESC ] … ESC \ — window titles and OSC 8 hyperlinks.
const OSC_PATTERN = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
// ESC <char> (and ESC <intermediate> <char>) — charset/keypad selection,
// save/restore cursor (ESC 7 / ESC 8), full reset (ESC c), etc. Runs after the
// CSI/OSC patterns, so it only catches sequences they didn't already consume.
const ESC_SINGLE_PATTERN = /\u001B(?:[ -/][0-~]|[0-~])/g;
// C0 control characters except \n (0x0A) and \t (0x09): NUL, BEL, \b, \r, …
// plus a lone ESC (0x1B) that wasn't part of a sequence recognised above.
const C0_CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001B\u001C-\u001F]/g;

/**
 * Strip every terminal control sequence from captured command output so it is
 * safe to render via the TUI (which does not sanitize on its own).
 *
 * Never throws: a bad or pathological input falls back to stripping only the
 * C0 control characters, so rendering can never crash the TUI.
 */
export function sanitizeShellOutput(text: string): string {
  if (typeof text !== 'string') return '';
  if (text.length === 0) return text;
  try {
    return text
      .replace(OSC_PATTERN, '')
      .replace(CSI_PATTERN, '')
      .replace(ESC_SINGLE_PATTERN, '')
      .replace(C0_CONTROL_PATTERN, '');
  } catch {
    return text.replace(C0_CONTROL_PATTERN, '');
  }
}

/**
 * Format captured stdout/stderr for the transcript. Sanitizes both streams;
 * stderr is flagged `error` only on actual failure (so warnings on a
 * successful command are not mistaken for errors). Returns plain text plus a
 * semantic color token — the tui2 renderer applies the color via the entry's
 * `color` field instead of embedding ANSI escapes.
 *
 * Never throws: if anything goes wrong (theme lookup, huge input, …) it falls
 * back to a best-effort plain view so a render error can never crash the TUI.
 */
export function formatBashOutputForDisplay(
  stdout: string,
  stderr: string,
  isError?: boolean,
): { text: string; color?: ColorToken } {
  try {
    const parts: string[] = [];
    const cleanStdout = sanitizeShellOutput(stdout).trimEnd();
    if (cleanStdout.length > 0) parts.push(cleanStdout);
    const cleanStderr = sanitizeShellOutput(stderr).trimEnd();
    if (cleanStderr.length > 0) parts.push(cleanStderr);
    if (parts.length === 0) return { text: t('tui.shellOutput.noOutput'), color: 'textDim' };
    return {
      text: parts.join('\n'),
      color: cleanStderr.length > 0 && isError === true ? 'error' : 'textDim',
    };
  } catch {
    const plain = [
      sanitizeShellOutput(String(stdout ?? '')),
      sanitizeShellOutput(String(stderr ?? '')),
    ]
      .filter((s) => s.length > 0)
      .join('\n');
    return plain.length > 0 ? { text: plain } : { text: t('tui.shellOutput.noOutput') };
  }
}
