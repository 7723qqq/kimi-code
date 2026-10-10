import type { TuiMouseEvent } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { StatusSurfaceComponent } from '#/tui/components/chrome/status-surface/index';
import {
  type RegionId,
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
}

class FakeRegion implements StatusRegion {
  readonly autoFocus: boolean | undefined;
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

  it('draws no rules of its own: regions delimit themselves', () => {
    const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
    surface.setRegion(new FakeRegion('todo', { want: 3 }));
    surface.setRegion(new FakeRegion('updates', { want: 3 }));
    const out = surface.render(80);
    // The fake regions draw no rule, and the surface adds none — a real region
    // opens with its own (the todo panel with a rule, the Updates box with the
    // border that carries its tab strip).
    expect(out.some((line) => line.includes('─'))).toBe(false);
    expect(out).toEqual(['todo-header', 'todo-row-1', 'todo-row-2', 'updates-header', 'updates-row-1', 'updates-row-2']);
  });

  it('orders approval above todo above updates regardless of registration order', () => {
    const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
    surface.setRegion(new FakeRegion('updates', { want: 2 }));
    surface.setRegion(new FakeRegion('todo', { want: 2 }));
    surface.setRegion(new FakeRegion('approval', { want: 2 }));

    const out = surface.render(80).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ''));
    expect(out.findIndex((line) => line.startsWith('approval-header'))).toBeLessThan(
      out.findIndex((line) => line.startsWith('todo-header')),
    );
    expect(out.findIndex((line) => line.startsWith('todo-header'))).toBeLessThan(
      out.findIndex((line) => line.startsWith('updates-header')),
    );
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
    // 12 rows -> total 6, one region so no chrome.
    expect(out).toHaveLength(6);
  });

  it('reports a blocking region only while approval has content', () => {
    const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
    const approval = new FakeRegion('approval', { want: 2 });
    surface.setRegion(approval);
    expect(surface.hasBlockingRegion()).toBe(true);

    surface.setRegion(new FakeRegion('approval', { want: 2, empty: true }));
    expect(surface.hasBlockingRegion()).toBe(false);
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
      surface.setRegion(new FakeRegion('todo', { want: 2, hidden: true }));
      expect(surface.handleKey('toggle')).toBe(true);
    });

    it('ignores the toggle when no todo region exists', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
      surface.setRegion(new FakeRegion('updates', { want: 2, hidden: true }));
      expect(surface.handleKey('toggle')).toBe(false);
    });

    it('folds the focused region in preference to the todo list', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
      const todo = new FakeRegion('todo', { want: 2, hidden: true });
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

    it('falls back to the todo list when the focused region declines the key', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 24 });
      const todo = new FakeRegion('todo', { want: 2, hidden: true });
      // Focused, but with nothing to fold — like the Updates box when it is
      // already fully visible. It declines the key, so the todo list takes it.
      const updates = new FakeRegion('updates', { want: 2, hidden: false, autoFocus: true });
      surface.setRegion(todo);
      surface.setRegion(updates);

      expect(surface.handleKey('toggle')).toBe(true);
      expect(todo.expanded).toBe(true);
      expect(updates.expanded).toBe(false);
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
    it('translates row coordinates into region-local ones', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
      const todo = new FakeRegion('todo', { want: 3 });
      const updates = new FakeRegion('updates', { want: 3 });
      surface.setRegion(todo);
      surface.setRegion(updates);
      surface.render(80);

      const rects = surface.regionRects();
      const updatesRect = rects.find((rect) => rect.id === 'updates');
      expect(updatesRect).toBeDefined();

      surface.handleMouse(click(5, updatesRect!.from));

      // The first row of the updates region is y=0 in its own frame.
      expect(updates.mouseLog).toEqual(['5,0']);
      expect(todo.mouseLog).toEqual([]);
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

    it('prefers focus over folding when the region wants focus', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
      const updates = new FakeRegion('updates', { want: 3, hidden: true, focusOnClick: true });
      surface.setRegion(updates);
      surface.render(80);

      const rect = surface.regionRects().find((entry) => entry.id === 'updates')!;
      surface.handleMouse(click(5, rect.from));

      expect(surface.focusedRegion()).toBe('updates');
      expect(updates.expandedCalls).toEqual([]);
    });

    it('ignores clicks outside every region', () => {
      const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
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
      surface.handleMouse({ ...click(1, rect.from), type: 'wheel', wheelDelta: 2 });

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
    const onRequestRender = vi.fn();
    const surface = new StatusSurfaceComponent({
      terminalRows: () => 24,
      onRequestRender,
    });
    surface.setRegion(new FakeRegion('todo', { want: 2, hidden: true }));

    surface.toggleFold('todo');
    expect(onRequestRender).toHaveBeenCalledTimes(1);
  });
});
