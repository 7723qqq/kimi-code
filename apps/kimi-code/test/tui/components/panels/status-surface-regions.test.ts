import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import { NotifyPanelComponent } from '#/tui/components/chrome/notify-panel';
import { StatusSurfaceComponent } from '#/tui/components/chrome/status-surface/index';
import { TodoRegion } from '#/tui/components/chrome/status-surface/regions/todo-region';
import { UpdatesRegion } from '#/tui/components/chrome/status-surface/regions/updates-region';
import { TodoPanelComponent } from '#/tui/components/chrome/todo-panel';

/**
 * The strip above the editor holds the todo list and the mid-turn updates as
 * regions of one surface. These cases pin the properties the layout depends
 * on: both regions render at whatever width they are handed, each one occupies
 * rows only while it has content, and the two sit side by side in one band
 * (the todo list in the left column, the updates box in the right).
 *
 * A region may instead declare a band of its own — an approval does, because
 * its diff needs the full width — which is why the band, not the region, is
 * the unit of height here.
 */
function buildSurface(rows = 40) {
  const surface = new StatusSurfaceComponent({ terminalRows: () => rows });
  const todoPanel = new TodoPanelComponent({ terminalRows: () => rows });
  const notifyPanel = new NotifyPanelComponent(() => rows);
  surface.setRegion(new TodoRegion(todoPanel));
  surface.setRegion(new UpdatesRegion(notifyPanel));
  return { surface, todoPanel, notifyPanel };
}

function visibleWidths(lines: readonly string[]): number[] {
  // Compositing two regions onto one row leaves OSC 8 resets behind, which a
  // CSI-only strip leaves in the string and reports as visible columns.
  return lines.map((line) => visibleWidth(line));
}

function stripLine(line: string): string {
  return line.replace(/\u001b\[[0-9;]*m/g, '').replace(/\u001b\]8;;\u0007/g, '');
}

function text(lines: readonly string[]): string {
  return lines.map((line) => line.replace(/\u001B\[[0-9;]*m/g, '')).join('\n');
}

describe('todo and update regions share one surface', () => {
  it('renders nothing while both regions are empty', () => {
    const { surface } = buildSurface();
    expect(surface.render(100)).toEqual([]);
  });

  it('gives a lone todo region its whole column', () => {
    const { surface, todoPanel } = buildSurface();
    todoPanel.setTodos([{ title: 'Wire the split', status: 'in_progress' }]);

    const lines = surface.render(80);
    expect(lines.length).toBeGreaterThan(0);
    // It asked for the left column, so it is drawn there and nowhere else:
    // half the width, not all of it. (A region that needs the full width
    // declares `'full'` and gets a band of its own.)
    const box = surface.regionRects().find((entry) => entry.id === 'todo')!;
    // Past the frame's bar and its one-cell padding: content begins at column 2.
    expect(box.col).toBe(2);
    expect(box.width).toBeLessThan(80);
    expect(box.width).toBeGreaterThan(30);
    for (const line of lines) {
      expect(visibleWidths([line])[0]).toBeLessThanOrEqual(80);
    }
  });

  it('gives a lone update region its whole column', () => {
    const { surface, notifyPanel } = buildSurface();
    notifyPanel.upsert({ id: '1', agentId: 'main', time: 0, text: 'Split applied' });

    const lines = surface.render(80);
    expect(lines.length).toBeGreaterThan(0);
    const box = surface.regionRects().find((entry) => entry.id === 'updates')!;
    expect(box.col).toBeGreaterThan(0);
    expect(box.width).toBeGreaterThan(30);
    for (const line of lines) {
      expect(visibleWidths([line])[0]).toBeLessThanOrEqual(80);
    }
  });

  it('places the two regions side by side instead of stacking them', () => {
    const { surface, todoPanel, notifyPanel } = buildSurface();
    todoPanel.setTodos([{ title: 'Wire the split', status: 'in_progress' }]);
    notifyPanel.upsert({ id: '1', agentId: 'main', time: 0, text: 'Split applied' });

    const both = surface.render(100);

    const todoAlone = buildSurface();
    todoAlone.todoPanel.setTodos([{ title: 'Wire the split', status: 'in_progress' }]);
    const notifyAlone = buildSurface();
    notifyAlone.notifyPanel.upsert({ id: '1', agentId: 'main', time: 0, text: 'Split applied' });

    const todoHeight = todoAlone.surface.render(100).length;
    const notifyHeight = notifyAlone.surface.render(100).length;
    // Side by side means the shared band is as tall as the taller of the two,
    // not the sum: this assertion is the one the layout change overturns, and
    // it is rewritten rather than kept because stacking is exactly the
    // behaviour being replaced.
    expect(both.length).toBe(Math.max(todoHeight, notifyHeight));
  });

  it('mounts inside a gutter container that only holds the surface', () => {
    const { surface } = buildSurface();
    const container = new GutterContainer(2, 2);
    container.addChild(surface);
    expect(container.children).toEqual([surface]);
  });

  it('drops to an empty render once both regions are cleared', () => {
    const { surface, todoPanel, notifyPanel } = buildSurface();
    todoPanel.setTodos([{ title: 'x', status: 'pending' }]);
    notifyPanel.upsert({ id: '1', agentId: 'main', time: 0, text: 'y' });
    expect(surface.render(80).length).toBeGreaterThan(0);

    todoPanel.clear();
    notifyPanel.clear();
    expect(surface.render(80)).toEqual([]);
  });

  it('measures each region at the width it is drawn at', () => {
    // The updates box wraps, so it is taller in a column than across the full
    // width. Measuring it at the surface's width and then painting it into a
    // column granted too few rows, which clipped its bottom border off and
    // left an open box.
    const { surface, notifyPanel } = buildSurface();
    notifyPanel.upsert({
      id: '1',
      agentId: 'main',
      time: 0,
      text: 'a'.repeat(60),
    });
    const painted = surface.render(80);
    const box = surface.regionRects().find((entry) => entry.id === 'updates')!;
    expect(painted.length).toBeGreaterThanOrEqual(box.drawn);
    // The frame closes: the surface's last row is the bottom border, so the
    // column the updates box was measured for did not clip it off the strip.
    const last = stripLine(painted.at(-1)!);
    expect(last).toContain('╰');
  });

  it('does not let the shorter column answer clicks below what it drew', () => {
    // Two regions share a row, so the band is as tall as the taller one. The
    // shorter one must not own the blank rows below it — clicking there used to
    // fold it, which is the same class of defect as an unclickable approval:
    // the hit test and the paint disagreeing about where the region is.
    const { surface, todoPanel, notifyPanel } = buildSurface();
    todoPanel.setTodos([{ title: 'short', status: 'pending' }]);
    notifyPanel.upsert({ id: '1', agentId: 'main', time: 0, text: 'a'.repeat(60) });
    surface.render(80);

    const todoBox = surface.regionRects().find((entry) => entry.id === 'todo')!;
    const updatesBox = surface.regionRects().find((entry) => entry.id === 'updates')!;
    expect(updatesBox.drawn).toBeGreaterThan(todoBox.drawn);

    // The first row below the todo list's own rows, still inside the band: not
    // a click on todo. (`drawn` is exclusive, so `from + drawn` is that row.)
    const below = todoBox.from + todoBox.drawn;
    expect(below).toBeLessThan(updatesBox.from + updatesBox.drawn);
    const miss = surface.handleMouse({
      type: 'click',
      button: 'left',
      x: todoBox.col + 1,
      y: below,
      screenX: todoBox.col + 1,
      screenY: below,
      width: 80,
      height: 30,
      shift: false,
      alt: false,
      ctrl: false,
    });
    expect(miss).toBeUndefined();
  });

  it('keeps both regions readable at a narrow width', () => {
    const { surface, todoPanel, notifyPanel } = buildSurface();
    todoPanel.setTodos([{ title: 'a fairly long todo title', status: 'in_progress' }]);
    notifyPanel.upsert({ id: '1', agentId: 'main', time: 0, text: 'and an update' });

    const lines = surface.render(40);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(visibleWidths([line])[0]).toBeLessThanOrEqual(40);
    }
    expect(text(lines)).toContain('todo');
  });

  it('scrolls the updates box on the wheel without a priming click, and keeps the keyboard', () => {
    // Both halves of the reported defect. The wheel over the box must move the
    // box on the first tick — the panel used to consume the event and change
    // nothing, so it read as "click me first". And a click on the box must not
    // take the keyboard: the pointer reads, `Ctrl+N` owns the keys.
    const { surface, notifyPanel } = buildSurface();
    notifyPanel.upsert({
      id: '1',
      agentId: 'main',
      time: 0,
      text: Array.from({ length: 30 }, (_, i) => `- row ${String(i + 1).padStart(2, '0')}`).join('\n'),
    });
    surface.render(100);
    const box = surface.regionRects().find((entry) => entry.id === 'updates')!;
    const at = { x: box.col + 3, y: box.from + 1 };

    expect(text(surface.render(100))).toContain('row 01');
    const wheeled = surface.handleMouse({
      type: 'wheel',
      button: 'none',
      ...at,
      screenX: at.x,
      screenY: at.y,
      width: 100,
      height: 30,
      wheelDelta: 1,
      shift: false,
      alt: false,
      ctrl: false,
    });
    expect(wheeled?.handled).toBe(true);
    expect(text(surface.render(100))).not.toContain('row 01');

    // A click on the body must not take the keyboard. It does not have to fold
    // anything here — the panel is expanded and has nothing hidden — but the
    // keyboard must stay with the editor either way.
    const clicked = surface.handleMouse({
      type: 'click',
      button: 'left',
      ...at,
      screenX: at.x,
      screenY: at.y,
      width: 100,
      height: 30,
      shift: false,
      alt: false,
      ctrl: false,
    });
    expect(clicked ?? null).toBeNull();
    expect(surface.focusedRegion()).toBeNull();
  });
});
