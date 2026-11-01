import { describe, expect, it, mock, type Mock } from 'bun:test';

import { visibleWidth } from '@moonshot-ai/pi-tui';

import {
  CustomRegistryImportDialogComponent,
  type CustomRegistryImportResult,
} from '#/tui/components/dialogs/custom-registry-import';
import { mouse } from '#test/helpers/mouse';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;

function plain(component: CustomRegistryImportDialogComponent, width = 80): string {
  return component.render(width).map(strip).join('\n');
}

function makeDialog(defaultUrl = 'https://example.com/api.json'): {
  dialog: CustomRegistryImportDialogComponent;
  onDone: Mock<(...args: any[]) => any>;
} {
  const onDone = mock();
  const dialog = new CustomRegistryImportDialogComponent(
    onDone as unknown as (r: CustomRegistryImportResult) => void,
    defaultUrl,
  );
  dialog.focused = true;
  return { dialog, onDone };
}

describe('CustomRegistryImportDialogComponent', () => {
  it('advances from the URL field to the token field on Enter instead of submitting', () => {
    const { dialog, onDone } = makeDialog();
    expect(plain(dialog)).toContain('next field');

    dialog.handleInput('\r');

    expect(onDone).not.toHaveBeenCalled();
    expect(plain(dialog)).toContain('Enter to submit');
  });

  it('switches fields with Up / Down arrows', () => {
    const { dialog } = makeDialog();
    dialog.handleInput(DOWN);
    expect(plain(dialog)).toContain('Enter to submit');
    dialog.handleInput(UP);
    expect(plain(dialog)).toContain('next field');
  });

  it('submits with an empty Bearer token for public registries', () => {
    const { dialog, onDone } = makeDialog();
    dialog.handleInput('\r'); // url -> token
    dialog.handleInput('\r'); // submit with an empty token

    expect(onDone).toHaveBeenCalledWith({
      kind: 'ok',
      value: { url: 'https://example.com/api.json', apiKey: undefined },
    });
  });

  it('submits the url and token once both are provided', () => {
    const { dialog, onDone } = makeDialog();
    dialog.handleInput('\r'); // url -> token
    for (const ch of 'sk-tok') dialog.handleInput(ch);
    dialog.handleInput('\r'); // submit from the token field

    expect(onDone).toHaveBeenCalledWith({
      kind: 'ok',
      value: { url: 'https://example.com/api.json', apiKey: 'sk-tok' },
    });
  });

  it('keeps every line within narrow widths', () => {
    const { dialog } = makeDialog('https://example.com/very/long/registry/path.json');

    for (const width of [39, 35, 20, 10]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('moves the caret into whichever field was clicked', () => {
    const { dialog, onDone } = makeDialog('https://example.com/api.json');
    const rows = dialog.render(80).map(strip);
    const urlRow = rows.findIndex((line) => line.includes('Registry URL')) + 1;
    const tokenRow = rows.findIndex((line) => line.includes('Bearer token (optional)')) + 1;
    expect(urlRow).toBeGreaterThan(0);
    expect(tokenRow).toBeGreaterThan(urlRow);
    // The caret marker sits inside the value line; drop it before comparing.
    const visible = (): string => plain(dialog).replaceAll('\u001b_pi:c\u0007', '');

    // Click the URL line and type: the character lands at the caret the click
    // placed, i.e. at the start of the value.
    dialog.handleMouse(mouse('click', urlRow, undefined, 5));
    dialog.handleInput('u');
    expect(visible()).toContain('> uhttps://example.com/api.json');

    // The token field is masked, so its value is invisible; what proves the
    // switch is that typing there leaves the URL alone.
    dialog.handleMouse(mouse('click', tokenRow, undefined, 5));
    dialog.handleInput('t');
    expect(visible()).toContain('> uhttps://example.com/api.json');

    // And back: the URL keeps taking keystrokes.
    dialog.handleMouse(mouse('click', urlRow, undefined, 5));
    dialog.handleInput('v');
    expect(visible()).toContain('> vuhttps://example.com/api.json');
    expect(onDone).not.toHaveBeenCalled();
  });
});
