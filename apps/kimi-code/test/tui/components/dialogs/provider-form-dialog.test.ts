import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import { t } from '#/i18n';
import {
  ProviderFormDialogComponent,
  type ProviderFormDialogOptions,
  type ProviderFormDialogResult,
  type ProviderFormInitial,
} from '#/tui/components/dialogs/provider-form-dialog';
import {
  PROVIDER_WIRE_TYPES,
  type ProviderFormModelRow,
  type ProviderFormValue,
} from '#/utils/provider-form';

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
const CTRL_E = '\u0005';
const CTRL_R = '\u0012';
const BACKSPACE = '\u007F';

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
  dialog.handleInput(ENTER); // context -> max input
  dialog.handleInput(ENTER); // max input -> max output
  dialog.handleInput(ENTER); // max output -> display name
  typeText(dialog, 'GPT-4.1');
  dialog.handleInput(ENTER); // display name -> capabilities
  enterRowFields(dialog, 5); // the optional tail, then the write back
}

/** Enters through `count` row fields; the last press commits and returns to the list. */
function enterRowFields(dialog: ProviderFormDialogComponent, count: number): void {
  for (let i = 0; i < count; i++) dialog.handleInput(ENTER);
}

/** Steps the row editor's field cursor down `count` times from `model`. */
function focusRowField(dialog: ProviderFormDialogComponent, count: number): void {
  for (let i = 0; i < count; i++) dialog.handleInput(DOWN);
}

/** Enters `next` into a prefilled input: cursor to the end, erase, then type. */
function replaceText(dialog: ProviderFormDialogComponent, current: string, next: string): void {
  dialog.handleInput(CTRL_E); // cursor to the end of the prefilled value
  for (let i = 0; i < current.length; i++) dialog.handleInput(BACKSPACE);
  typeText(dialog, next);
}

/** The single `ok` value the dialog submitted, or a failure when it did not. */
function submittedValue(onDone: ReturnType<typeof vi.fn>): ProviderFormValue {
  expect(onDone).toHaveBeenCalled();
  const result = onDone.mock.calls.at(-1)?.[0] as ProviderFormDialogResult;
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') throw new Error('the dialog did not submit a value');
  return result.value;
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

/** A row that declares every optional field, for prefill / round-trip cases. */
const RICH_ROW: ProviderFormModelRow = {
  model: 'gpt-4.1',
  maxContextSize: '128000',
  displayName: 'GPT-4.1',
  capabilities: ['tool_use', 'image_in'],
  maxInputSize: '272000',
  maxOutputSize: '8192',
  supportEfforts: 'low, high',
  defaultEffort: 'high',
  offEffort: 'none',
  adaptiveThinking: true,
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
    dialog.handleInput(ENTER); // context -> max input
    dialog.handleInput(ENTER); // max input -> max output
    dialog.handleInput(ENTER); // max output -> display name
    typeText(dialog, 'GPT-4.1');
    dialog.handleInput(ENTER); // display name -> capabilities
    enterRowFields(dialog, 5); // last field: write back and return to the list
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
    dialog.handleInput(ENTER); // context -> max input
    enterRowFields(dialog, 8); // through the empty fields and the toggles, then commit
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
    dialog.handleInput(ENTER); // context -> max input
    enterRowFields(dialog, 8); // through the optional fields, then commit
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

  it('renders the optional row fields and the capability picker', () => {
    const { dialog } = makeDialog({ mode: 'add' });
    tabToModels(dialog);
    dialog.handleInput(ENTER); // open the row editor

    const out = plain(dialog);
    expect(out).toContain(t(`${FORM}.optionalHint`));
    for (const key of [
      'maxInputSizeLabel',
      'maxOutputSizeLabel',
      'supportEffortsLabel',
      'defaultEffortLabel',
      'offEffortLabel',
      'adaptiveThinkingLabel',
    ]) {
      expect(out).toContain(t(`${FORM}.${key}`));
    }
    expect(out).toContain(t(`${FORM}.capabilitiesValue`, { value: t(`${FORM}.capabilitiesNone`) }));
    expect(out).toContain('‹ [ ] image_in ›');
    expect(out).toContain('[ ] disabled');
    // Each hint belongs to its focused field only.
    expect(out).not.toContain(t(`${FORM}.capabilitiesHint`));

    focusRowField(dialog, 2); // model → context → max input
    expect(plain(dialog)).toContain(t(`${FORM}.maxInputSizeHint`));
    dialog.handleInput(DOWN); // -> max output: the previous hint disappears
    expect(plain(dialog)).not.toContain(t(`${FORM}.maxInputSizeHint`));
    focusRowField(dialog, 2); // -> capabilities
    expect(plain(dialog)).toContain(t(`${FORM}.capabilitiesHint`));
    dialog.handleInput(DOWN); // -> thinking efforts
    expect(plain(dialog)).toContain(t(`${FORM}.supportEffortsHint`));
    focusRowField(dialog, 3); // -> adaptive thinking
    expect(plain(dialog)).toContain(t(`${FORM}.adaptiveThinkingHint`));
  });

  it('moves the capability cursor with Left / Right and toggles with Space', () => {
    const { dialog, onDone } = makeDialog({ mode: 'add' });
    fillAddForm(dialog);
    dialog.handleInput(ENTER); // reopen the row editor
    focusRowField(dialog, 5); // model → capabilities

    expect(plain(dialog)).toContain(
      t(`${FORM}.capabilitiesValue`, { value: t(`${FORM}.capabilitiesNone`) }),
    );
    dialog.handleInput(LEFT); // wraps to the last name
    expect(plain(dialog)).toContain('‹ [ ] dynamically_loaded_tools ›');
    dialog.handleInput(' ');
    expect(plain(dialog)).toContain('‹ [✓] dynamically_loaded_tools ›');
    expect(plain(dialog)).toContain(
      t(`${FORM}.capabilitiesValue`, { value: 'dynamically_loaded_tools' }),
    );
    dialog.handleInput(RIGHT); // wraps back to the first name
    dialog.handleInput(' '); // image_in on
    expect(plain(dialog)).toContain(
      t(`${FORM}.capabilitiesValue`, { value: 'image_in, dynamically_loaded_tools' }),
    );
    dialog.handleInput(' '); // and off again
    expect(plain(dialog)).toContain(
      t(`${FORM}.capabilitiesValue`, { value: 'dynamically_loaded_tools' }),
    );
    enterRowFields(dialog, 5); // commit
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    expect(submittedValue(onDone).models?.[0]?.capabilities).toEqual(['dynamically_loaded_tools']);
  });

  it('toggles adaptive thinking with Space', () => {
    const { dialog, onDone } = makeDialog({ mode: 'add' });
    fillAddForm(dialog);
    dialog.handleInput(ENTER); // reopen the row editor
    focusRowField(dialog, 9); // model → adaptive thinking

    expect(plain(dialog)).toContain('[ ] disabled');
    dialog.handleInput(' ');
    expect(plain(dialog)).toContain('[✓] enabled');
    dialog.handleInput(' '); // off again
    expect(plain(dialog)).toContain('[ ] disabled');
    dialog.handleInput(' '); // on: what gets submitted
    enterRowFields(dialog, 1); // commit
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    expect(submittedValue(onDone).models?.[0]?.adaptiveThinking).toBe(true);
  });

  it('submits every optional row field the editor declares', () => {
    const { dialog, onDone } = makeDialog({ mode: 'add' });
    fillAddForm(dialog);
    dialog.handleInput(ENTER); // reopen the row editor
    focusRowField(dialog, 2); // model → max input
    typeText(dialog, '272000');
    dialog.handleInput(ENTER); // -> max output
    typeText(dialog, '8192');
    dialog.handleInput(ENTER); // -> display name
    dialog.handleInput(ENTER); // -> capabilities
    dialog.handleInput(RIGHT); // video_in
    dialog.handleInput(' ');
    dialog.handleInput(ENTER); // -> thinking efforts
    typeText(dialog, 'low, medium, high');
    dialog.handleInput(ENTER); // -> default effort
    typeText(dialog, 'high');
    dialog.handleInput(ENTER); // -> off effort
    typeText(dialog, 'none');
    dialog.handleInput(ENTER); // -> adaptive thinking
    dialog.handleInput(' ');
    enterRowFields(dialog, 1); // commit
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    expect(submittedValue(onDone).models?.[0]).toEqual({
      model: 'gpt-4.1',
      maxContextSize: '128000',
      displayName: 'GPT-4.1',
      capabilities: ['video_in'],
      maxInputSize: '272000',
      maxOutputSize: '8192',
      supportEfforts: 'low, medium, high',
      defaultEffort: 'high',
      offEffort: 'none',
      adaptiveThinking: true,
    });
  });

  it('leaves the optional fields absent when the editor never set them', () => {
    const { dialog, onDone } = makeDialog({ mode: 'add' });
    fillAddForm(dialog);
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    // `undefined` is not `''`: a new row must not claim it cleared fields the
    // user never opened, or the alias would lose its inferred defaults.
    expect(Object.keys(submittedValue(onDone).models?.[0] ?? {})).toEqual([
      'model',
      'maxContextSize',
      'displayName',
    ]);
  });

  it('prefills an existing row and writes the untouched optional fields back', () => {
    const { dialog, onDone } = makeDialog({
      mode: 'edit',
      provider: { ...EDIT_PROVIDER, models: [RICH_ROW] },
    });
    tabToModels(dialog);
    dialog.handleInput(ENTER); // open the row editor

    const out = plain(dialog);
    expect(out).toContain(t(`${FORM}.capabilitiesValue`, { value: 'tool_use, image_in' }));
    expect(out).toContain('‹ [✓] image_in ›');
    expect(out).toContain('272000');
    expect(out).toContain('8192');
    expect(out).toContain('low, high');
    expect(out).toContain('none');
    expect(out).toContain('[✓] enabled');

    enterRowFields(dialog, 10); // model → … → commit, changing nothing
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    expect(submittedValue(onDone).models?.[0]).toEqual(RICH_ROW);
  });

  it('commits a cleared optional field as an empty string, not as absent', () => {
    const { dialog, onDone } = makeDialog({
      mode: 'edit',
      provider: { ...EDIT_PROVIDER, models: [RICH_ROW] },
    });
    tabToModels(dialog);
    dialog.handleInput(ENTER); // open the row editor
    focusRowField(dialog, 2); // model → max input
    replaceText(dialog, '272000', ''); // cleared on purpose
    focusRowField(dialog, 7); // -> adaptive thinking
    dialog.handleInput(' '); // on → off: also an explicit clear
    enterRowFields(dialog, 1); // commit
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    const row = submittedValue(onDone).models?.[0];
    expect(row?.maxInputSize).toBe('');
    expect(row?.adaptiveThinking).toBe(false);
    expect(row?.maxOutputSize).toBe('8192'); // an untouched sibling still round-trips
  });

  it('shows error.capabilityUnknown and focuses the capability picker', () => {
    const { dialog, onDone } = makeDialog({
      mode: 'edit',
      provider: { ...EDIT_PROVIDER, models: [{ ...RICH_ROW, capabilities: ['tool_use', 'pdf'] }] },
    });
    for (let i = 0; i < 5; i++) dialog.handleInput(TAB); // id → save
    dialog.handleInput(ENTER);

    expect(onDone).not.toHaveBeenCalled();
    const out = plain(dialog);
    expect(out).toContain(t(`${FORM}.error.capabilityUnknown`));
    expect(footerOf(dialog)).toBe('row');
    expect(out).toContain(t(`${FORM}.capabilitiesHint`));

    // Any toggle rebuilds the list from the offered names, which drops the
    // unknown one and unblocks the save.
    dialog.handleInput(' '); // image_in on, 'pdf' dropped
    expect(plain(dialog)).toContain(
      t(`${FORM}.capabilitiesValue`, { value: 'image_in, tool_use' }),
    );
    enterRowFields(dialog, 5); // commit
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    expect(submittedValue(onDone).models?.[0]?.capabilities).toEqual(['image_in', 'tool_use']);
  });

  it('shows error.defaultEffortNotSupported and focuses the default effort input', () => {
    const { dialog, onDone } = makeDialog({ mode: 'add' });
    fillAddForm(dialog);
    dialog.handleInput(ENTER); // reopen the row editor
    focusRowField(dialog, 6); // model → thinking efforts
    typeText(dialog, 'low, high');
    dialog.handleInput(ENTER); // -> default effort
    typeText(dialog, 'max'); // not in the declared list
    enterRowFields(dialog, 3); // -> off effort, adaptive thinking, commit
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    expect(onDone).not.toHaveBeenCalled();
    const out = plain(dialog);
    expect(out).toContain(t(`${FORM}.error.defaultEffortNotSupported`));
    expect(footerOf(dialog)).toBe('row');
    expect(out).toContain(t(`${FORM}.modelRowLabel`, { index: '1', model: 'gpt-4.1' }));

    dialog.handleInput(BACKSPACE); // the focus landed on the default effort input
    expect(plain(dialog)).toContain('> ma');
    expect(plain(dialog)).not.toContain('> max');
  });

  it('keeps every row-editor line within narrow widths', () => {
    const { dialog } = makeDialog({
      mode: 'edit',
      provider: { ...EDIT_PROVIDER, models: [RICH_ROW] },
    });
    tabToModels(dialog);
    dialog.handleInput(ENTER); // open the row editor

    // Walk every row field so each focused hint is rendered at least once.
    for (let focus = 0; focus < 10; focus++) {
      if (focus > 0) dialog.handleInput(DOWN);
      for (const width of [39, 35, 20, 10]) {
        for (const line of dialog.render(width)) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
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
