import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@moonshot-ai/pi-tui';

/** A single-line label that answers a primary click when it has an action. */
export class ButtonComponent implements Component {
  private width = 0;

  constructor(
    private readonly text: string | (() => string),
    private readonly onClick?: () => void,
  ) {}

  get labelWidth(): number {
    return visibleWidth(this.label());
  }

  private label(): string {
    return typeof this.text === 'function' ? this.text() : this.text;
  }

  render(width: number): string[] {
    this.width = this.labelWidth;
    return [truncateToWidth(this.label(), Math.max(1, width), '…')];
  }

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.onClick === undefined) return undefined;
    if (event.type !== 'click' || event.button !== 'left') return undefined;
    if (event.y !== 0 || event.x < 0 || event.x >= this.width) return undefined;
    this.onClick();
    return { handled: true };
  }
}

export interface ButtonRowItem {
  readonly text: string;
  readonly onClick?: () => void;
  /** Columns before the next item; defaults to the row gap. */
  readonly gapAfter?: number;
}

interface ButtonRowHit {
  readonly start: number;
  readonly end: number;
  readonly button: ButtonComponent;
}

/**
 * A horizontal row of buttons separated by a gap.
 *
 * Each label is its own `ButtonComponent`, which owns its hit area; the row
 * only translates the pointer into the child's frame, the same way a vertical
 * container does. A label without an action renders as static text.
 */
export class ButtonRow implements Component {
  private readonly buttons: readonly {
    readonly button: ButtonComponent;
    readonly gapAfter: number;
  }[];
  private readonly gap: number;
  private hits: readonly ButtonRowHit[] = [];

  constructor(items: readonly ButtonRowItem[], gap = 2) {
    this.gap = gap;
    this.buttons = items.map((item) => ({
      button: new ButtonComponent(item.text, item.onClick),
      gapAfter: item.gapAfter ?? gap,
    }));
  }

  renderLine(): string {
    const hits: ButtonRowHit[] = [];
    let line = '';
    let x = 0;
    for (let index = 0; index < this.buttons.length; index++) {
      const { button, gapAfter } = this.buttons[index]!;
      const text = button.render(button.labelWidth)[0] ?? '';
      hits.push({ start: x, end: x + button.labelWidth, button });
      line += text;
      x += button.labelWidth;
      if (index < this.buttons.length - 1) {
        line += ' '.repeat(Math.max(0, gapAfter));
        x += Math.max(0, gapAfter);
      }
    }
    this.hits = hits;
    return line;
  }

  render(width: number): string[] {
    return [truncateToWidth(this.renderLine(), Math.max(1, width), '…')];
  }

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== 'click' || event.button !== 'left') return undefined;
    const hit = this.hits.find(
      (candidate) => event.x >= candidate.start && event.x < candidate.end,
    );
    if (hit === undefined) return undefined;
    return hit.button.handleMouse({
      ...event,
      x: event.x - hit.start,
      y: 0,
      width: hit.end - hit.start,
      height: 1,
    });
  }
}
