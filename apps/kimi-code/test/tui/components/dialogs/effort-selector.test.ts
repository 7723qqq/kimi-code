import { describe, expect, it, mock } from 'bun:test';

import { EffortSelectorComponent } from '#/tui/components/dialogs/effort-selector';
import { mouse, pastSettlingWindow } from '#test/helpers/mouse';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);
const LEFT = `${ESC}[D`;
const RIGHT = `${ESC}[C`;

function text(component: EffortSelectorComponent, width = 120): string {
  return component.render(width).map(strip).join('\n');
}

describe('EffortSelectorComponent', () => {
  it('renders efforts as horizontal segments with the active one bracketed', () => {
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect: mock(),
      onCancel: mock(),
    });
    const out = text(picker);
    expect(out).toContain('Off');
    expect(out).toContain('Low');
    expect(out).toContain('High');
    expect(out).toContain('Max');
    expect(out).toContain('[ High ]');
    expect(out).not.toContain('[ Off ]');
    expect(out).not.toContain('[ Max ]');
  });

  describe('mouse', () => {
    function segmentRow(
      picker: EffortSelectorComponent,
      label: string,
    ): { row: number; column: number } {
      const rows = picker.render(120).map(strip);
      const row = rows.findIndex((line) => line.includes('Off') && line.includes('Max'));
      return { row, column: rows[row]!.indexOf(label) };
    }

    it('picks the segment under the pointer', () => {
      const onSelect = mock();
      const picker = new EffortSelectorComponent({
        efforts: ['off', 'low', 'high', 'max'],
        currentValue: 'off',
        onSelect,
        onCancel: mock(),
      });
      picker.focused = true;
      pastSettlingWindow();

      const { row, column } = segmentRow(picker, 'Max');
      picker.handleMouse(mouse('click', row, undefined, column + 1));

      expect(onSelect).toHaveBeenCalledWith('max');
    });

    it('steps the highlight with the wheel without committing', () => {
      const onSelect = mock();
      const picker = new EffortSelectorComponent({
        efforts: ['off', 'low', 'high', 'max'],
        currentValue: 'off',
        onSelect,
        onCancel: mock(),
      });
      picker.focused = true;

      picker.handleMouse(mouse('wheel', 0, 1));

      expect(text(picker)).toContain('[ Low ]');
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  it('invokes onSelect with the chosen effort on Enter', () => {
    const onSelect = mock();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect,
      onCancel: mock(),
    });
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenCalledWith('high');
  });

  it('moves the active segment with Left/Right and stops at the edges', () => {
    const onSelect = mock();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect,
      onCancel: mock(),
    });

    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('max');

    picker.handleInput(RIGHT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('max');

    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('off');

    picker.handleInput(LEFT);
    picker.handleInput('\r');
    expect(onSelect).toHaveBeenLastCalledWith('off');
  });

  it('invokes onSessionOnlySelect on Alt+S instead of onSelect', () => {
    const onSelect = mock();
    const onSessionOnlySelect = mock();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect,
      onSessionOnlySelect,
      onCancel: mock(),
    });
    picker.handleInput(`${ESC}s`);
    expect(onSessionOnlySelect).toHaveBeenCalledWith('high');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('cancels on Escape', () => {
    const onCancel = mock();
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect: mock(),
      onCancel,
    });
    picker.handleInput(ESC);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders the warning line directly below the key-hint line when provided', () => {
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      warning: 'Switching may increase token usage.',
      onSelect: mock(),
      onCancel: mock(),
    });
    const lines = picker.render(120).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('←→ switch'));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(lines[hintIdx + 1]).toContain('Switching may increase token usage.');
  });

  it('renders no warning line without the warning option', () => {
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      onSelect: mock(),
      onCancel: mock(),
    });
    const lines = picker.render(120).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('←→ switch'));
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    expect(lines[hintIdx + 1]).toBe('');
  });

  it('updates the description as the highlighted effort changes', () => {
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'low',
      descriptions: {
        low: 'Light reasoning.',
        high: 'Deeper reasoning.',
        max: 'Maximum reasoning.',
      },
      onSelect: mock(),
      onCancel: mock(),
    });

    expect(text(picker)).toContain('Light reasoning.');
    expect(text(picker)).not.toContain('Deeper reasoning.');
    picker.handleInput(RIGHT);
    expect(text(picker)).toContain('Deeper reasoning.');
    picker.handleInput(RIGHT);
    expect(text(picker)).toContain('Maximum reasoning.');
    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    picker.handleInput(LEFT);
    expect(text(picker)).not.toContain('Light reasoning.');
    expect(text(picker)).not.toContain('Deeper reasoning.');
    expect(text(picker)).not.toContain('Maximum reasoning.');
  });

  it('wraps a warning longer than the width instead of truncating it', () => {
    const warning =
      'Note: Switching effort invalidates the existing prompt cache. Use /new to avoid extra token costs.';
    const picker = new EffortSelectorComponent({
      efforts: ['off', 'low', 'high', 'max'],
      currentValue: 'high',
      warning,
      onSelect: mock(),
      onCancel: mock(),
    });
    const lines = picker.render(40).map(strip);
    const hintIdx = lines.findIndex((l) => l.includes('←→ switch'));
    expect(lines[hintIdx + 1]).not.toBe('');
    expect(lines[hintIdx + 2]).not.toBe('');
    const squashed = lines.join('').replaceAll(/\s+/g, '');
    expect(squashed).toContain(warning.replaceAll(/\s+/g, ''));
  });
});
