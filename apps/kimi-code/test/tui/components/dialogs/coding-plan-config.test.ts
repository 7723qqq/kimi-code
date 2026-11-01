import { describe, expect, it, mock } from 'bun:test';

import { CodingPlanConfigComponent } from '#/tui/components/dialogs/coding-plan-config';
import { mouse, pastSettlingWindow } from '#test/helpers/mouse';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (text: string): string => text.replaceAll(ANSI, '');

function makePanel(): CodingPlanConfigComponent {
  const panel = new CodingPlanConfigComponent({
    currentConfig: {},
    onSave: mock(),
    onCancel: mock(),
  });
  panel.focused = true;
  pastSettlingWindow();
  return panel;
}

function rows(panel: CodingPlanConfigComponent): string[] {
  return panel.render(80).map(strip);
}

describe('CodingPlanConfigComponent mouse', () => {
  it('selects the field under the pointer so typing lands there', () => {
    const panel = makePanel();
    const row = rows(panel).findIndex((line) => line.includes('Temperature'));
    expect(row).toBeGreaterThan(0);

    panel.handleMouse(mouse('click', row));
    panel.handleInput('0.5');

    expect(rows(panel)[row]).toContain('0.5');
    // The field above it kept its own (empty) value.
    const protocolRow = rows(panel).findIndex((line) => line.includes('Protocol'));
    expect(rows(panel)[protocolRow]).not.toContain('0.5');
  });

  it('steps the selected field with the wheel', () => {
    const panel = makePanel();
    const pointerRow = (): number => rows(panel).findIndex((line) => line.startsWith(' > '));
    const first = pointerRow();
    expect(first).toBeGreaterThan(0);

    panel.handleMouse(mouse('wheel', 0, 1));

    expect(pointerRow()).toBe(first + 1);
  });

  it('leaves the form unsaved when a field is clicked', () => {
    const onSave = mock();
    const panel = new CodingPlanConfigComponent({
      currentConfig: {},
      onSave,
      onCancel: mock(),
    });
    panel.focused = true;
    pastSettlingWindow();
    const row = rows(panel).findIndex((line) => line.includes('Max tokens'));

    panel.handleMouse(mouse('click', row));

    expect(onSave).not.toHaveBeenCalled();
  });
});
