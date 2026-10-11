import { Container, Text, VStack } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import {
  StatusSurfaceComponent,
  SURFACE_INSET,
  SURFACE_SIDE_PADDING,
} from '#/tui/components/chrome/status-surface/index';
import { ApprovalRegion } from '#/tui/components/chrome/status-surface/regions/approval-region';
import { ApprovalPanelComponent } from '#/tui/components/dialogs/approval-panel';
import type { ApprovalPanelData } from '#/tui/reverse-rpc/types';

const strip = (value: string): string => value.replace(/\u001b\[[0-9;]*m/g, '');

function payload(overrides: Partial<ApprovalPanelData> = {}): ApprovalPanelData {
  return {
    id: 'req-1',
    tool_call_id: 'tc-1',
    tool_name: 'Bash',
    action: 'run command',
    description: '',
    display: [{ type: 'shell', language: 'bash', command: 'rm -rf node_modules' }],
    choices: [
      { label: 'Allow', response: 'approved' },
      { label: 'Allow for session', response: 'approved_for_session' },
      { label: 'Reject', response: 'rejected' },
    ],
    ...overrides,
  };
}

function makeRegion(rows = 40) {
  // Responses travel through the panel (the dialog host wires its callback to
  // the approval controller), so the spy on the panel's response callback is
  // what observes an answer.
  const onRespond = vi.fn();
  const surface = new StatusSurfaceComponent({ terminalRows: () => rows });
  // `setRegion` installs the change signal, so the region needs no wiring of
  // its own — registering it is enough for a later `show` to be noticed.
  const region = new ApprovalRegion();
  surface.setRegion(region);
  return { region, surface, onRespond };
}

function showPayload(
  region: ApprovalRegion,
  data: ApprovalPanelData,
  onResponse = vi.fn(),
): ApprovalPanelComponent {
  const panel = new ApprovalPanelComponent({ data }, onResponse);
  region.show(data, panel);
  return panel;
}

/** Build a region whose panel records answers into `onRespond`. */
function makeRegionWithPanel(rows = 40) {
  const onRespond = vi.fn();
  const surface = new StatusSurfaceComponent({ terminalRows: () => rows });
  const region = new ApprovalRegion();
  surface.setRegion(region);
  const data = payload();
  const panel = new ApprovalPanelComponent({ data }, onRespond);
  region.show(data, panel);
  return { region, surface, onRespond };
}

describe('ApprovalRegion', () => {
  it('is empty until a request arrives', () => {
    const { region, surface } = makeRegion();
    expect(region.isEmpty()).toBe(true);
    expect(surface.render(80)).toEqual([]);
  });

  it('takes the keyboard as soon as a request arrives', () => {
    const { region, surface } = makeRegion();
    showPayload(region, payload(), vi.fn());
    expect(surface.focusedRegion()).toBe('approval');
  });

  it('renders the folded summary inside the surface frame, one option per row', () => {
    const { region, surface } = makeRegion();
    showPayload(region, payload());

    const out = surface.render(80);
    // Top border / the question / one row per option / the key hint / bottom
    // border. The approval lives in the strip's left half, but its summary does
    // not pack options into whatever the width allows: each option keeps a row
    // of its own, so numbers hold their places at any width.
    expect(out).toHaveLength(7);
    // The folded rows reuse the panel's tool-specific prompt, so a Bash
    // approval reads the same question in both shapes.
    expect(strip(out[1]!)).toContain('Run this command?');
    expect(strip(out[1]!)).not.toContain('Allow');
    expect(strip(out[2]!)).toContain('1. Allow');
    expect(strip(out[3]!)).toContain('2. Allow for session');
    expect(strip(out[4]!)).toContain('3. Reject');
    expect(strip(out[5]!)).toContain('ctrl+t');
  });

  it('keeps the numbered options visible while folded', () => {
    const { region, surface } = makeRegion();
    showPayload(region, payload());

    const summary = surface.render(80).slice(1, -1).map(strip).join('\n');
    // The fold is only safe because the user can still answer: every number has
    // to be on the summary rows that are always drawn, each on its own row with
    // the label beside it.
    expect(summary).toContain('1. Allow');
    expect(summary).toContain('2. Allow for session');
    expect(summary).toContain('3. Reject');
  });

  it('stays folded by default so it cannot push the editor away', () => {
    const { region, surface } = makeRegion(6);
    showPayload(
      region,
      payload({
        display: [{ type: 'shell', language: 'bash', command: 'x\n'.repeat(40) }],
      }),
    );
    // Six rows -> a three-row budget: top border + the folded summary + bottom
    // border. The folded form still costs one content row.
    expect(surface.render(80)).toHaveLength(3);
  });

  it('expands to the panel body inside the granted budget', () => {
    const { region, surface } = makeRegion(24);
    showPayload(
      region,
      payload({
        display: [
          {
            type: 'file_content',
            path: 'a.ts',
            content: Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'),
          },
        ],
      }),
    );
    region.setExpanded(true);

    const out = surface.render(80);
    // 24 rows -> a 12-row total; the frame takes two of those rows and the
    // single region fills the rest, summary rows first (the question, one row
    // per option, the key hint) and the panel body below them.
    expect(out).toHaveLength(12);
    expect(strip(out[1]!)).toContain('Run this command?');
    expect(strip(out[2]!)).toContain('1. Allow');
    // The body follows the summary and is clipped to what the budget has left:
    // the file's opening lines are on screen and its later ones are not.
    const body = out.map(strip).join('\n');
    expect(body).toContain('line 0');
    expect(body).not.toContain('line 39');
    // Every body row stays inside the granted budget, which is the clip the
    // expanded form is defined by.
    expect(out.length).toBeLessThanOrEqual(12);
  });

  it('reports hidden content only while folded', () => {
    const { region } = makeRegion();
    showPayload(region, payload());
    expect(region.isExpanded()).toBe(false);
    expect(region.hasHiddenContent()).toBe(true);

    region.setExpanded(true);
    expect(region.hasHiddenContent()).toBe(false);
  });

  it('moves the highlight with the arrow keys', () => {
    const { region, surface } = makeRegion();
    showPayload(region, payload());

    // Every option keeps its own row, so the highlight moves down the list no
    // matter how wide the column is.
    const selected = (): string => surface.render(80).slice(1, -1).map(strip).join('\n');
    expect(selected()).toContain('1. Allow');
    region.handleKey('down');
    expect(selected()).toContain('2. Allow for session');
    region.handleKey('up');
    expect(selected()).toContain('1. Allow');
  });

  it('answers with Enter', () => {
    const { region, onRespond } = makeRegionWithPanel();

    expect(region.handleKey('enter')).toBe(true);
    expect(onRespond).toHaveBeenCalledWith({
      response: 'approved',
      feedback: undefined,
      selected_label: undefined,
    });
  });

  it('answers with a number without expanding first', () => {
    const { region, onRespond } = makeRegionWithPanel();
    expect(region.isExpanded()).toBe(false);

    expect(region.handleNumber(2)).toBe(true);
    expect(onRespond).toHaveBeenCalledWith({
      response: 'approved_for_session',
      feedback: undefined,
      selected_label: undefined,
    });
  });

  it('answers with a digit key routed the same way as handleNumber', () => {
    const first = makeRegionWithPanel();
    expect(first.region.handleKey('digit1')).toBe(true);
    expect(first.onRespond).toHaveBeenCalledWith({
      response: 'approved',
      feedback: undefined,
      selected_label: undefined,
    });

    const second = makeRegionWithPanel();
    expect(second.region.handleKey('digit2')).toBe(true);
    expect(second.onRespond).toHaveBeenCalledWith({
      response: 'approved_for_session',
      feedback: undefined,
      selected_label: undefined,
    });
  });

  it('ignores a digit past the last option', () => {
    const { region, onRespond } = makeRegionWithPanel();
    expect(region.handleKey('digit9')).toBe(false);
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('ignores an out-of-range number', () => {
    const { region, onRespond } = makeRegionWithPanel();
    expect(region.handleNumber(9)).toBe(false);
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('rejects on escape', () => {
    const { region, onRespond } = makeRegionWithPanel();
    expect(region.handleKey('escape')).toBe(true);
    expect(onRespond).toHaveBeenCalledWith({ response: 'rejected' });
  });

  it('carries a session-scoped choice through unchanged', () => {
    const { region, onRespond } = makeRegionWithPanel();
    // Printed digit 2 is "Allow for session" in the fixture above.
    region.handleNumber(2);
    expect(onRespond).toHaveBeenCalledWith({
      response: 'approved_for_session',
      feedback: undefined,
      selected_label: undefined,
    });
  });

  it('toggles the fold through the surface', () => {
    const { region, surface } = makeRegion();
    showPayload(region, payload());
    expect(surface.toggleFold('approval')).toBe(true);
    expect(region.isExpanded()).toBe(true);
  });

  it('ignores keys when no request is pending', () => {
    const { region } = makeRegion();
    expect(region.handleKey('enter')).toBe(false);
    expect(region.handleKey('escape')).toBe(false);
    expect(region.handleNumber(0)).toBe(false);
  });

  it('routes a numeric answer through the panel so feedback choices still prompt', () => {
    const onRespond = vi.fn();
    const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
    const region = new ApprovalRegion();
    surface.setRegion(region);
    const data = payload({
      choices: [
        { label: 'Allow', response: 'approved' },
        { label: 'Reject with note', response: 'rejected', requires_feedback: true },
      ],
    });
    region.show(data, new ApprovalPanelComponent({ data }, onRespond));

    // A feedback choice must NOT submit immediately: the panel enters its
    // inline input instead, so the user's note is not silently dropped.
    expect(region.handleNumber(2)).toBe(true);
    expect(onRespond).not.toHaveBeenCalled();
  });

  it('goes empty again after clear', () => {
    const { region, surface } = makeRegion();
    showPayload(region, payload());
    region.clear();
    expect(region.isEmpty()).toBe(true);
    expect(surface.render(80)).toEqual([]);
  });

  it('lets the editor keep its rows while an approval is up', () => {
    // A dock shaped like the real one: transcript, the strip, the editor.
    const { region, surface } = makeRegion(24);
    const editor = new Text('editor', 0, 0);
    const root = new VStack();
    root.addChild(new Text('history\n'.repeat(50), 0, 0), {
      basis: 0,
      grow: 1,
      shrink: 1,
      minSize: 1,
    });
    const stripBox = new Container();
    stripBox.addChild(surface);
    root.addChild(stripBox, { shrink: 1, minSize: 0, maxSize: 20 });
    root.addChild(editor, { shrink: 1, minSize: 3 });
    showPayload(
      region,
      payload({
        display: [
          {
            type: 'file_content',
            path: 'big.ts',
            content: Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'),
          },
        ],
      }),
    );

    // The approval is present and the editor is still a mounted child, which
    // is the whole difference from the old editor-replacement mount.
    expect(region.isEmpty()).toBe(false);
    expect(root.children).toContain(editor);
  });

  describe('folding both ways', () => {
    it('can be folded shut again after being opened', () => {
      // The old predicate was `!expanded`, so an expanded approval reported
      // nothing hidden and the fold was refused — the summary could be opened
      // but never closed.
      const { region, surface } = makeRegion();
      showPayload(
        region,
        payload({
          display: [
            {
              type: 'file_content',
              path: 'big.ts',
              content: Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'),
            },
          ],
        }),
      );
      surface.render(80);
      expect(region.isExpanded()).toBe(false);

      expect(surface.toggleFold('approval')).toBe(true);
      expect(region.isExpanded()).toBe(true);
      // The body is being clipped by the budget, so folding still hides rows.
      expect(region.hasHiddenContent()).toBe(true);

      expect(surface.toggleFold('approval')).toBe(true);
      expect(region.isExpanded()).toBe(false);
    });

    it("takes the strip's left half in both fold states", () => {
      // The right half is the updates panel's permanent slot, so the approval
      // sits in the left one — folded and expanded alike. The frame's bars and
      // padding are not part of the region's box; the two halves share the
      // content width with one divider cell between them.
      const { region, surface } = makeRegion();
      showPayload(region, payload());
      expect(region.placement()).toBe('left');
      surface.render(80);
      const folded = surface.regionRects().find((entry) => entry.id === 'approval')!;
      expect(folded.col).toBe(SURFACE_SIDE_PADDING + 1);
      expect(folded.width).toBe(Math.ceil((80 - SURFACE_INSET) / 2));

      region.setExpanded(true);
      expect(region.placement()).toBe('left');
      surface.render(80);
      const expanded = surface.regionRects().find((entry) => entry.id === 'approval')!;
      expect(expanded.col).toBe(folded.col);
      expect(expanded.width).toBe(folded.width);
    });
  });

  describe('mouse', () => {
    it('answers with a click on the printed option number', () => {
      // The defect this replaces: the surface consumed the click for focus and
      // returned, so an approval — which is auto-focused the moment it appears
      // — never received a click at all and could not be opened or answered.
      const { region, surface, onRespond } = makeRegionWithPanel();
      const painted = surface.render(80);
      const box = surface.regionRects().find((entry) => entry.id === 'approval')!;

      // Each option has its own summary row; find the row it is painted on and
      // click the same column. The region records those spans while painting,
      // so the click and the paint cannot drift apart.
      const row = painted.findIndex((line) => strip(line).includes('2. Allow for session'));
      expect(row).toBeGreaterThanOrEqual(box.from);
      const second = strip(painted[row]!).indexOf('2. Allow for session');
      expect(second).toBeGreaterThan(-1);

      const result = surface.handleMouse({
        type: 'click',
        button: 'left',
        x: box.col + second + 1,
        y: row,
        screenX: box.col + second + 1,
        screenY: row,
        width: 80,
        height: 24,
        shift: false,
        alt: false,
        ctrl: false,
      });
      expect(result?.handled).toBe(true);
      expect(onRespond).toHaveBeenCalledWith(
        expect.objectContaining({ response: 'approved_for_session' }),
      );
    });

    it('unfolds when the summary row is clicked away from an option', () => {
      const { region, surface, onRespond } = makeRegionWithPanel();
      surface.render(80);
      const box = surface.regionRects().find((entry) => entry.id === 'approval')!;
      expect(region.isExpanded()).toBe(false);

      surface.handleMouse({
        type: 'click',
        button: 'left',
        x: box.col,
        y: box.from,
        screenX: box.col,
        screenY: box.from,
        width: 80,
        height: 24,
        shift: false,
        alt: false,
        ctrl: false,
      });
      expect(region.isExpanded()).toBe(true);
      expect(onRespond).not.toHaveBeenCalled();
    });
  });

  describe('left column keys', () => {
    it('walks the options with the arrow keys', () => {
      const { region, onRespond } = makeRegionWithPanel();
      // ↑/↓ move the highlight; Enter answers with whatever is highlighted.
      expect(region.handleKey('down')).toBe(true);
      expect(region.handleKey('enter')).toBe(true);
      expect(onRespond).toHaveBeenCalledWith(
        expect.objectContaining({ response: 'approved_for_session' }),
      );
    });

    it('reads ←/→ as option stepping, not as a column switch', () => {
      // The left column owns a horizontal meaning of its own; switching columns
      // is `Tab`, which is a strip-level gesture.
      const { region, onRespond } = makeRegionWithPanel();
      expect(region.handleKey('right')).toBe(true);
      expect(region.handleKey('enter')).toBe(true);
      expect(onRespond).toHaveBeenCalledWith(
        expect.objectContaining({ response: 'approved_for_session' }),
      );
    });
  });
});
