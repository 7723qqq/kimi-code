import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'bun:test';

import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import { NotifyPanelComponent } from '#/tui/components/chrome/notify-panel';
import { StatusSurfaceComponent } from '#/tui/components/chrome/status-surface/index';
import type {
  RegionId,
  RegionKey,
  RegionMouseEvent,
  RegionPlacement,
  RegionRenderContext,
  StatusRegion,
} from '#/tui/components/chrome/status-surface/region';
import { UpdatesRegion } from '#/tui/components/chrome/status-surface/regions/updates-region';

/**
 * The strip above the editor holds status regions side by side: a blocking
 * approval takes a full band, and a plain region shares the row. These cases
 * pin the properties the layout depends on — each region renders at whatever
 * width it is handed, occupies rows only while it has content, and two regions
 * sit side by side in one band instead of stacking.
 *
 * The todo list used to be the second region here; it renders as a transcript
 * card now, so the left column is exercised with a stand-in that behaves the
 * same way the surface requires of any region.
 */
class StandInRegion implements StatusRegion {
  readonly id: RegionId;
  readonly priority = 10;
  readonly blocking = false;
  private lines: string[] = [];
  private readonly place: RegionPlacement;

  constructor(id: RegionId = 'todo', place: RegionPlacement = 'left') {
    this.id = id;
    this.place = place;
  }

  setLines(lines: readonly string[]): void {
    this.lines = [...lines];
  }

  clear(): void {
    this.lines = [];
  }

  placement(): RegionPlacement {
    return this.place;
  }

  isEmpty(): boolean {
    return this.lines.length === 0;
  }

  measure(): number {
    return this.lines.length;
  }

  render(_ctx: RegionRenderContext): string[] {
    return [...this.lines];
  }

  isExpanded(): boolean {
    return true;
  }

  setExpanded(): void {}

  hasHiddenContent(): boolean {
    return false;
  }

  handleKey(_key: RegionKey): boolean {
    return false;
  }

  handleMouse(_event: RegionMouseEvent): undefined {
    return undefined;
  }

  wantsFocus(): boolean {
    return false;
  }
}

function buildSurface(rows = 40) {
  const surface = new StatusSurfaceComponent({ terminalRows: () => rows });
  const sidebar = new StandInRegion();
  const notifyPanel = new NotifyPanelComponent(() => rows);
  surface.setRegion(sidebar);
  surface.setRegion(new UpdatesRegion(notifyPanel));
  return { surface, sidebar, notifyPanel };
}

function visibleWidths(lines: readonly string[]): number[] {
  return lines.map((line) => visibleWidth(line));
}

function sidebarLines(): string[] {
  return ['  todo one', '  todo two'];
}

describe('status regions share one surface', () => {
  it('renders nothing while both regions are empty', () => {
    const { surface } = buildSurface();
    expect(surface.render(100)).toEqual([]);
  });

  it('gives a lone left-column region its whole column', () => {
    const { surface, sidebar } = buildSurface();
    sidebar.setLines(sidebarLines());

    const lines = surface.render(80);
    expect(lines.length).toBeGreaterThan(0);
    const box = surface.regionRects().find((entry) => entry.id === 'todo')!;
    expect(box.col).toBe(2);
    expect(box.width).toBeLessThan(80);
    expect(box.width).toBeGreaterThan(30);
    for (const line of lines) {
      expect(visibleWidths([line])[0]).toBeLessThanOrEqual(80);
    }
  });

  it('gives a lone full-width region the whole band', () => {
    const { surface, notifyPanel } = buildSurface();
    notifyPanel.upsert({ id: '1', agentId: 'main', time: 0, text: 'Split applied' });

    const lines = surface.render(80);
    expect(lines.length).toBeGreaterThan(0);
    const box = surface.regionRects().find((entry) => entry.id === 'updates')!;
    expect(box.col).toBe(2);
    expect(box.width).toBeGreaterThan(70);
    for (const line of lines) {
      expect(visibleWidths([line])[0]).toBeLessThanOrEqual(80);
    }
  });

  it('places the two column regions side by side instead of stacking them', () => {
    const surface = new StatusSurfaceComponent({
      terminalRows: () => 40,
      onRequestRender: () => {},
    });
    const left = new StandInRegion('todo', 'left');
    const right = new StandInRegion('updates', 'right');
    left.setLines(sidebarLines());
    right.setLines(sidebarLines());
    surface.setRegion(left);
    surface.setRegion(right);

    const both = surface.render(100);

    const leftAlone = new StatusSurfaceComponent({
      terminalRows: () => 40,
      onRequestRender: () => {},
    });
    leftAlone.setRegion(left);

    const notifyAlone = new StatusSurfaceComponent({
      terminalRows: () => 40,
      onRequestRender: () => {},
    });
    notifyAlone.setRegion(right);

    const leftHeight = leftAlone.render(100).length;
    const notifyHeight = notifyAlone.render(100).length;
    expect(both.length).toBe(Math.max(leftHeight, notifyHeight));
  });

  it('mounts inside a gutter container that only holds the surface', () => {
    const { surface } = buildSurface();
    const container = new GutterContainer(2, 2);
    container.addChild(surface);
    expect(container.children).toEqual([surface]);
  });

  it('drops to an empty render once both regions are cleared', () => {
    const { surface, sidebar, notifyPanel } = buildSurface();
    sidebar.setLines(['  x']);
    notifyPanel.upsert({ id: '1', agentId: 'main', time: 0, text: 'y' });
    expect(surface.render(80).length).toBeGreaterThan(0);

    sidebar.clear();
    notifyPanel.clear();
    expect(surface.render(80)).toEqual([]);
  });
});
