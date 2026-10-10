import { Container, Text, VStack } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalRegion } from '#/tui/components/chrome/status-surface/regions/approval-region';
import { StatusSurfaceComponent } from '#/tui/components/chrome/status-surface/index';
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

  it('renders a single summary row while folded', () => {
    const { region, surface } = makeRegion();
    showPayload(region, payload());

    const out = surface.render(80);
    expect(out).toHaveLength(1);
    // The folded line reuses the panel's tool-specific prompt, so a Bash
    // approval reads the same question in both shapes.
    expect(strip(out[0]!)).toContain('Run this command?');
    expect(strip(out[0]!)).toContain('Allow');
  });

  it('keeps the numbered options visible while folded', () => {
    const { region, surface } = makeRegion();
    showPayload(region, payload());

    const line = strip(surface.render(80)[0]!);
    // The fold is only safe because the user can still answer: the numbers
    // have to be on the one line that is always drawn.
    expect(line).toContain('1.');
    expect(line).toContain('Allow');
    expect(line).toContain('2.');
    expect(line).toContain('3.');
    expect(line).toContain('Reject');
  });

  it('stays folded by default so it cannot push the editor away', () => {
    const { region, surface } = makeRegion(6);
    showPayload(
      region,
      payload({
        display: [{ type: 'shell', language: 'bash', command: 'x\n'.repeat(40) }],
      }),
    );
    // Six rows -> a three-row budget; the folded form still costs one row.
    expect(surface.render(80)).toHaveLength(1);
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
    // 24 rows -> a 12-row budget for the single region.
    expect(out).toHaveLength(12);
    expect(strip(out[0]!)).toContain('1.');
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

    const selected = (): string => strip(surface.render(80)[0]!);
    expect(selected()).toContain('Allow');
    region.handleKey('down');
    expect(selected()).toContain('Allow for session');
    region.handleKey('up');
    expect(selected()).toContain('Allow');
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
});
