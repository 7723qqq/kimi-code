/**
 * Clickable — wraps render output as a declaratively clickable region.
 *
 * A component renders arbitrary content lines and marks the whole block as
 * clickable: `handleClick` fires `onClick` with the relative coordinates, and
 * `onHoverChange` reports pointer enter/leave. Unlike manual row-mapping
 * (`optionRows` maps), the component only declares *what* is clickable —
 * pi-tui's hit-testing routes the pointer automatically.
 */

import type { Component, TuiClickEvent } from '@moonshot-ai/pi-tui';

export interface ClickableOptions {
  /** Content lines rendered inside the clickable region. */
  readonly content: readonly string[];
  /** Fired when the region is clicked. Coordinates are relative to the region. */
  readonly onClick?: (x: number, y: number) => void;
  /** Fired when the pointer enters (true) / leaves (false) the region. */
  readonly onHover?: (hovered: boolean) => void;
}

export class Clickable implements Component {
  private readonly content: readonly string[];
  private readonly onClick: ((x: number, y: number) => void) | undefined;
  private readonly onHover: ((hovered: boolean) => void) | undefined;

  constructor(options: ClickableOptions) {
    this.content = options.content;
    this.onClick = options.onClick;
    this.onHover = options.onHover;
  }

  render(width: number): string[] {
    return this.content.map((line) =>
      line.length > width ? line.slice(0, Math.max(0, width)) : line,
    );
  }

  handleClick(event: TuiClickEvent): void {
    this.onClick?.(event.x, event.y);
  }

  onHoverChange(hovered: boolean, _x: number, _y: number): void {
    this.onHover?.(hovered);
  }

  invalidate(): void {}
}
