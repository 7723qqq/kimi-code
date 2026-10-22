import type { TuiMouseEvent } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { describe, expect, it, mock } from 'bun:test';

import {
  StatusSurfaceComponent,
  SURFACE_SIDE_PADDING,
} from '#/tui/components/chrome/status-surface/index';
import {
  type RegionId,
  type RegionPlacement,
  type RegionRenderContext,
  type StatusRegion,
} from '#/tui/components/chrome/status-surface/region';

interface FakeRegionOptions {
  readonly want?: number;
  readonly empty?: boolean;
  readonly hidden?: boolean;
  readonly lines?: (ctx: RegionRenderContext) => string[];
  readonly autoFocus?: boolean;
  readonly focusOnClick?: boolean;
  readonly handlesToggle?: boolean;
  /** Where the region asks to be drawn; defaults to the left column. */
  readonly placement?: RegionPlacement;
  readonly priority?: number;
  readonly blocking?: boolean;
  readonly defaultFocusTarget?: boolean;
  readonly defaultKeyTarget?: boolean;
}

class FakeRegion implements StatusRegion {
  readonly autoFocus: boolean | undefined;
  readonly priority: number;
  readonly blocking: boolean | undefined;
  readonly defaultFocusTarget: boolean | undefined;
  readonly defaultKeyTarget: boolean | undefined;
  expanded = false;
  expandedCalls: boolean[] = [];
  keyLog: string[] = [];
  mouseLog: string[] = [];
  measureCalls = 0;
  private readonly options: FakeRegionOptions;

  constructor(
    readonly id: RegionId,
    options: FakeRegionOptions = {},
  ) {
    this.options = options;
    this.autoFocus = options.autoFocus;
    this.priority = options.priority ?? 10;
    this.blocking = options.blocking;
    this.defaultFocusTarget = options.defaultFocusTarget;
    this.defaultKeyTarget = options.defaultKeyTarget;
  }

  placement(): RegionPlacement {
    return this.options.placement ?? 'left';
  }

  isEmpty(): boolean {
    return this.options.empty === true;
  }

  measure(_width: number): number {
    this.measureCalls += 1;
    return this.options.want ?? 3;
  }

  render(ctx: RegionRenderContext): string[] {
    if (this.options.lines !== undefined) return this.options.lines(ctx);
    const rows: string[] = [`${this.id}-header`];
    for (let i = 1; i < ctx.budget; i += 1) rows.push(`${this.id}-row-${i}`);
    return rows;
  }

  isExpanded(): boolean {
    return this.expanded;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.expandedCalls.push(expanded);
  }

  hasHiddenContent(): boolean {
    return this.options.hidden === true;
  }

  handleKey(key: string): boolean {
    this.keyLog.push(key);
    if (key === 'toggle' && this.options.handlesToggle === true) {
      this.setExpanded(!this.expanded);
      return true;
    }
    return false;
  }

  handleMouse(event: { x: number; y: number }): { handled: boolean } | undefined {
    this.mouseLog.push(`${event.x},${event.y}`);
    return undefined;
  }

  wantsFocus(): boolean {
    return this.options.focusOnClick === true;
  }
}

function click(x: number, y: number): TuiMouseEvent {
  return {
    type: 'click',
    button: 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

/**
 * The truecolor SGR of the first painted glyph on a row, at `chalk.level = 3`.
 *
 * Border colours are the one part of the frame a stripped render cannot check,
 * so the focus regression asserts on the escape itself.
 */
function sgrOf(line: string): string {
  return /\u001B\[([0-9;]*)m/.exec(line)?.[1] ?? 'none';
}

describe('StatusSurfaceComponent', () => {
  it('renders nothing while every region is empty', () => {
    const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
    surface.setRegion(new FakeRegion('todo', { empty: true }));
    surface.setRegion(new FakeRegion('updates', { empty: true }));

    expect(surface.isEmpty()).toBe(true);
    expect(surface.render(80)).toEqual([]);
  });

  it('never draws more rows than the budget allows', () => {
    for (let rows = 4; rows <= 80; rows += 1) {
      const surface = new StatusSurfaceComponent({ terminalRows: () => rows });
      surface.setRegion(new FakeRegion('approval', { want: 30 }));
      surface.setRegion(new FakeRegion('todo', { want: 30 }));
      surface.setRegion(new FakeRegion('updates', { want: 30 }));

      const out = surface.render(80);
      const cap = Math.min(20, Math.floor(rows / 2));
      expect(out.length).toBeLessThanOrEqual(cap);
    }
  });

  it('draws the one frame around its regions: borders, stacking rule and column divider', () => {
    const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
    surface.setRegion(new FakeRegion('approval', { want: 3, placement: 'full', priority: 0 }));
    surface.setRegion(new FakeRegion('todo', { want: 3, placement: 'left' }));
    surface.setRegion(new FakeRegion('updates', { want: 3, placement: 'right' }));
    const plain = surface
      .render(80)
      .map((line) => line.replace(/\u001b\[[0-9;]*m/g, '').replace(/\u001b\]8;;\u0007/g, ''));

    // The surface owns the frame: the top and bottom borders are its own.
    expect(plain[0]).toMatch(/^╭─+╮$/);
    expect(plain.at(-1)).toMatch(/^╰─+╯$/);
    // A stacked unit is separated by a tee rule, not by a second box.
    const rule = plain.findIndex((line) => line.startsWith('├'));
    expect(rule).toBeGreaterThan(0);
    expect(plain[rule]).toMatch(/^├─+┤$/);

    // The two column regions share the unit below the rule, side by side: the
    // frame's bars on both edges and one column divider between them, with each
    // region's own text on its side.
    const shared = plain[rule + 1]!;
    expect(shared).toMatch(/^│/);
    expect(shared).toMatch(/│$/);
    expect(shared.match(/│/g)).toHaveLength(3);
    expect(shared).toContain('todo-header');
    expect(shared).toContain('updates-header');
    // Top border + 3 approval rows + rule + 3 shared rows + bottom border.
    expect(plain).toHaveLength(9);
  });

  it('paints the bottom border with the focused unit, like the rest of the frame', () => {
    // The defect this replaces: the frame's bottom edge was painted with the
    // resting border colour unconditionally, so it was the one row that did not
    // follow when a focused region (an approval, which auto-focuses) was up —
    // the strip's box closed on a grey line under an amber one.
    const previousLevel = chalk.level;
    chalk.level = 3;
    try {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
      const region = new FakeRegion('todo', { want: 3, focusOnClick: true });
      surface.setRegion(region);

      const resting = surface.render(80);
      const restingTop = sgrOf(resting[0]!);
      const restingBottom = sgrOf(resting.at(-1)!);
      expect(restingTop).toBe(restingBottom);

      // Focus the region, which is what an arriving approval does; the whole
      // frame — top edge, side bars, bottom edge — switches together.
      expect(surface.focusRegion('todo')).toBe(true);
      const focused = surface.render(80);
      const focusedTop = sgrOf(focused[0]!);
      const focusedBottom = sgrOf(focused.at(-1)!);
      expect(focusedTop).toBe(focusedBottom);
      expect(focusedBottom).not.toBe(restingBottom);
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('orders approval above todo above updates regardless of registration order', () => {
    const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
    // Priority is declared by each region now, so the order is asserted
    // against the declarations rather than against a table the container
    // exported. Registration order is deliberately the reverse.
    surface.setRegion(new FakeRegion('updates', { want: 2, placement: 'right', priority: 20 }));
    surface.setRegion(new FakeRegion('todo', { want: 2, placement: 'left', priority: 10 }));
    surface.setRegion(new FakeRegion('approval', { want: 2, placement: 'full', priority: 0 }));

    const out = surface.render(80).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ''));
    // The approval declares a whole band, so it precedes the shared band the
    // other two sit in.
    const approvalIndex = out.findIndex((line) => line.includes('approval-header'));
    const todoIndex = out.findIndex((line) => line.includes('todo-header'));
    const updatesIndex = out.findIndex((line) => line.includes('updates-header'));
    expect(approvalIndex).toBeLessThan(todoIndex);
    // Side by side, both columns land on the same row below it.
    expect(todoIndex).toBe(updatesIndex);
    expect(updatesIndex).toBeGreaterThan(approvalIndex);
  });

  it('truncates a region that ignores its budget', () => {
    const surface = new StatusSurfaceComponent({ terminalRows: () => 12 });
    surface.setRegion(
      new FakeRegion('todo', {
        // Asks for everything, then returns far more rows than it was granted.
        want: 99,
        lines: () => Array.from({ length: 50 }, (_, i) => `line-${i}`),
      }),
    );
    const out = surface.render(80);
    // 12 rows -> total 6, minus the two frame rows for one region: 4 body rows.
    expect(out).toHaveLength(6);
  });

  it('reports a blocking region only while a blocking region has content', () => {
    const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
    // "Blocking" is a behaviour a region declares, not a name the container
    // knows: an empty region is not blocking even if it is the one that would
    // be, and a region that never declares it never blocks.
    const approval = new FakeRegion('approval', { want: 2, blocking: true });
    surface.setRegion(approval);
    expect(surface.hasBlockingRegion()).toBe(true);

    surface.setRegion(new FakeRegion('approval', { want: 2, empty: true, blocking: true }));
    expect(surface.hasBlockingRegion()).toBe(false);

    const surface2 = new StatusSurfaceComponent({ terminalRows: () => 24 });
    surface2.setRegion(new FakeRegion('todo', { want: 2 }));
    expect(surface2.hasBlockingRegion()).toBe(false);
  });

  it('refuses to focus an empty region', () => {
    const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
    surface.setRegion(new FakeRegion('todo', { empty: true }));
    expect(surface.focusRegion('todo')).toBe(false);
    expect(surface.focusedRegion()).toBeNull();
  });

  it('auto-focuses a region that declares it', () => {
    const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
    surface.setRegion(new FakeRegion('approval', { want: 2, autoFocus: true }));
    expect(surface.focusedRegion()).toBe('approval');
  });

  it('drops focus when the focused region becomes empty', () => {
    const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
    surface.setRegion(new FakeRegion('updates', { want: 2 }));
    surface.focusRegion('updates');
    expect(surface.focusedRegion()).toBe('updates');

    surface.setRegion(new FakeRegion('updates', { want: 2, empty: true }));
    expect(surface.focusedRegion()).toBeNull();
  });

  describe('folding', () => {
    it('expands a collapsed region on toggle', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
      const todo = new FakeRegion('todo', { want: 2, hidden: true });
      surface.setRegion(todo);
      expect(todo.expanded).toBe(false);

      expect(surface.toggleFold('todo')).toBe(true);
      expect(todo.expanded).toBe(true);
    });

    it('refuses to collapse when folding would hide nothing', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
      const todo = new FakeRegion('todo', { want: 2, hidden: false });
      surface.setRegion(todo);
      surface.toggleFold('todo');
      expect(todo.expanded).toBe(true);

      expect(surface.toggleFold('todo')).toBe(false);
      expect(todo.expanded).toBe(true);
    });

    it('reports the untouched key so the editor keeps its default binding', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
      const todo = new FakeRegion('todo', { want: 2, hidden: false });
      surface.setRegion(todo);
      surface.toggleFold('todo');

      expect(surface.handleKey('toggle')).toBe(false);
    });

    it('consumes the toggle key when it actually folds something', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
      // The region that declared itself the strip's default key target.
      surface.setRegion(new FakeRegion('todo', { want: 2, hidden: true, defaultKeyTarget: true }));
      expect(surface.handleKey('toggle')).toBe(true);
    });

    it('ignores the toggle when no region declared the default', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
      // Nothing declared `defaultKeyTarget`, so there is no answer to "with no
      // focus, what does the user mean?" and the key goes back to the editor.
      surface.setRegion(new FakeRegion('updates', { want: 2, hidden: true }));
      expect(surface.handleKey('toggle')).toBe(false);
    });

    it('folds the focused region in preference to the default', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
      const todo = new FakeRegion('todo', { want: 2, hidden: true, defaultKeyTarget: true });
      const approval = new FakeRegion('approval', {
        want: 2,
        hidden: true,
        autoFocus: true,
        handlesToggle: true,
      });
      surface.setRegion(todo);
      surface.setRegion(approval);

      // The approval owns the keyboard while it is up, so the fold key has to
      // reach it. Routing the key straight at the todo region instead left a
      // folded approval prompt with no way to open it.
      expect(surface.handleKey('toggle')).toBe(true);
      expect(approval.expanded).toBe(true);
      expect(todo.expanded).toBe(false);
    });

    it('falls back to the declared default when the focused region declines the key', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
      const todo = new FakeRegion('todo', { want: 2, hidden: true, defaultKeyTarget: true });
      // Focused, but with nothing to fold — like the Updates box when it is
      // already fully visible. It declines the key, so the declared default
      // takes it.
      const updates = new FakeRegion('updates', { want: 2, hidden: false, autoFocus: true });
      surface.setRegion(todo);
      surface.setRegion(updates);

      expect(surface.handleKey('toggle')).toBe(true);
      expect(todo.expanded).toBe(true);
      expect(updates.expanded).toBe(false);
    });
  });

  describe('column cycling', () => {
    it('moves the keyboard to the other column', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
      const todo = new FakeRegion('todo', { want: 3, placement: 'left' });
      const updates = new FakeRegion('updates', { want: 3, placement: 'right' });
      surface.setRegion(todo);
      surface.setRegion(updates);
      surface.render(80);
      surface.focusRegion('todo');

      expect(surface.handleStatusSurfaceKey('cycleColumn')).toBe(true);
      expect(surface.focusedRegion()).toBe('updates');

      expect(surface.handleStatusSurfaceKey('cycleColumn')).toBe(true);
      expect(surface.focusedRegion()).toBe('todo');
    });

    it('declines when the strip has no focus, so Tab keeps its editor binding', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
      surface.setRegion(new FakeRegion('todo', { want: 3, placement: 'left' }));
      surface.setRegion(new FakeRegion('updates', { want: 3, placement: 'right' }));
      surface.render(80);

      expect(surface.focusedRegion()).toBeNull();
      expect(surface.handleStatusSurfaceKey('cycleColumn')).toBe(false);
    });

    it('still cycles when the split has collapsed, because placement is declared', () => {
      // Narrow terminal: both columns fall back to the full width and the
      // regions stack. Cycling answers "which region", not "which pixel", so it
      // keeps working — the columns are a drawing decision, the target is a
      // declared one.
      const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
      const todo = new FakeRegion('todo', { want: 3, placement: 'left' });
      const updates = new FakeRegion('updates', { want: 3, placement: 'right' });
      surface.setRegion(todo);
      surface.setRegion(updates);
      surface.render(40);
      // Content starts past the frame's bar and its padding cell.
      expect(surface.regionRects().every((entry) => entry.col === SURFACE_SIDE_PADDING + 1)).toBe(
        true,
      );

      surface.focusRegion('todo');
      expect(surface.handleStatusSurfaceKey('cycleColumn')).toBe(true);
      expect(surface.focusedRegion()).toBe('updates');
    });

    it('moves from a full-width region into the first column with content', () => {
      // An approval is full-width and auto-focused. Answering "no neighbour"
      // would trap the keyboard there for as long as the request was up: Tab
      // would do nothing and Escape rejects rather than releasing focus.
      const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
      const todo = new FakeRegion('todo', { want: 3, placement: 'left' });
      const updates = new FakeRegion('updates', { want: 3, placement: 'right' });
      const approval = new FakeRegion('approval', {
        want: 3,
        placement: 'full',
        autoFocus: true,
        priority: 0,
      });
      surface.setRegion(todo);
      surface.setRegion(updates);
      surface.setRegion(approval);
      surface.render(80);
      expect(surface.focusedRegion()).toBe('approval');

      expect(surface.handleStatusSurfaceKey('cycleColumn')).toBe(true);
      expect(surface.focusedRegion()).toBe('todo');
    });

    it('declines from a full-width region when no column has content', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
      const approval = new FakeRegion('approval', { want: 3, placement: 'full', autoFocus: true });
      surface.setRegion(approval);
      surface.render(80);

      expect(surface.handleStatusSurfaceKey('cycleColumn')).toBe(false);
      expect(surface.focusedRegion()).toBe('approval');
    });
  });

  describe('focus routing', () => {
    it('delivers keys to the focused region only', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
      const todo = new FakeRegion('todo', { want: 2 });
      const updates = new FakeRegion('updates', { want: 2 });
      surface.setRegion(todo);
      surface.setRegion(updates);
      surface.focusRegion('updates');

      surface.handleKey('pageDown');

      expect(updates.keyLog).toEqual(['pageDown']);
      expect(todo.keyLog).toEqual([]);
    });

    it('clears focus on escape so the editor receives the next one', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
      surface.setRegion(new FakeRegion('updates', { want: 2 }));
      surface.focusRegion('updates');

      expect(surface.handleKey('escape')).toBe(true);
      expect(surface.focusedRegion()).toBeNull();
      expect(surface.handleKey('escape')).toBe(false);
    });
  });

  describe('mouse', () => {
    it('translates row and column coordinates into region-local ones', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
      const todo = new FakeRegion('todo', { want: 3, placement: 'left' });
      const updates = new FakeRegion('updates', { want: 3, placement: 'right' });
      surface.setRegion(todo);
      surface.setRegion(updates);
      surface.render(80);

      const rects = surface.regionRects();
      const updatesRect = rects.find((rect) => rect.id === 'updates');
      expect(updatesRect).toBeDefined();

      // The two sit side by side, so the same row belongs to both: a click
      // in the right column reaches updates, and one in the left reaches todo.
      surface.handleMouse(click(updatesRect!.col + 2, updatesRect!.from));
      expect(updates.mouseLog).toEqual(['2,0']);
      expect(todo.mouseLog).toEqual([]);

      const todoRect = rects.find((rect) => rect.id === 'todo');
      surface.handleMouse(click(todoRect!.col + 1, todoRect!.from));
      expect(todo.mouseLog).toEqual(['1,0']);
      expect(updates.mouseLog).toEqual(['2,0']);
    });

    it('folds a region when its blank space is clicked', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
      const todo = new FakeRegion('todo', { want: 3, hidden: true });
      surface.setRegion(todo);
      surface.render(80);

      const rect = surface.regionRects().find((entry) => entry.id === 'todo')!;
      const result = surface.handleMouse(click(5, rect.from));

      expect(result?.handled).toBe(true);
      expect(todo.expandedCalls).toEqual([true]);
    });

    it('takes focus on a click that arrives without focus', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
      const updates = new FakeRegion('updates', { want: 3, hidden: true, focusOnClick: true });
      surface.setRegion(updates);
      surface.render(80);

      const rect = surface.regionRects().find((entry) => entry.id === 'updates')!;
      surface.handleMouse(click(rect.col + 5, rect.from));

      expect(surface.focusedRegion()).toBe('updates');
      expect(updates.expandedCalls).toEqual([]);
    });

    it('keeps folding after the focus it already had stops changing', () => {
      // The defect this replaces: `wantsFocus` used to consume the click
      // unconditionally, so a region that already owned the keyboard ate every
      // click and the fold below it was never reached. An approval is
      // `autoFocus` and therefore always already focused — which is why the
      // one blocking interaction in the app was the one thing a click could
      // never touch.
      const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
      const approval = new FakeRegion('approval', {
        want: 3,
        hidden: true,
        focusOnClick: true,
        autoFocus: true,
      });
      surface.setRegion(approval);
      surface.render(80);
      expect(surface.focusedRegion()).toBe('approval');

      const rect = surface.regionRects().find((entry) => entry.id === 'approval')!;
      surface.handleMouse(click(rect.col + 5, rect.from));

      expect(approval.expandedCalls).toEqual([true]);
    });

    it('leaves the keyboard alone when the updates box is clicked', () => {
      // The user's rule for the Updates box: the pointer reads, `Ctrl+N` owns
      // the keys. A click used to focus it, so every later keystroke went to the
      // panel instead of the editor — and the box then had to be blurred before
      // typing again.
      const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
      const updates = new FakeRegion('updates', {
        want: 3,
        placement: 'right',
        hidden: true,
        focusOnClick: false,
        defaultFocusTarget: true,
      });
      surface.setRegion(updates);
      surface.render(80);

      const rect = surface.regionRects().find((entry) => entry.id === 'updates')!;
      surface.handleMouse(click(rect.col + 3, rect.from));

      expect(surface.focusedRegion()).toBeNull();
      // The click still reaches the region, and the fold fallback acts on it.
      expect(updates.mouseLog).toEqual(['3,0']);
      expect(updates.expandedCalls).toEqual([true]);
    });

    it('ignores clicks outside every region', () => {      const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
      surface.setRegion(new FakeRegion('todo', { want: 2 }));
      surface.render(80);

      expect(surface.handleMouse(click(5, 99))).toBeUndefined();
    });

    it('ignores mouse before the first paint', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
      surface.setRegion(new FakeRegion('todo', { want: 2 }));
      expect(surface.handleMouse(click(1, 1))).toBeUndefined();
    });

    it('routes wheel steps to the region under the pointer', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
      const todo = new FakeRegion('todo', { want: 3 });
      surface.setRegion(todo);
      surface.render(80);
      todo.keyLog.length = 0;

      const rect = surface.regionRects().find((entry) => entry.id === 'todo')!;
      // The pointer has to land in the region's content box, which starts past
      // the frame's bar and padding — not on column 1 of the surface.
      surface.handleMouse({ ...click(rect.col + 1, rect.from), type: 'wheel', wheelDelta: 2 });

      expect(todo.keyLog).toEqual(['down', 'down']);
    });
  });

  it('measures each present region exactly once per paint', () => {
    const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
    const todo = new FakeRegion('todo', { want: 2 });
    surface.setRegion(todo);
    surface.render(80);
    expect(todo.measureCalls).toBe(1);
  });

  it('does not measure an empty region', () => {
    const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
    const todo = new FakeRegion('todo', { want: 2, empty: true });
    surface.setRegion(todo);
    surface.render(80);
    expect(todo.measureCalls).toBe(0);
  });

  it('invokes the render callback when a fold changes state', () => {
    const onRequestRender = mock();
    const surface = new StatusSurfaceComponent({
      terminalRows: () => 24,
      onRequestRender,
    });
    surface.setRegion(new FakeRegion('todo', { want: 2, hidden: true }));

    surface.toggleFold('todo');
    expect(onRequestRender).toHaveBeenCalledTimes(1);
  });
});
