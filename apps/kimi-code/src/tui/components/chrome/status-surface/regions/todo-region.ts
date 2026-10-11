/**
 * TodoRegion — adapts {@link TodoPanelComponent} to the status surface.
 *
 * The adapter is deliberately thin: the panel keeps owning every pixel it
 * draws (milestone tree, progress meters, braille bar, flat-list selector, its
 * own fold hint). What the surface needs and a panel cannot answer on its own
 * is a **row cost** and a **fold predicate in row terms**, because those are
 * the numbers the shared budget divides and the ones the host's `ctrl+t`
 * gate reads.
 *
 * Both come from the panel's own structure, so the predicate and the paint
 * cannot disagree — the previous implementation asked a different question
 * (`the list has more than five items`) and advertised a fold the key then
 * refused to perform.
 */

import { TodoPanelComponent, type TodoItem } from '../../todo-panel';
import type {
  RegionId,
  RegionKey,
  RegionMouseEvent,
  RegionPlacement,
  RegionRenderContext,
  StatusRegion,
} from '../region';

export class TodoRegion implements StatusRegion {
  readonly id: RegionId = 'todo';
  private readonly panel: TodoPanelComponent;
  /** Installed by the surface when the region is registered. */
  onChange: (() => void) | undefined;

  readonly priority = 10;
  /** The todo list is read-only: it never holds up a submission. */
  readonly blocking = false;
  /**
   * With nothing focused, `Ctrl+T` and the arrow-key scroll fallback act on
   * the todo list. It is the region the user glances at while typing.
   */
  readonly defaultKeyTarget = true;

  constructor(panel: TodoPanelComponent) {
    this.panel = panel;
  }

  /** Shares the left column; the folded and expanded forms both fit. */
  placement(): RegionPlacement {
    return 'left';
  }

  /** The wrapped panel, for host paths that still address it by component. */
  panelComponent(): TodoPanelComponent {
    return this.panel;
  }

  isEmpty(): boolean {
    return this.panel.isEmpty();
  }

  /**
   * Rows the panel would like.
   *
   * Collapsed reports what it draws; expanded reports what the full list would
   * need so the surface grants enough for opening the fold to be worth the
   * keystroke. The surface clamps the number down, and over-reporting is the
   * safe direction.
   */
  measure(width: number): number {
    if (this.panel.isEmpty()) return 0;
    return this.panel.measureRows(width);
  }

  render(ctx: RegionRenderContext): string[] {
    this.panel.setBudget(ctx.budget);
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
      case 'toggle':
        if (!this.panel.hasHiddenContent()) return false;
        this.panel.setExpanded(!this.panel.isExpanded());
        return true;
      case 'up':
        return this.panel.isExpanded() ? this.panel.scrollBy(-1) : false;
      case 'down':
        return this.panel.isExpanded() ? this.panel.scrollBy(1) : false;
      default:
        return false;
    }
  }

  handleMouse(event: RegionMouseEvent): undefined {
    void event;
    return undefined;
  }

  /** The todo list is key-driven; a click folds it rather than claiming focus. */
  wantsFocus(): boolean {
    return false;
  }

  setTodos(todos: readonly TodoItem[]): void {
    this.panel.setTodos(todos);
    this.onChange?.();
  }

  getTodos(): readonly TodoItem[] {
    return this.panel.getTodos();
  }

  clear(): void {
    this.panel.clear();
    this.onChange?.();
  }
}
