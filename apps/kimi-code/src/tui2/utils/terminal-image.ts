/**
 * TUI2 terminal inline-image capabilities.
 *
 * Mirrors `packages/pi-tui/src/terminal-image.ts` for the parts the tui2 shell
 * needs (protocol detection + kitty image cleanup); the actual kitty/iterm2
 * encoding helpers live with the tui2 media renderers. Self-contained; no
 * pi-tui import.
 *
 * Status: REAL (tui2). Self-contained; mirrors the pi-tui detection logic.
 */

import { execSync } from 'node:child_process';

export type ImageProtocol = 'kitty' | 'iterm2' | null;

export interface TerminalCapabilities {
  images: ImageProtocol;
  trueColor: boolean;
  hyperlinks: boolean;
}

let cachedCapabilities: TerminalCapabilities | null = null;

/**
 * Checks whether the attached tmux client forwards OSC 8 hyperlinks to the
 * outer terminal. tmux only re-emits them when its `client_termfeatures` lists
 * `hyperlinks`, and strips them otherwise. On any error falls back `false`.
 */
function probeTmuxHyperlinks(): boolean {
  try {
    const termfeatures = execSync("tmux display-message -p '#{client_termfeatures}'", {
      encoding: 'utf8',
      timeout: 250,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return termfeatures
      .split(',')
      .map((feature) => feature.trim())
      .includes('hyperlinks');
  } catch {
    return false;
  }
}

export function detectCapabilities(
  tmuxForwardsHyperlink: () => boolean = probeTmuxHyperlinks,
): TerminalCapabilities {
  const termProgram = process.env['TERM_PROGRAM']?.toLowerCase() || '';
  const terminalEmulator = process.env['TERMINAL_EMULATOR']?.toLowerCase() || '';
  const term = process.env['TERM']?.toLowerCase() || '';
  const colorTerm = process.env['COLORTERM']?.toLowerCase() || '';
  const hasTrueColorHint = colorTerm === 'truecolor' || colorTerm === '24bit';
  const isWindowsConsole = process.platform === 'win32';

  // Emit OSC 8 hyperlinks only when tmux confirms it forwards.
  // Image protocols are unreliable under tmux, so leave `images: null`.
  if (process.env['TMUX'] || term.startsWith('tmux')) {
    return { images: null, trueColor: hasTrueColorHint, hyperlinks: tmuxForwardsHyperlink() };
  }

  // screen does not forward OSC 8 hyperlinks, so keep them off there.
  if (term.startsWith('screen')) {
    return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
  }

  if (process.env['KITTY_WINDOW_ID'] || termProgram === 'kitty') {
    return { images: 'kitty', trueColor: true, hyperlinks: true };
  }

  if (
    termProgram === 'ghostty' ||
    term.includes('ghostty') ||
    process.env['GHOSTTY_RESOURCES_DIR']
  ) {
    return { images: 'kitty', trueColor: true, hyperlinks: true };
  }

  if (process.env['WEZTERM_PANE'] || termProgram === 'wezterm') {
    return { images: 'kitty', trueColor: true, hyperlinks: true };
  }

  // Warp supports the Kitty graphics protocol and OSC 8 hyperlinks.
  if (
    termProgram === 'warpterminal' ||
    process.env['WARP_SESSION_ID'] ||
    process.env['WARP_TERMINAL_SESSION_UUID']
  ) {
    return { images: 'kitty', trueColor: true, hyperlinks: true };
  }

  if (process.env['ITERM_SESSION_ID'] || termProgram === 'iterm.app') {
    return { images: 'iterm2', trueColor: true, hyperlinks: true };
  }

  if (process.env['WT_SESSION']) {
    return { images: null, trueColor: true, hyperlinks: true };
  }

  if (termProgram === 'vscode') {
    return { images: null, trueColor: true, hyperlinks: true };
  }

  if (termProgram === 'alacritty') {
    return { images: null, trueColor: true, hyperlinks: true };
  }

  if (terminalEmulator === 'jetbrains-jediterm') {
    return { images: null, trueColor: true, hyperlinks: false };
  }

  // Windows Terminal does not always set WT_SESSION, for example when it hosts
  // a cmd.exe launched directly from Win+R. Modern Windows consoles support
  // truecolor; keep hyperlinks off unless we positively detected support above.
  if (isWindowsConsole) {
    return { images: null, trueColor: true, hyperlinks: false };
  }

  return { images: null, trueColor: hasTrueColorHint, hyperlinks: false };
}

export function getCapabilities(): TerminalCapabilities {
  if (!cachedCapabilities) {
    cachedCapabilities = detectCapabilities();
  }
  return cachedCapabilities;
}

export function resetCapabilitiesCache(): void {
  cachedCapabilities = null;
}

/** Override the cached capabilities. Useful in tests to exercise both paths. */
export function setCapabilities(caps: TerminalCapabilities): void {
  cachedCapabilities = caps;
}

/**
 * Delete all visible Kitty graphics images.
 * Uses uppercase 'A' to also free the image data.
 */
export function deleteAllKittyImages(): string {
  return '\x1B_Ga=d,d=A,q=2\x1B\\';
}