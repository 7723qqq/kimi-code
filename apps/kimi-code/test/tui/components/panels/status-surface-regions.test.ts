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
 * rows only while it has content, and the two stack rather than sharing a row
 * (a blocking approval later needs the full width, and columns would make
 * every neighbour re-flow whenever either side grew).
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
  return lines.map((line) => line.replace(/\u001B\[[0-9;]*m/g, '').length);
}

function text(lines: readonly string[]): string {
  return lines.map((line) => line.replace(/\u001B\[[0-9;]*m/g, '')).join('\n');
}

describe('todo and update regions share one surface', () => {
  it('renders nothing while both regions are empty', () => {
    const { surface } = buildSurface();
    expect(surface.render(100)).toEqual([]);
  });

  it('gives a lone todo region the full width', () => {
    const { surface, todoPanel } = buildSurface();
    todoPanel.setTodos([{ title: 'Wire the split', status: 'in_progress' }]);

    const lines = surface.render(80);
    expect(lines.length).toBeGreaterThan(0);
    expect(Math.max(...visibleWidths(lines))).toBeGreaterThan(60);
  });

  it('gives a lone update region the full width', () => {
    const { surface, notifyPanel } = buildSurface();
    notifyPanel.upsert({ id: '1', agentId: 'main', time: 0, text: 'Split applied' });

    const lines = surface.render(80);
    expect(lines.length).toBeGreaterThan(0);
    expect(Math.max(...visibleWidths(lines))).toBeGreaterThan(60);
  });

  it('stacks the two regions instead of sharing a row', () => {
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
    // Stacked means both bodies are present at once: the row is at least as
    // tall as the two together, minus the separator the surface shares.
    expect(both.length).toBeGreaterThanOrEqual(todoHeight + notifyHeight - 1);
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
});
