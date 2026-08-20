/** @jsxImportSource @opentui/solid */
/**
 * TUI2 moon/braille spinner.
 *
 * Replaces `tui/components/chrome/moon-loader.ts`'s `MoonLoader` (a pi-tui
 * `Text` subclass that owned a `setInterval` and called `ui.requestRender()`
 * on every frame) with a split design:
 *
 *   - `MoonLoader` — a framework-free spinner state machine (frames, label,
 *     tip, interval). It has no rendering dependency: consumers subscribe via
 *     `setOnChange` and read `renderInline()`. SolidJS views drive it through
 *     the reconciler instead of imperative repaints.
 *   - `MoonLoaderView` — the opentui SolidJS view. Mounting starts the
 *     spinner, unmounting disposes it, and each frame advance bumps a local
 *     signal so the reconciler repaints just this text node.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal, onCleanup, onMount } from 'solid-js'
import { visibleWidth } from '../../utils/width'
import type { ColorInput } from '@opentui/core'

import {
  BRAILLE_SPINNER_FRAMES,
  BRAILLE_SPINNER_INTERVAL_MS,
  MOON_SPINNER_FRAMES,
  MOON_SPINNER_INTERVAL_MS,
} from '../../constant/rendering'
import { currentTheme } from '../../theme'
import type { ColorToken } from '../../theme'

import { Text } from '../common/text'

export type SpinnerStyle = 'moon' | 'braille';

/**
 * Pure spinner state machine. No rendering, no timers beyond the frame
 * interval; `onChange` fires after every frame advance or label/tip change
 * so a host (SolidJS view or controller) can repaint.
 */
export class MoonLoader {
  private currentFrame = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private readonly frames: string[];
  private readonly interval: number;
  private label: string;
  private tip = '';
  private availableWidth = 0;
  private onChange: (() => void) | undefined;

  constructor(style: SpinnerStyle = 'moon', label = '') {
    this.frames = style === 'moon' ? [...MOON_SPINNER_FRAMES] : [...BRAILLE_SPINNER_FRAMES];
    this.interval = style === 'moon' ? MOON_SPINNER_INTERVAL_MS : BRAILLE_SPINNER_INTERVAL_MS;
    this.label = label;
  }

  /** Register a callback fired after every frame advance / content change. */
  setOnChange(callback: () => void): void {
    this.onChange = callback;
  }

  /** Index of the current frame in the style's frame list. */
  get frameIndex(): number {
    return this.currentFrame;
  }

  /** Current frame glyph. */
  get frame(): string {
    return this.frames[this.currentFrame]!;
  }

  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      this.onChange?.();
    }, this.interval);
    this.intervalId.unref?.();
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  dispose(): void {
    this.stop();
  }

  setLabel(label: string): void {
    this.label = label;
    this.onChange?.();
  }

  setTip(tip: string): void {
    this.tip = tip;
    this.onChange?.();
  }

  setAvailableWidth(width: number): void {
    if (this.availableWidth === width) return;
    this.availableWidth = width;
    this.onChange?.();
  }

  /**
   * Inline text: `frame + label` (label omitted when empty). The tip is
   * appended only when it fits within `availableWidth` (0 = unbounded) —
   * the tip is meant for the loader's own row, not for inline embedding.
   */
  renderInline(): string {
    const base = this.label ? `${this.frame} ${this.label}` : this.frame;
    if (this.tip.length === 0) return base;
    const withTip = `${base}${this.tip}`;
    if (this.availableWidth === 0 || visibleWidth(withTip) <= this.availableWidth) {
      return withTip;
    }
    return base;
  }
}

export interface MoonLoaderViewProps {
  readonly loader: MoonLoader;
  /** Color token for the spinner frame + label; defaults to `primary`. */
  readonly color?: ColorToken;
}

export const MoonLoaderView: Component<MoonLoaderViewProps> = (props) => {
  const [frame, setFrame] = createSignal(0)

  onMount(() => {
    props.loader.setOnChange(() => setFrame((v) => v + 1));
    props.loader.start();
  });
  onCleanup(() => {
    props.loader.dispose();
  });

  const fg = (): ColorInput => currentTheme.color(props.color ?? 'primary')
  const text = (): string => {
    // Read the frame signal so frame advances repaint this text node.
    void frame()
    return props.loader.renderInline()
  }
  return <Text fg={fg()}>{text()}</Text>
}
