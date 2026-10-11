import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { t } from '#/i18n';
import {
  ProviderFormDialogComponent,
  type ProviderFormDialogOptions,
  type ProviderFormDialogResult,
  type ProviderFormInitial,
} from '#/tui/components/dialogs/provider-form-dialog';
import { PROVIDER_WIRE_TYPES } from '#/utils/provider-form';

// CSI color/reset sequences plus pi-tui's IME cursor marker.
const ANSI = /\u001B\[[0-9;]*m|\u001B_pi:c\u0007/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');
const ESC = String.fromCodePoint(27);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const RIGHT = `${ESC}[C`;
const LEFT = `${ESC}[D`;
const SHIFT_TAB = `${ESC}[Z`;
const TAB = '\t';
const ENTER = '\r';
const CTRL_R = '\u0012';

const FORM = 'tui.dialogs.providerForm';

function plain(component: ProviderFormDialogComponent, width = 80): string {
  return component.render(width).map(strip).join('\n');
}

function typeText(dialog: ProviderFormDialogComponent, text: string): void {
  for (const ch of text) dialog.handleInput(ch);
}

/** Row summaries are the only list rows shaped `│  ❯ 1. …`. */
function rowCount(dialog: ProviderFormDialogComponent): number {
  return dialog
    .render(80)
    .map(strip)
    .filter((line) => /^\s*│\s+(?:❯ | {2})\d+\. /.test(line)).length;
}

function footerOf(dialog: ProviderFormDialogComponent): string {
  const out = plain(dialog);
  const known: readonly [string, string][] = [
    ['readonly', t(`${FORM}.managedReadonly`)],
    ['row', t(`${FORM}.footerRow`)],
    ['list', t(`${FORM}.footerList`)],
    ['save', t(`${FORM}.footerSave`)],
    ['fields', t(`${FORM}.footerFields`)],
  ];
  for (const [name, text] of known) {
    if (out.includes(text)) return name;
  }
  return 'none';
}

function makeDialog(options: ProviderFormDialogOptions): {
  dialog: ProviderFormDialogComponent;
  onDone: ReturnType<typeof vi.fn>;
} {
  const onDone = vi.fn();
  const dialog = new ProviderFormDialogComponent(
    onDone as unknown as (r: ProviderFormDialogResult) => void,
    options,
  );
  dialog.focused = true;
  return { dialog, onDone };
}

function tabToModels(dialog: ProviderFormDialogComponent): void {
  dialog.handleInput(TAB); // id -> type
  dialog.handleInput(TAB); // type -> apiKey
  dialog.handleInput(TAB); // apiKey -> baseUrl
  dialog.handleInput(TAB); // baseUrl -> models
}

/** Fills id / apiKey / baseUrl and one model row, then returns at the list. */
function fillAddForm(dialog: ProviderFormDialogComponent, contextSize = '128000'): void {
  typeText(dialog, 'demo');
  dialog.handleInput(ENTER); // id -> type
  dialog.handleInput(ENTER); // type -> apiKey
  typeText(dialog, 'sk-test');
  dialog.handleInput(ENTER); // apiKey -> baseUrl
  typeText(dialog, 'https://api.example.com/v1');
  dialog.handleInput(ENTER); // baseUrl -> models
  dialog.handleInput(ENTER); // open the row editor
  typeText(dialog, 'gpt-4.1');
  dialog.handleInput(ENTER); // model -> context
  typeText(dialog, contextSize);
  dialog.handleInput(ENTER); // context -> display name
  typeText(dialog, 'GPT-4.1');
  dialog.handleInput(ENTER); // commit, back to the list
}

const EDIT_PROVIDER: ProviderFormInitial = {
  id: 'demo',
  type: 'openai',
  apiKey: 'sk-secret',
  baseUrl: 'https://api.example.com/v1',
  models: [{ model: 'gpt-4.1', maxContextSize: '128000', displayName: 'GPT-4.1' }],
};

const MANAGED_PROVIDER: ProviderFormInitial = {
  ...EDIT_PROVIDER,
  id: 'managed',
  oauth: { storage: 'file', key: 'managed-demo' },
};

describe('ProviderFormDialogComponent', () => {
  it('renders the five field labels and no default-model field', () => {
    const { dialog } = makeDialog({ mode: 'add' });
    const out = plain(dialog);

    expect(out).toContain(t(`${FORM}.titleAdd`));
    for (const key of ['idLabel', 'typeLabel', 'apiKeyLabel', 'baseUrlLabel', 'modelsLabel']) {
      expect(out).toContain(t(`${FORM}.${key}`));
    }
    expect(out).toContain(t(`${FORM}.save`));
    expect(out.toLowerCase()).not.toContain('default model');
  });

  it('cycles the wire type in PROVIDER_WIRE_TYPES order and wraps', () => {
    const { dialog } = makeDialog({ mode: 'add' });
    dialog.handleInput(ENTER); // id -> type

    for (const type of PROVIDER_WIRE_TYPES.slice(1)) {
      dialog.handleInput(RIGHT);
      expect(plain(dialog)).toContain(`‹ ${type} ›`);
    }
    dialog.handleInput(RIGHT);
    expect(plain(dialog)).toContain(`‹ ${PROVIDER_WIRE_TYPES[0]} ›`);
    dialog.handleInput(LEFT);
    expect(plain(dialog)).toContain(`‹ ${PROVIDER_WIRE_TYPES.at(-1) ?? ''} ›`);
    // Space cycles forward as well.
    dialog.handleInput(' ');
    expect(plain(dialog)).toContain(`‹ ${PROVIDER_WIRE_TYPES[0]} ›`);
  });

  it('re-normalizes a filled base URL when the type switches', () => {
    const { dialog } = makeDialog({ mode: 'add' });
    dialog.handleInput(ENTER); // id -> type
    dialog.handleInput(ENTER); // type -> apiKey
    dialog.handleInput(ENTER); // apiKey -> baseUrl
    typeText(dialog, 'https://api.example.com/v1');

    dialog.handleInput(SHIFT_TAB); // baseUrl -> apiKey
    dialog.handleInput(SHIFT_TAB); // apiKey -> type
    dialog.handleInput(RIGHT); // kimi -> openai
    dialog.handleInput(RIGHT); // openai -> openai_responses
    dialog.handleInput(RIGHT); // openai_responses -> anthropic
    expect(plain(dialog)).not.toContain('/v1');

    dialog.handleInput(RIGHT); // anthropic -> google-genai keeps it stripped
    expect(plain(dialog)).not.toContain('/v1');
  });

  it('moves focus in the design order with Tab and Shift-Tab', () => {
    const { dialog } = makeDialog({ mode: 'add' });

    expect(footerOf(dialog)).toBe('fields'); // id

    dialog.handleInput(TAB); // type
    expect(footerOf(dialog)).toBe('fields');
    dialog.handleInput(TAB); // apiKey — the reveal affordance marks the field
    expect(footerOf(dialog)).toBe('fields');
    expect(plain(dialog)).toContain(t(`${FORM}.apiKeyRevealHint`));
    dialog.handleInput(TAB); // baseUrl
    expect(footerOf(dialog)).toBe('fields');
    dialog.handleInput(TAB); // models — its own footer and legend
    expect(footerOf(dialog)).toBe('list');
    expect(plain(dialog)).toContain(t(`${FORM}.addRow`));
    dialog.handleInput(TAB); // save
    expect(footerOf(dialog)).toBe('save');
    dialog.handleInput(TAB); // wraps back to id
    expect(footerOf(dialog)).toBe('fields');
    dialog.handleInput(SHIFT_TAB); // wraps back to save
    expect(footerOf(dialog)).toBe('save');
  });

  it('appends rows with A and refuses to delete the last row', () => {
    const { dialog } = makeDialog({ mode: 'add' });
    tabToModels(dialog);

    expect(rowCount(dialog)).toBe(1);
    dialog.handleInput(DOWN);
    dialog.handleInput('D');
    expect(rowCount(dialog)).toBe(1);

    dialog.handleInput('A'); // appends and opens the row editor
    expect(plain(dialog)).toContain(t(`${FORM}.modelRowLabel`, { index: '2', model: '' }));
    dialog.handleInput(ESC); // discards the new row's edit but keeps the row
    expect(rowCount(dialog)).toBe(2);

    dialog.handleInput(UP); // back to row 1
    dialog.handleInput('D'); // two rows: deletion allowed
    expect(rowCount(dialog)).toBe(1);
  });

  it('writes an edited row back into the summary list and discards on Esc', () => {
    const { dialog } = makeDialog({ mode: 'add' });
    tabToModels(dialog);

    dialog.handleInput(ENTER);
    expect(plain(dialog)).toContain(t(`${FORM}.modelIdLabel`));
    typeText(dialog, 'gpt-4.1');
    dialog.handleInput(ENTER);
    typeText(dialog, '128000');
    dialog.handleInput(ENTER);
    typeText(dialog, 'GPT-4.1');
    dialog.handleInput(ENTER); // last field: write back and return to the list
    const out = plain(dialog);
    expect(out).toContain('1. gpt-4.1');
    expect(out).toContain('128000');
    expect(out).not.toContain(t(`${FORM}.modelIdLabel`));

    dialog.handleInput(ENTER);
    typeText(dialog, 'typed-away');
    dialog.handleInput(ESC); // discard this row
    expect(plain(dialog)).toContain('1. gpt-4.1');
    expect(plain(dialog)).not.toContain('typed-away');
  });

  it('submits the typed values', () => {
    const { dialog, onDone } = makeDialog({ mode: 'add' });
    fillAddForm(dialog);
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    expect(onDone).toHaveBeenCalledWith({
      kind: 'ok',
      value: {
        id: 'demo',
        type: 'kimi',
        apiKey: 'sk-test',
        baseUrl: 'https://api.example.com/v1',
        models: [{ model: 'gpt-4.1', maxContextSize: '128000', displayName: 'GPT-4.1' }],
      },
    });
  });

  it('keeps the input and shows error.apiKeyRequired when the key is missing', () => {
    const { dialog, onDone } = makeDialog({ mode: 'add' });
    typeText(dialog, 'demo');
    dialog.handleInput(ENTER); // id -> type
    dialog.handleInput(ENTER); // type -> apiKey
    dialog.handleInput(ENTER); // empty api key is allowed to advance
    typeText(dialog, 'https://api.example.com');
    dialog.handleInput(ENTER); // baseUrl -> models
    dialog.handleInput(ENTER); // row editor
    typeText(dialog, 'gpt-4.1');
    dialog.handleInput(ENTER);
    typeText(dialog, '128000');
    dialog.handleInput(ENTER);
    dialog.handleInput(ENTER); // commit
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    expect(onDone).not.toHaveBeenCalled();
    const out = plain(dialog);
    expect(out).toContain(t(`${FORM}.error.apiKeyRequired`));
    expect(out).toContain('demo');
    expect(out).toContain('https://api.example.com');
    expect(out).toContain('1. gpt-4.1');
    // Focus jumped back to the offending field, keeping every typed value.
    expect(footerOf(dialog)).toBe('fields');
    expect(out).toContain(t(`${FORM}.apiKeyRevealHint`));
  });

  it('rejects a context size of 0 and focuses the offending row field', () => {
    const { dialog, onDone } = makeDialog({ mode: 'add' });
    fillAddForm(dialog, '0');
    dialog.handleInput(TAB);
    dialog.handleInput(ENTER);

    expect(onDone).not.toHaveBeenCalled();
    expect(plain(dialog)).toContain(t(`${FORM}.error.contextSizeInvalid`));
    expect(footerOf(dialog)).toBe('row');
    expect(plain(dialog)).toContain(t(`${FORM}.modelRowLabel`, { index: '1', model: 'gpt-4.1' }));
  });

  it('prefills edit mode, masks the API key, and toggles it with Ctrl-R', () => {
    const { dialog, onDone } = makeDialog({ mode: 'edit', provider: EDIT_PROVIDER });
    const out = plain(dialog);

    expect(out).toContain(t(`${FORM}.titleEdit`));
    expect(out).toContain('demo');
    expect(out).toContain('https://api.example.com/v1');
    expect(out).toContain('1. gpt-4.1');
    expect(out).not.toContain('sk-secret');
    expect(out).toContain('•');

    dialog.handleInput(ENTER); // id -> type
    dialog.handleInput(ENTER); // type -> apiKey
    expect(plain(dialog)).toContain(t(`${FORM}.apiKeyRevealHint`));

    dialog.handleInput(CTRL_R); // reveal
    expect(plain(dialog)).toContain('sk-secret');
    dialog.handleInput(CTRL_R); // mask again
    expect(plain(dialog)).not.toContain('sk-secret');

    expect(onDone).not.toHaveBeenCalled();
  });

  it('does not require an API key when editing a provider that has none', () => {
    const { dialog, onDone } = makeDialog({
      mode: 'edit',
      provider: { id: 'demo', type: 'openai', baseUrl: 'https://api.example.com', models: [] },
    });
    dialog.handleInput(ENTER); // id -> type
    dialog.handleInput(ENTER); // type -> apiKey
    dialog.handleInput(ENTER); // type? no: apiKey -> baseUrl (empty key is fine)
    dialog.handleInput(ENTER); // baseUrl -> models
    dialog.handleInput(ENTER); // row editor
    typeText(dialog, 'gpt-4.1');
    dialog.handleInput(ENTER);
    typeText(dialog, '128000');
    dialog.handleInput(ENTER);
    dialog.handleInput(ENTER); // commit
    dialog.handleInput(TAB); // -> save
    dialog.handleInput(ENTER);

    expect(onDone).toHaveBeenCalledWith({
      kind: 'ok',
      value: {
        id: 'demo',
        type: 'openai',
        apiKey: '',
        baseUrl: 'https://api.example.com',
        models: [{ model: 'gpt-4.1', maxContextSize: '128000', displayName: '' }],
      },
    });
  });

  it('renders a managed provider read-only', () => {
    const { dialog, onDone } = makeDialog({ mode: 'edit', provider: MANAGED_PROVIDER });

    expect(dialog.disabled).toBe(true);
    const out = plain(dialog);
    expect(out).toContain(t(`${FORM}.managedReadonly`));
    expect(out).toContain(t(`${FORM}.apiKeyManaged`));
    expect(out).not.toContain(t(`${FORM}.footerFields`));
    // The stored credential is prefilled, but it never reaches the screen —
    // not even in the read-only rendering.
    expect(out).not.toContain('sk-secret');
    expect(out).toContain('•');

    // Every key is inert: no focus, no value change, no submit.
    const before = plain(dialog);
    for (const key of ['x', TAB, SHIFT_TAB, UP, DOWN, LEFT, RIGHT, ENTER, 'A', 'D', 'E', CTRL_R]) {
      dialog.handleInput(key);
    }
    expect(plain(dialog)).toBe(before);
    expect(plain(dialog)).not.toContain('sk-secret');
    expect(onDone).not.toHaveBeenCalled();

    dialog.handleInput(ESC);
    expect(onDone).toHaveBeenCalledWith({ kind: 'cancel' });
  });

  it('keeps every line within narrow widths', () => {
    const { dialog } = makeDialog({ mode: 'edit', provider: EDIT_PROVIDER });

    for (const width of [39, 35, 20, 10]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('cancels with Esc and Ctrl-C', () => {
    const esc = makeDialog({ mode: 'add' });
    esc.dialog.handleInput(ESC);
    expect(esc.onDone).toHaveBeenCalledWith({ kind: 'cancel' });

    const ctrlC = makeDialog({ mode: 'add' });
    ctrlC.dialog.handleInput('\u0003');
    expect(ctrlC.onDone).toHaveBeenCalledWith({ kind: 'cancel' });
  });
});
