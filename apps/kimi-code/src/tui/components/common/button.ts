/**
 * TuiButton — a visible, clickable button element.
 *
 * Renders as `[ Label ]` in the accent color, highlights on hover, and fires
 * `onClick` when the user clicks anywhere on the button. Relies on pi-tui's
 * click/hover routing (`Component.handleClick` / `Component.onHoverChange`),
 * so it does not track press/release itself.
 */

import type { Component, TuiClickEvent } from '@moonshot-ai/pi-tui';

import { currentTheme, type ColorToken } from '#/tui/theme';

export interface TuiButtonOptions {
  readonly label: string;
  readonly onClick: () => void;
  /** Accent color token for the button text/border. Defaults to 'primary'. */
  readonly accent?: ColorToken;
  /** Optional style override for the whole button line. */
  readonly style?: (text: string, hovered: boolean) => string;
}

export class TuiButton implements Component {
  private readonly label: string;
  private readonly onClick: () => void;
  private readonly accent: ColorToken;
  private readonly style: ((text: string, hovered: boolean) => string) | undefined;
  private hovered = false;

  constructor(options: TuiButtonOptions) {
    this.label = options.label;
    this.onClick = options.onClick;
    this.accent = options.accent ?? 'primary';
    this.style = options.style;
  }

  /** Button text with the `[ Label ]` border. */
  text(): string {
    return `[ ${this.label} ]`;
  }

  render(_width: number): string[] {
    const bordered = this.text();
    if (this.style) return [this.style(bordered, this.hovered)];
    // Hover inverts the colors so the button reads as active.
    return this.hovered
      ? [currentTheme.bg(this.accent, currentTheme.fg('text', bordered))]
      : [currentTheme.fg(this.accent, bordered)];
  }

  handleClick(_event: TuiClickEvent): void {
    this.onClick();
  }

  onHoverChange(hovered: boolean, _x: number, _y: number): void {
    if (this.hovered === hovered) return;
    this.hovered = hovered;
  }

  invalidate(): void {}
}
