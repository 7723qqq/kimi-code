import { Text, visibleWidth } from '@moonshot-ai/pi-tui';
import type { TUI } from '@moonshot-ai/pi-tui';

import { BRAILLE_SPINNER_FRAMES, MOON_LOADER_FRAME_MS, MOON_SPINNER_FRAMES } from '#/tui/constant/rendering';
import { currentTheme } from '#/tui/theme';

export type SpinnerStyle = 'moon' | 'braille';

/**
 * Animated frame spinner. `render()` is the standalone row; `renderInline()`
 * carries the frame alone for hosts that embed it into a line of their own (the
 * agent-swarm progress status line).
 *
 * Ownership: the constructor deliberately arms nothing. Whoever mounts the
 * loader — the activity pane, the MCP-connect rows, the login/progress rows, or
 * a test standing in for one of them — is its owner: it calls `start()` to begin
 * the frames and must call `stop()` (or `dispose()`) when the row goes away.
 * Frames advance on the TUI's shared animation clock, which is paused with the
 * renderer, so a loader that is built and never started is inert.
 */
export class MoonLoader extends Text {
  private currentFrame = 0;
  private startedAt = 0;
  private frameRequest: number | undefined;
  private ui: TUI;
  private frames: string[];
  private colorFn?: (s: string) => string;
  private label: string;
  private displayText = '';
  // Inline text used when the spinner is embedded into another line (e.g. the
  // agent-swarm progress status line). It intentionally excludes the tip: the
  // tip is only rendered when the loader sits on its own row in the activity
  // pane, otherwise it would get squeezed against whatever follows the inline
  // spinner (like the swarm progress bar).
  private inlineText = '';
  private tip: string = '';
  private availableWidth = 0;

  constructor(ui: TUI, style: SpinnerStyle = 'moon', colorFn?: (s: string) => string, label: string = '') {
    super('', 1, 0);
    this.ui = ui;
    this.frames = style === 'moon' ? [...MOON_SPINNER_FRAMES] : [...BRAILLE_SPINNER_FRAMES];
    this.colorFn = colorFn;
    this.label = label;
  }

  /**
   * Begin (or resume) the animation. Idempotent on purpose: owners call it
   * from paths that can re-run (a pane re-syncing a spinner it already holds),
   * and a second request would double the frame rate.
   */
  start(): void {
    if (this.frameRequest !== undefined) return;
    this.currentFrame = 0;
    this.startedAt = performance.now();
    this.updateDisplay();
    this.frameRequest = this.ui.requestAnimationFrame(this.onFrame);
  }

  stop(): void {
    if (this.frameRequest === undefined) return;
    this.ui.cancelAnimationFrame(this.frameRequest);
    this.frameRequest = undefined;
  }

  dispose(): void {
    this.stop();
  }

  get currentLabel(): string {
    return this.label;
  }

  setLabel(label: string): void {
    this.label = label;
    this.updateDisplay();
  }

  setColorFn(colorFn: (s: string) => string): void {
    this.colorFn = colorFn;
    this.updateDisplay();
  }

  setTip(tip: string): void {
    this.tip = tip;
    this.updateDisplay();
  }

  setAvailableWidth(width: number): void {
    if (this.availableWidth === width) return;
    this.availableWidth = width;
    this.updateDisplay();
  }

  renderInline(): string {
    return this.inlineText;
  }

  private readonly onFrame = (time: number): void => {
    const frame = Math.floor(Math.max(0, time - this.startedAt) / MOON_LOADER_FRAME_MS) % this.frames.length;
    if (frame !== this.currentFrame) {
      this.currentFrame = frame;
      this.updateDisplay();
    }
    this.frameRequest = this.ui.requestAnimationFrame(this.onFrame);
  };

  private updateDisplay(): void {
    const frame = this.frames[this.currentFrame]!;
    const coloredFrame = this.colorFn ? this.colorFn(frame) : frame;
    const baseText = this.label ? `${coloredFrame} ${this.label}` : coloredFrame;
    let text = baseText;
    if (this.tip) {
      const withTip = baseText + currentTheme.fg('textDim', this.tip);
      if (this.availableWidth === 0 || visibleWidth(withTip) <= this.availableWidth) {
        text = withTip;
      }
    }
    // Defensive no-op guard. Every setter funnels through here, and hosts
    // routinely re-apply a value they already hold (the activity pane re-syncs
    // the same label whenever it rebuilds a pane), so an unguarded call buys a
    // full TUI repaint for a row whose characters did not change. Both produced
    // strings are compared: an inline host paints from `renderInline()`, so a
    // changed inline frame is a change even when the standalone row is
    // identical.
    const changed = this.displayText !== text || this.inlineText !== baseText;
    this.inlineText = baseText;
    this.displayText = text;
    if (!changed) return;
    this.setText(this.displayText);
    this.ui.requestRender();
  }
}
