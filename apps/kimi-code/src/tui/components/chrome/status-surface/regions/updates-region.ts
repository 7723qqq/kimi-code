/**
 * UpdatesRegion — adapts {@link NotifyPanelComponent} to the status surface.
 *
 * The Updates box already implemented the full capability set (fold, focus,
 * scroll, tab-strip hit testing) because it was the only panel that had been
 * through this exercise. The adapter therefore mostly forwards: it states the
 * panel's row cost, hands it its budget, and translates surface keys into the
 * panel's own vocabulary.
 *
 * It is the region that claims focus: the user pages through updates with the
 * arrow keys, so a click on the box focuses it rather than folding it.
 */

import type { TuiMouseEventResult } from '@moonshot-ai/pi-tui';

import { NotifyPanelComponent } from '../../notify-panel';
import type {
  RegionId,
  RegionKey,
  RegionMouseEvent,
  RegionRenderContext,
  StatusRegion,
} from '../region';

export class UpdatesRegion implements StatusRegion {
  readonly id: RegionId = 'updates';
  private readonly panel: NotifyPanelComponent;
  /** Installed by the surface when the region is registered. */
  onChange: (() => void) | undefined;

  constructor(panel: NotifyPanelComponent) {
    this.panel = panel;
  }

  /** The wrapped panel, for the controller that owns the update projection. */
  panelComponent(): NotifyPanelComponent {
    return this.panel;
  }

  isEmpty(): boolean {
    return this.panel.isEmpty();
  }

  /**
   * Rows the box wants. The panel reports the number itself (it knows how tall
   * the displayed entry renders at this width), and adds the blank lead row it
   * draws above the box.
   */
  measure(width: number): number {
    if (this.panel.isEmpty()) return 0;
    return this.panel.measureHeight(width);
  }

  render(ctx: RegionRenderContext): string[] {
    return this.panel.render(ctx.width);
  }

  isExpanded(): boolean {
    return this.panel.isExpanded();
  }

  setExpanded(expanded: boolean): void {
    this.panel.setExpanded(expanded);
  }

  hasHiddenContent(): boolean {
    return this.panel.hasHiddenContent();
  }

  handleKey(key: RegionKey): boolean {
    switch (key) {
      case 'left':
        return this.panel.prevChannel();
      case 'right':
        return this.panel.nextChannel();
      case 'up':
        return this.panel.scrollBy(-1);
      case 'down':
        return this.panel.scrollBy(1);
      case 'pageUp':
        return this.panel.prevPage();
      case 'pageDown':
        return this.panel.nextPage();
      case 'escape':
        return this.panel.blur();
      case 'toggle':
        if (!this.panel.hasHiddenContent() && !this.panel.isExpanded()) return false;
        this.panel.setExpanded(!this.panel.isExpanded());
        return true;
      default:
        return false;
    }
  }

  handleMouse(event: RegionMouseEvent): TuiMouseEventResult | undefined {
    return this.panel.handleMouse(event.raw);
  }

  /** The user pages through updates, so a click here takes the keyboard. */
  wantsFocus(): boolean {
    return true;
  }

  /**
   * Mirror the surface's focus into the panel. The surface is the single owner
   * of "who has the keyboard"; the panel only needs it to style its border and
   * to keep its own scroll behaviour honest. Two independently-tracked focus
   * flags is what once produced a highlighted border over dead keys.
   */
  onFocus(): void {
    this.panel.focus();
  }

  onBlur(): void {
    this.panel.blur();
  }

  isFocused(): boolean {
    return this.panel.isFocused();
  }

  /** Marks the turn that produced these updates as over. */
  setEnded(ended: boolean): void {
    this.panel.setEnded(ended);
  }

  clear(): void {
    this.panel.clear();
    this.onChange?.();
  }
}
