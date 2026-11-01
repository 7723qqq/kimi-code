import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'bun:test';

import { mouse } from '#test/helpers/mouse';
import { ApiKeyInputDialogComponent } from '#/tui/components/dialogs/api-key-input-dialog';

const ANSI = /\u001B\[[0-9;]*m/g;
const strip = (text: string): string => text.replaceAll(ANSI, '');

function inputRow(dialog: ApiKeyInputDialogComponent): number {
  return dialog.render(60).findIndex((line) => strip(line).includes('> '));
}

describe('ApiKeyInputDialogComponent', () => {
  it('keeps every line within narrow widths', () => {
    const dialog = new ApiKeyInputDialogComponent(
      'Kimi Code',
      ['Paste your API key below.', 'It will be stored locally.'],
      () => {},
    );
    dialog.focused = true;

    for (const width of [39, 20, 10]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('places the caret where the input line was clicked', () => {
    const collected: string[] = [];
    const dialog = new ApiKeyInputDialogComponent('Kimi Code', ['Paste below.'], (result) => {
      if (result.kind === 'ok') collected.push(result.value);
    });
    dialog.focused = true;
    dialog.handleInput('abc');

    // Column 5 is the first text cell: border + padding + the `> ` prompt.
    dialog.handleMouse(mouse('click', inputRow(dialog), undefined, 5));
    dialog.handleInput('X');
    dialog.handleInput('\r');

    expect(collected).toEqual(['Xabc']);
  });

  it('only takes the keyboard on a click while unfocused', () => {
    const dialog = new ApiKeyInputDialogComponent('Kimi Code', ['Paste below.'], () => {});
    const row = inputRow(dialog);

    const result = dialog.handleMouse(mouse('click', row, undefined, 5));

    expect(result?.focus).toBe(true);
    expect(strip(dialog.render(60).join('\n'))).toContain('> ');
  });
});
