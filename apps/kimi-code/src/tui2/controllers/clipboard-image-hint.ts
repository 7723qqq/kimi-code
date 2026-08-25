/**
 * TUI2 clipboard image hint controller — transient footer hint when the
 * clipboard holds an image the model can ingest.
 *
 * Mirrors `tui/controllers/clipboard-image-hint.ts` with the pi-tui `TUI` /
 * `FooterComponent` host swapped for a raw-input listener + the response
 * store's `footerTransientHint` slice.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import { t } from '#/i18n';
import { clipboardHasImage } from '#/utils/clipboard/clipboard-has-image';

import { FOCUS_DEBOUNCE_MS, HINT_DISPLAY_MS } from '../constant/clipboard-image-hint';
import type { Tui2Store } from '../state';
import { TERMINAL_FOCUS_IN, TERMINAL_FOCUS_OUT } from '../utils/terminal-focus';

export interface ClipboardImageHintHost {
  readonly store: Tui2Store;
  /** Register a raw input listener; returns an unsubscribe function. */
  onRawInput(listener: (data: string) => void): () => void;
  getModelSupportsImage(): boolean;
}

export interface ClipboardImageHintController {
  start(): void;
  stop(): void;
}

function getPasteImageShortcut(): string {
  return process.platform === 'win32' ? 'Alt+V' : 'Ctrl+V';
}

export function createClipboardImageHintController(
  host: ClipboardImageHintHost,
): ClipboardImageHintController {
  let disposeInputListener: (() => void) | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let clearHintTimer: ReturnType<typeof setTimeout> | undefined;
  let lastHintText: string | undefined;
  let checkGeneration = 0;
  let focused = true;
  // Whether the controller has completed its first clipboard observation since
  // start. The first observation only establishes a baseline: an image already
  // in the clipboard when the session starts is not "new", so it must not
  // trigger a hint during initialization.
  let initialized = false;
  // Whether a detected clipboard image is allowed to trigger a hint. After
  // showing a hint for an image it disarms so the same lingering image does
  // not nag on every focus. A focus check that finds the clipboard empty
  // re-arms it, so the next genuinely new image notifies again.
  let armed = true;

  const clearDebounceTimer = (): void => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
  };

  const clearClearHintTimer = (): void => {
    if (clearHintTimer !== undefined) {
      clearTimeout(clearHintTimer);
      clearHintTimer = undefined;
    }
  };

  const clearOwnedHint = (): void => {
    if (host.store.state.footerTransientHint === lastHintText) {
      host.store.setState('footerTransientHint', null);
    }
    lastHintText = undefined;
  };

  const handleInput = (data: string): void => {
    if (data === TERMINAL_FOCUS_IN) {
      focused = true;
      scheduleCheck();
      return;
    }
    if (data === TERMINAL_FOCUS_OUT) {
      focused = false;
      clearDebounceTimer();
      return;
    }
  };

  const scheduleCheck = (): void => {
    clearDebounceTimer();
    checkGeneration += 1;
    const generation = checkGeneration;
    debounceTimer = setTimeout(() => void runCheck(generation), FOCUS_DEBOUNCE_MS);
  };

  const establishInitialBaseline = async (): Promise<void> => {
    if (!host.getModelSupportsImage()) return;

    checkGeneration += 1;
    const generation = checkGeneration;

    let hasImage = false;
    try {
      hasImage = await clipboardHasImage();
    } catch {
      return;
    }

    if (generation !== checkGeneration) return;

    initialized = true;
    armed = !hasImage;
  };

  const runCheck = async (generation: number): Promise<void> => {
    if (!focused) return;
    if (!host.getModelSupportsImage()) return;

    let hasImage = false;
    try {
      hasImage = await clipboardHasImage();
    } catch {
      return;
    }

    if (generation !== checkGeneration) return;
    if (!focused) return;

    // First observation after start only establishes the baseline. An image
    // already in the clipboard when the session began is not "new", so we
    // record the state and stay quiet instead of nagging during initialization.
    if (!initialized) {
      initialized = true;
      armed = !hasImage;
      return;
    }

    if (!hasImage) {
      // Clipboard holds no image, so the next image that appears is a new one
      // worth notifying about. Re-arm and bail out.
      armed = true;
      return;
    }

    // Same image we already notified about — stay quiet until it changes.
    if (!armed) return;

    const hintText = t('tui.messages.clipboardImageHint', { shortcut: getPasteImageShortcut() });
    clearClearHintTimer();
    lastHintText = hintText;
    armed = false;
    host.store.setState('footerTransientHint', hintText);

    clearHintTimer = setTimeout(() => {
      clearOwnedHint();
    }, HINT_DISPLAY_MS);
  };

  return {
    start(): void {
      disposeInputListener = host.onRawInput(handleInput);
      void establishInitialBaseline();
    },
    stop(): void {
      clearDebounceTimer();
      clearClearHintTimer();
      disposeInputListener?.();
      disposeInputListener = undefined;

      checkGeneration += 1;
      clearOwnedHint();
      initialized = false;
      armed = true;
    },
  };
}
