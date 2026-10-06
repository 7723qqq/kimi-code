import { describe, expect, it } from 'vitest';

import { HStack } from '@moonshot-ai/pi-tui';

import { NotifyPanelComponent } from '#/tui/components/chrome/notify-panel';
import { TodoPanelComponent } from '#/tui/components/chrome/todo-panel';

/**
 * The workbench lays the todo list and the mid-turn updates out in one row.
 * These cases pin the two properties that layout depends on: both panels
 * render at whatever width they are handed, and the row gives a lone panel the
 * whole width rather than leaving the other side blank.
 */
function buildRow(todo: TodoPanelComponent, notify: NotifyPanelComponent): HStack {
  const row = new HStack();
  row.addChild(todo, {
    basis: 0,
    grow: 1,
    shrink: 1,
    minSize: 0,
    visible: () => !todo.isEmpty(),
  });
  row.addChild(notify, {
    basis: 0,
    grow: 2,
    shrink: 1,
    minSize: 0,
    visible: () => !notify.isEmpty(),
  });
  return row;
}

function visibleWidths(lines: readonly string[]): number[] {
  return lines.map((line) => line.replace(/\u001B\[[0-9;]*m/g, '').length);
}

describe('todo and update panels share one row', () => {
  it('renders nothing while both panels are empty', () => {
    const row = buildRow(new TodoPanelComponent(), new NotifyPanelComponent());
    expect(row.render(100)).toEqual([]);
  });

  it('gives a lone todo panel the full width', () => {
    const todo = new TodoPanelComponent();
    todo.setTodos([{ title: 'Wire the split', status: 'in_progress' }]);
    const row = buildRow(todo, new NotifyPanelComponent());

    const lines = row.render(80);
    expect(lines.length).toBeGreaterThan(0);
    // The header rule spans the panel, so it reveals the allocated width.
    expect(Math.max(...visibleWidths(lines))).toBeGreaterThan(60);
  });

  it('gives a lone update panel the full width', () => {
    const notify = new NotifyPanelComponent();
    notify.upsert({ id: '1', agentId: 'main', time: 0, text: 'Split applied' });
    const row = buildRow(new TodoPanelComponent(), notify);

    const lines = row.render(80);
    expect(lines.length).toBeGreaterThan(0);
    expect(Math.max(...visibleWidths(lines))).toBeGreaterThan(60);
  });

  it('places both panels side by side rather than stacked', () => {
    const todo = new TodoPanelComponent();
    todo.setTodos([{ title: 'Wire the split', status: 'in_progress' }]);
    const notify = new NotifyPanelComponent();
    notify.upsert({ id: '1', agentId: 'main', time: 0, text: 'Split applied' });

    const row = buildRow(todo, notify);
    const both = row.render(100);

    const todoAlone = buildRow(todo, new NotifyPanelComponent()).render(100);
    const notifyAlone = buildRow(new TodoPanelComponent(), notify).render(100);

    // Side by side means the row is no taller than the taller child alone,
    // whereas stacking would roughly add their heights.
    expect(both.length).toBeLessThanOrEqual(Math.max(todoAlone.length, notifyAlone.length));
    expect(both.length).toBeLessThan(todoAlone.length + notifyAlone.length);
  });
});
