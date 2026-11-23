import { beforeAll, describe, expect, it } from 'bun:test';

import { type TUI, visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import {
  FeedbackInputDialogComponent,
  type FeedbackInputDialogResult,
} from '#/tui/components/dialogs/feedback-input-dialog';
import { darkColors } from '#/tui/theme/colors';
import { mouse } from '#test/helpers/mouse';

const ESC = String.fromCodePoint(27);
const CTRL_C = String.fromCodePoint(3);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

function strip(text: string): string {
  return text.replaceAll(ANSI_RE, '');
}

beforeAll(() => {
  chalk.level = 3;
});

function makeDialog(): {
  dialog: FeedbackInputDialogComponent;
  collected: FeedbackInputDialogResult[];
} {
  const collected: FeedbackInputDialogResult[] = [];
  const tui = {
    requestRender: () => {},
    render: () => [],
    terminal: { rows: 40, cols: 120 },
  } as unknown as TUI;
  const dialog = new FeedbackInputDialogComponent(tui, (result) => {
    collected.push(result);
  });
  dialog.focused = true;
  return { dialog, collected };
}

async function submit(dialog: FeedbackInputDialogComponent): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200));
  dialog.handleInput('\r');
}

describe('FeedbackInputDialogComponent', () => {
  it('renders a blue rounded box with title, subtitle, and footer', () => {
    const { dialog } = makeDialog();
    const text = strip(dialog.render(60).join('\n'));

    expect(text).toContain('╭');
    expect(text).toContain('╮');
    expect(text).toContain('╰');
    expect(text).toContain('╯');
    expect(text).toContain('Send feedback to Kimi Code');
    expect(text).toContain("Tell us what's working or what's not.");
    expect(text).toContain('Enter submit');
    expect(text).toContain('Shift-Enter/Ctrl-J newline');
    expect(text).toContain('Esc cancel');
  });

  it('uses the primary color for the border', () => {
    const { dialog } = makeDialog();
    const rendered = dialog.render(60).join('\n');
    const sample = chalk.hex(darkColors.primary)('x');
    const ansiOpen = sample.split('x')[0]!;
    expect(rendered).toContain(`${ansiOpen}╭`);
    expect(rendered).toContain(`${ansiOpen}╰`);
  });

  it('keeps every line within narrow widths', () => {
    const { dialog } = makeDialog();

    for (const width of [39, 20, 10, 4]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('typing then pressing Enter submits the trimmed value', async () => {
    const { dialog, collected } = makeDialog();
    for (const ch of 'hello world ') {
      dialog.handleInput(ch);
    }
    await submit(dialog);
    expect(collected).toEqual([{ kind: 'ok', value: 'hello world' }]);
  });

  it('Enter on an empty input does not submit and shows an inline empty hint', async () => {
    const { dialog, collected } = makeDialog();
    await submit(dialog);
    expect(collected).toEqual([]);
    const text = strip(dialog.render(60).join('\n'));
    expect(text).toContain('Feedback cannot be empty.');
    expect(text).not.toContain("Tell us what's working or what's not.");
  });

  it('typing again after the empty hint clears the hint', async () => {
    const { dialog, collected } = makeDialog();
    await submit(dialog);
    expect(strip(dialog.render(60).join('\n'))).toContain('Feedback cannot be empty.');
    dialog.handleInput('a');
    const text = strip(dialog.render(60).join('\n'));
    expect(text).toContain("Tell us what's working or what's not.");
    expect(text).not.toContain('Feedback cannot be empty.');
    expect(collected).toEqual([]);
  });

  it('Esc cancels the dialog', () => {
    const { dialog, collected } = makeDialog();
    dialog.handleInput(ESC);
    expect(collected).toEqual([{ kind: 'cancel' }]);
  });

  it('Ctrl-C cancels the dialog', () => {
    const { dialog, collected } = makeDialog();
    dialog.handleInput(CTRL_C);
    expect(collected).toEqual([{ kind: 'cancel' }]);
  });

  it('does not fire onDone twice', async () => {
    const { dialog, collected } = makeDialog();
    dialog.handleInput('h');
    dialog.handleInput('i');
    await submit(dialog);
    dialog.handleInput('\r');
    dialog.handleInput(ESC);
    expect(collected).toEqual([{ kind: 'ok', value: 'hi' }]);
  });

  it('forwards clicks to the editor', async () => {
    const { dialog, collected } = makeDialog();
    dialog.handleInput('abc');
    const row = dialog.render(60).findIndex((line) => strip(line).includes('abc'));
    expect(row).toBeGreaterThan(0);

    dialog.handleMouse(mouse('click', row, undefined, 5));
    dialog.handleInput('X');
    await submit(dialog);

    const result = collected[0];
    expect(result?.kind).toBe('ok');
    if (result?.kind === 'ok') {
      expect(result.value.replace('X', '')).toBe('abc');
    }
  });
});
