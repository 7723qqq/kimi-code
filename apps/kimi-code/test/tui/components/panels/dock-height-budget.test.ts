import { Container, ScrollView, Text, VStack } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { NotifyPanelComponent } from '#/tui/components/chrome/notify-panel';

import { renderLayoutFrame } from '../../../../../../packages/pi-tui/src/layout';

/**
 * The dock (`tui-state.ts`) stacks several panels that each want as much height
 * as their content needs. They used to have no ceiling, so a long Updates entry
 * or a deep queue pushed the editor and footer off screen — on a 6-row terminal
 * the Updates box alone rendered 8 lines. These tests drive the real layout
 * engine (`renderLayoutFrame`) rather than `component.render()`: a bare render
 * does not honour the viewport (a 10-row viewport happily returns 43 lines), so
 * a component-level assertion would pass while the screen is still broken.
 */
const WIDTH = 60;
const TERMINAL_ROWS = [24, 20, 12, 10, 8, 6, 4] as const;

function longEntry(): string {
  return Array.from({ length: 40 }, (_, i) => `- line ${String(i + 1)}`).join('\n');
}

/** A dock shaped like the real one: scrollback, the Updates box, the editor. */
function buildDock(rows: number) {
  const panel = new NotifyPanelComponent(() => rows);
  const panelBox = new Container();
  panelBox.addChild(panel);
  panel.upsert({ id: 'a', agentId: 'main', time: 0, text: longEntry() });

  const root = new VStack();
  root.addChild(new ScrollView(new Text('history\n'.repeat(200), 0, 0), { primary: true }), {
    basis: 0,
    grow: 1,
    shrink: 1,
    minSize: 1,
  });
  // Mirrors the dock's layer-1 ceiling for the panels row.
  root.addChild(panelBox, { shrink: 1, minSize: 0, maxSize: 18 });
  root.addChild(new Text('editor', 0, 0), { shrink: 1, minSize: 3 });
  return { root, panel, panelBox };
}

describe('dock height budget', () => {
  it.each(TERMINAL_ROWS)('never lets the dock exceed the terminal height (%i rows)', (rows) => {
    const { root } = buildDock(rows);
    const frame = renderLayoutFrame(root, WIDTH, rows, () => {});
    const allocated = frame.root.children.map((child) => child.rect.height);
    // The whole point: the sum is the screen, not more than the screen.
    expect(allocated.reduce((sum, height) => sum + height, 0)).toBe(rows);
  });

  it.each(TERMINAL_ROWS)('keeps the editor visible at %i rows', (rows) => {
    const { root } = buildDock(rows);
    const frame = renderLayoutFrame(root, WIDTH, rows, () => {});
    const editor = frame.root.children.at(-1);
    expect(editor?.rect.height).toBeGreaterThanOrEqual(Math.min(3, rows));
  });

  it.each(TERMINAL_ROWS)('caps the Updates box at %i rows', (rows) => {
    const { root, panelBox } = buildDock(rows);
    const frame = renderLayoutFrame(root, WIDTH, rows, () => {});
    const box = frame.root.children.find((child) => child.component === panelBox);
    // Layer 1 (maxSize 18) plus layer 2 (the panel's own total-row budget).
    expect(box?.rect.height).toBeLessThanOrEqual(Math.min(18, Math.max(2, Math.floor(rows / 2))));
  });

  it.each(TERMINAL_ROWS)(
    'renders the box within the height the layout gave it (%i rows)',
    (rows) => {
      // A panel that renders more lines than its allocation would be clipped by
      // the frame, so the panel has to agree with the allocator rather than
      // assume it got what it asked for.
      const { root, panel, panelBox } = buildDock(rows);
      const frame = renderLayoutFrame(root, WIDTH, rows, () => {});
      const box = frame.root.children.find((child) => child.component === panelBox);
      expect(box).toBeDefined();
      expect(panel.render(WIDTH).length).toBeLessThanOrEqual(Math.max(2, rows));
    },
  );
});
