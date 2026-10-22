import { visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { afterAll, beforeAll, describe, expect, it, mock, type Mock } from 'bun:test';

import { t } from '#/i18n';
import {
  ProviderFormDialogComponent,
  type ProviderFormDialogOptions,
  type ProviderFormDialogResult,
  type ProviderFormInitial,
} from '#/tui/components/dialogs/provider-form-dialog';
import { currentTheme } from '#/tui/theme';
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
const CTRL_X = '\u0018';
const BACKSPACE = '\u007F';

const FORM = 'tui.dialogs.providerForm';

function plain(component: ProviderFormDialogComponent, width = 80): string {
  return component.render(width).map(strip).join('\n');
}

/** The raw render: what {@link plain} strips away is what a colour assertion needs. */
function raw(component: ProviderFormDialogComponent, width = 80): string {
  return component.render(width).join('\n');
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
  onDone: Mock<(...args: any[]) => any>;
} {
  const onDone = mock();
  const dialog = new ProviderFormDialogComponent(
    onDone as unknown as (r: ProviderFormDialogResult) => void,
    options,
  );
  dialog.focused = true;
  return { dialog, onDone };
}

/**
 * Row-editor walks: the Enter presses from a field through the write back. The
 * tail is capabilities → support efforts → default effort → off effort →
 * adaptive thinking → protocol → beta API → reasoning key → base URL → commit.
 */
const ROW_TO_COMMIT_FROM_MODEL = 14;
const ROW_TO_COMMIT_FROM_MAX_INPUT = 12;
const ROW_TO_COMMIT_FROM_CAPABILITIES = 9;

function tabToModels(dialog: ProviderFormDialogComponent): void {
  dialog.handleInput(TAB); // id -> type
  dialog.handleInput(TAB); // type -> apiKey
  dialog.handleInput(TAB); // apiKey -> apiKeyEnv
  dialog.handleInput(TAB); // apiKeyEnv -> baseUrl
  dialog.handleInput(TAB); // baseUrl -> defaultModel
  dialog.handleInput(TAB); // defaultModel -> customHeaders
  dialog.handleInput(TAB); // customHeaders -> env
  dialog.handleInput(TAB); // env -> models
}

/** Fills id / apiKey / baseUrl and one model row, then returns at the list. */
function fillAddForm(dialog: ProviderFormDialogComponent, contextSize = '128000'): void {
  typeText(dialog, 'demo');
  dialog.handleInput(ENTER); // id -> type
  dialog.handleInput(ENTER); // type -> apiKey
  typeText(dialog, 'sk-test');
  dialog.handleInput(ENTER); // apiKey -> apiKeyEnv
  dialog.handleInput(ENTER); // apiKeyEnv -> baseUrl, left blank on purpose
  typeText(dialog, 'https://api.example.com/v1');
  dialog.handleInput(ENTER); // baseUrl -> defaultModel
  dialog.handleInput(ENTER); // defaultModel -> customHeaders
  dialog.handleInput(ENTER); // customHeaders -> env
  dialog.handleInput(ENTER); // env -> models
  dialog.handleInput(ENTER); // open the row editor
  typeText(dialog, 'gpt-4.1');
  dialog.handleInput(ENTER); // model -> context
  typeText(dialog, contextSize);
  dialog.handleInput(ENTER); // context -> max input
  dialog.handleInput(ENTER); // max input -> max output
  dialog.handleInput(ENTER); // max output -> display name
  typeText(dialog, 'GPT-4.1');
  dialog.handleInput(ENTER); // display name -> capabilities
  enterRowFields(dialog, ROW_TO_COMMIT_FROM_CAPABILITIES); // the optional tail, then the write back
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
function submittedValue(onDone: Mock<(...args: any[]) => any>): ProviderFormValue {
  expect(onDone).toHaveBeenCalled();
  const result = onDone.mock.calls.at(-1)?.[0] as ProviderFormDialogResult;
  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') throw new Error('the dialog did not submit a value');
  return result.value;
}

/** Presses Enter until the row editor closes, whatever the field walk is. */
function commitRow(dialog: ProviderFormDialogComponent): void {
  for (let i = 0; i < 20 && plain(dialog).includes(t(`${FORM}.modelIdLabel`)); i++) {
    dialog.handleInput(ENTER);
  }
  expect(plain(dialog)).not.toContain(t(`${FORM}.modelIdLabel`));
}

const EDIT_PROVIDER: ProviderFormInitial = {
  id: 'demo',
  type: 'openai',
  apiKey: 'sk-secret',
  baseUrl: 'https://api.example.com/v1',
  models: [{ model: 'gpt-4.1', maxContextSize: '128000', displayName: 'GPT-4.1' }],
};

/**
 * The same record, marked managed by the caller. The form cannot read that off
 * the record: an Open Platform provider is written with `oauth` dropped, so the
 * caller is the only one that knows which records it owns.
 */
const MANAGED_PROVIDER: ProviderFormInitial = {
  ...EDIT_PROVIDER,
  id: 'managed',
};

/** A record that declares the four optional provider-level fields, for round-trips. */
const RICH_PROVIDER: ProviderFormInitial = {
  id: 'demo',
  type: 'openai',
  baseUrl: 'https://api.example.com/v1',
  apiKeyEnv: 'DEMO_API_KEY',
  defaultModel: 'demo/gpt-4.1',
  customHeaders: { 'X-Tenant': 'acme' },
  env: { REGION: 'cn' },
  models: [{ model: 'gpt-4.1', maxContextSize: '128000', displayName: 'GPT-4.1' }],
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
  protocol: 'anthropic',
  betaApi: true,
  reasoningKey: 'reasoning_content',
  baseUrl: 'https://alt.example.com/v1',
  hasStoredOverrides: true,
};

describe('ProviderFormDialogComponent', () => {
  // The pending-overrides assertion reads the warning colour, which only
  // appears with truecolor enabled (see `theme/colors.ts`).
  let previousLevel: typeof chalk.level;
  beforeAll(() => {
    previousLevel = chalk.level;
    chalk.level = 3;
  });
  afterAll(() => {
    chalk.level = previousLevel;
  });

  it('renders every provider-level field label', () => {
    const { dialog } = makeDialog({ mode: 'add' });
    const out = plain(dialog);

    expect(out).toContain(t(`${FORM}.titleAdd`));
    for (const key of [
      'idLabel',
      'typeLabel',
      'apiKeyLabel',
      'apiKeyEnvLabel',
      'baseUrlLabel',
      'providerDefaultModelLabel',
      'customHeadersLabel',
      'envLabel',
      'modelsLabel',
    ]) {
      expect(out).toContain(t(`${FORM}.${key}`));
    }
    expect(out).toContain(t(`${FORM}.save`));
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
    dialog.handleInput(ENTER); // apiKey -> apiKeyEnv
    dialog.handleInput(ENTER); // apiKeyEnv -> baseUrl
    typeText(dialog, 'https://api.example.com/v1');

    dialog.handleInput(SHIFT_TAB); // baseUrl -> apiKeyEnv
    dialog.handleInput(SHIFT_TAB); // apiKeyEnv -> apiKey
    dialog.handleInput(SHIFT_TAB); // apiKey -> type
    dialog.handleInput(RIGHT); // kimi -> openai
    dialog.handleInput(RIGHT); // openai -> openai_responses
    dialog.handleInput(RIGHT); // openai_responses -> anthropic
    expect(plain(dialog)).not.toContain('/v1');

    dialog.handleInput(RIGHT); // anthropic -> google-genai keeps it stripped
    expect(plain(dialog)).not.toContain('/v1');
  });

  it('moves focus in the field order with Tab and Shift-Tab', () => {
    const { dialog } = makeDialog({ mode: 'add' });

    expect(footerOf(dialog)).toBe('fields'); // id

    dialog.handleInput(TAB); // type
    expect(footerOf(dialog)).toBe('fields');
    dialog.handleInput(TAB); // apiKey — the reveal affordance marks the field
    expect(footerOf(dialog)).toBe('fields');
    expect(plain(dialog)).toContain(t(`${FORM}.apiKeyRevealHint`));
    dialog.handleInput(TAB); // apiKeyEnv — the credential rule is spelled out
    expect(footerOf(dialog)).toBe('fields');
    expect(plain(dialog, 200)).toContain(t(`${FORM}.apiKeyEnvHint`));
    dialog.handleInput(TAB); // baseUrl — no hint of its own
    expect(footerOf(dialog)).toBe('fields');
    expect(plain(dialog, 200)).not.toContain(t(`${FORM}.apiKeyEnvHint`));
    dialog.handleInput(TAB); // defaultModel
    expect(footerOf(dialog)).toBe('fields');
    expect(plain(dialog)).toContain(t(`${FORM}.providerDefaultModelHint`));
    dialog.handleInput(TAB); // customHeaders — its hint replaces the previous one
    expect(footerOf(dialog)).toBe('fields');
    expect(plain(dialog)).toContain(t(`${FORM}.customHeadersHint`));
    expect(plain(dialog)).not.toContain(t(`${FORM}.providerDefaultModelHint`));
    dialog.handleInput(TAB); // env
    expect(footerOf(dialog)).toBe('fields');
    // `envHint` and `customHeadersHint` are worded identically in the locale,
    // so only the presence of the one under the focus is asserted here.
    expect(plain(dialog)).toContain(t(`${FORM}.envHint`));
    dialog.handleInput(TAB); // models — its own footer and legend
    expect(footerOf(dialog)).toBe('list');
    expect(plain(dialog)).toContain(t(`${FORM}.addRow`));
    expect(plain(dialog)).not.toContain(t(`${FORM}.envHint`));
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
    enterRowFields(dialog, ROW_TO_COMMIT_FROM_CAPABILITIES); // the row, written back
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
    dialog.handleInput(ENTER); // no api key env var either
    typeText(dialog, 'https://api.example.com');
    dialog.handleInput(ENTER); // baseUrl -> defaultModel
    dialog.handleInput(ENTER); // defaultModel -> customHeaders
    dialog.handleInput(ENTER); // customHeaders -> env
    dialog.handleInput(ENTER); // env -> models
    dialog.handleInput(ENTER); // row editor
    typeText(dialog, 'gpt-4.1');
    dialog.handleInput(ENTER);
    typeText(dialog, '128000');
    dialog.handleInput(ENTER); // context -> max input
    enterRowFields(dialog, ROW_TO_COMMIT_FROM_MAX_INPUT); // the tail, then commit
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

  it('rejects invalid maxInputSize and maxOutputSize values and focuses the offending row field', () => {
    const { dialog, onDone } = makeDialog({
      mode: 'edit',
      provider: {
        ...EDIT_PROVIDER,
        models: [
          { model: 'gpt-4.1', maxContextSize: '128000', displayName: '', maxInputSize: 'abc' },
        ],
      },
    });
    for (let i = 0; i < 9; i++) dialog.handleInput(TAB);
    dialog.handleInput(ENTER);

    expect(onDone).not.toHaveBeenCalled();
    expect(plain(dialog)).toContain(t(`${FORM}.error.contextSizeInvalid`));
    expect(footerOf(dialog)).toBe('row');
    expect(plain(dialog, 200)).toContain(t(`${FORM}.maxInputSizeHint`));
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
    dialog.handleInput(ENTER); // type? no: apiKey -> apiKeyEnv (empty key is fine)
    dialog.handleInput(ENTER); // apiKeyEnv -> baseUrl
    dialog.handleInput(ENTER); // baseUrl -> defaultModel
    dialog.handleInput(ENTER); // defaultModel -> customHeaders
    dialog.handleInput(ENTER); // customHeaders -> env
    dialog.handleInput(ENTER); // env -> models
    dialog.handleInput(ENTER); // row editor
    typeText(dialog, 'gpt-4.1');
    dialog.handleInput(ENTER);
    typeText(dialog, '128000');
    dialog.handleInput(ENTER); // context -> max input
    enterRowFields(dialog, ROW_TO_COMMIT_FROM_MAX_INPUT); // the tail, then commit
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
      'protocolLabel',
      'betaApiLabel',
      'reasoningKeyLabel',
      'modelBaseUrlLabel',
    ]) {
      expect(out).toContain(t(`${FORM}.${key}`));
    }
    expect(out).toContain(t(`${FORM}.capabilitiesValue`, { value: t(`${FORM}.capabilitiesNone`) }));
    expect(out).toContain('‹ [ ] image_in ›');
    // The three positions of a toggle the row does not declare, and the two
    // cursors that start at their empty position.
    expect(out).toContain(
      `${t(`${FORM}.adaptiveThinkingLabel`)}  ${t(`${FORM}.toggleNotDeclared`)}`,
    );
    expect(out).toContain(`${t(`${FORM}.betaApiLabel`)}  ${t(`${FORM}.toggleNotDeclared`)}`);
    expect(out).toContain(`‹ ${t(`${FORM}.protocolNotSet`)} ›`);
    expect(out).toContain(`‹ ${t(`${FORM}.toggleNotDeclared`)} ›`);
    // Each hint belongs to its focused field only.
    expect(out).not.toContain(t(`${FORM}.capabilitiesHint`));

    // A wide render: the longer hints are truncated at the default 80 columns.
    const wide = (): string => plain(dialog, 200);
    focusRowField(dialog, 2); // model → context → max input
    expect(wide()).toContain(t(`${FORM}.maxInputSizeHint`));
    dialog.handleInput(DOWN); // -> max output: the previous hint disappears
    expect(wide()).not.toContain(t(`${FORM}.maxInputSizeHint`));
    focusRowField(dialog, 2); // -> capabilities
    expect(wide()).toContain(t(`${FORM}.capabilitiesHint`));
    dialog.handleInput(DOWN); // -> thinking efforts
    expect(wide()).toContain(t(`${FORM}.supportEffortsHint`));
    focusRowField(dialog, 3); // -> adaptive thinking
    expect(wide()).toContain(t(`${FORM}.adaptiveThinkingHint`));
    dialog.handleInput(DOWN); // -> protocol
    expect(wide()).toContain(t(`${FORM}.protocolHint`));
    expect(wide()).not.toContain(t(`${FORM}.adaptiveThinkingHint`));
    dialog.handleInput(DOWN); // -> beta API
    expect(wide()).toContain(t(`${FORM}.betaApiHint`));
    dialog.handleInput(DOWN); // -> reasoning key
    expect(wide()).toContain(t(`${FORM}.reasoningKeyHint`));
    dialog.handleInput(DOWN); // -> model base URL, the last field
    expect(wide()).toContain(t(`${FORM}.modelBaseUrlHint`));
    // The tail is clamped: Down on the last field stays there.
    dialog.handleInput(DOWN);
    expect(wide()).toContain(t(`${FORM}.modelBaseUrlHint`));
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
    enterRowFields(dialog, ROW_TO_COMMIT_FROM_CAPABILITIES); // commit
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    expect(submittedValue(onDone).models?.[0]?.capabilities).toEqual(['dynamically_loaded_tools']);
  });

  it('cycles adaptive thinking through three positions with Space', () => {
    const { dialog, onDone } = makeDialog({ mode: 'add' });
    fillAddForm(dialog);
    dialog.handleInput(ENTER); // reopen the row editor
    focusRowField(dialog, 9); // model → adaptive thinking
    const label = t(`${FORM}.adaptiveThinkingLabel`);

    expect(plain(dialog)).toContain(`${label}  ${t(`${FORM}.toggleNotDeclared`)}`);
    dialog.handleInput(' '); // not declared → enabled
    expect(plain(dialog)).toContain(`${label}  ${t(`${FORM}.toggleEnabled`)}`);
    dialog.handleInput(' '); // enabled → disabled
    expect(plain(dialog)).toContain(`${label}  ${t(`${FORM}.toggleDisabled`)}`);
    commitRow(dialog);
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    // `false` is a declaration of its own — the engine reads it as the
    // budget-effort ladder — so it has to reach the value as `false` rather
    // than as a deleted key, which is what made this position unreachable.
    expect(submittedValue(onDone).models?.[0]?.adaptiveThinking).toBe(false);
  });

  it('cycles a toggle back to the position the form does not own', () => {
    const { dialog, onDone } = makeDialog({ mode: 'add' });
    fillAddForm(dialog);
    dialog.handleInput(ENTER); // reopen the row editor
    focusRowField(dialog, 11); // model → beta API
    const label = t(`${FORM}.betaApiLabel`);

    dialog.handleInput(' '); // → enabled
    expect(plain(dialog)).toContain(`${label}  ${t(`${FORM}.toggleEnabled`)}`);
    dialog.handleInput(' '); // → disabled
    dialog.handleInput(' '); // → not declared again: the form stops claiming it
    expect(plain(dialog)).toContain(`${label}  ${t(`${FORM}.toggleNotDeclared`)}`);
    commitRow(dialog);
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    const row = submittedValue(onDone).models?.[0];
    expect(row?.betaApi).toBeUndefined();
    expect(Object.keys(row ?? {})).not.toContain('betaApi');
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
    dialog.handleInput(RIGHT); // not declared -> low
    dialog.handleInput(RIGHT); // low -> medium
    dialog.handleInput(RIGHT); // medium -> high
    dialog.handleInput(ENTER); // -> off effort
    typeText(dialog, 'none');
    dialog.handleInput(ENTER); // -> adaptive thinking
    dialog.handleInput(' ');
    dialog.handleInput(DOWN); // -> protocol
    dialog.handleInput(RIGHT); // (not set) -> anthropic
    dialog.handleInput(DOWN); // -> beta API
    dialog.handleInput(' ');
    dialog.handleInput(DOWN); // -> reasoning key
    typeText(dialog, 'reasoning_content');
    dialog.handleInput(ENTER); // -> model base URL
    typeText(dialog, 'https://alt.example.com/v1');
    expect(plain(dialog)).toContain('‹ high ›'); // the ladder still offers the pick
    dialog.handleInput(ENTER); // commit
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
      protocol: 'anthropic',
      betaApi: true,
      reasoningKey: 'reasoning_content',
      baseUrl: 'https://alt.example.com/v1',
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
    expect(out).toContain(`${t(`${FORM}.adaptiveThinkingLabel`)}  ${t(`${FORM}.toggleEnabled`)}`);
    expect(out).toContain('‹ anthropic ›');
    expect(out).toContain(`${t(`${FORM}.betaApiLabel`)}  ${t(`${FORM}.toggleEnabled`)}`);
    expect(out).toContain('reasoning_content');
    expect(out).toContain('https://alt.example.com/v1');
    expect(out).toContain('‹ high ›'); // the default effort sits in the declared ladder
    // The stored override layer the form cannot edit is announced, not hidden.
    // (Wide render: the notice is longer than the dialog's own columns.)
    expect(plain(dialog, 200)).toContain(t(`${FORM}.overridesNotice`));

    enterRowFields(dialog, ROW_TO_COMMIT_FROM_MODEL); // model → … → commit, changing nothing
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
    commitRow(dialog);
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
    for (let i = 0; i < 9; i++) dialog.handleInput(TAB); // id → save
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
    enterRowFields(dialog, ROW_TO_COMMIT_FROM_CAPABILITIES); // commit
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    expect(submittedValue(onDone).models?.[0]?.capabilities).toEqual(['image_in', 'tool_use']);
  });

  it('shows error.defaultEffortNotSupported when the ladder moves under the pick', () => {
    const { dialog, onDone } = makeDialog({ mode: 'add' });
    fillAddForm(dialog);
    dialog.handleInput(ENTER); // reopen the row editor
    focusRowField(dialog, 6); // model → thinking efforts
    typeText(dialog, 'low, high');
    dialog.handleInput(ENTER); // -> default effort
    dialog.handleInput(RIGHT); // not declared → low
    dialog.handleInput(RIGHT); // low → high
    dialog.handleInput(UP); // back to thinking efforts
    replaceText(dialog, 'low, high', 'low, medium'); // `high` is gone
    commitRow(dialog);
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    expect(onDone).not.toHaveBeenCalled();
    const out = plain(dialog);
    expect(out).toContain(t(`${FORM}.error.defaultEffortNotSupported`));
    expect(footerOf(dialog)).toBe('row');
    expect(out).toContain(t(`${FORM}.modelRowLabel`, { index: '1', model: 'gpt-4.1' }));
    // The focus landed on the restricted picker, still showing what it held.
    expect(out).toContain('‹ high ›');

    dialog.handleInput(RIGHT); // the stale pick steps back into the ladder
    expect(plain(dialog)).toContain('‹ low ›');
    commitRow(dialog);
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    expect(submittedValue(onDone).models?.[0]?.defaultEffort).toBe('low');
  });

  it('keeps every row-editor line within narrow widths', () => {
    const { dialog } = makeDialog({
      mode: 'edit',
      provider: { ...EDIT_PROVIDER, models: [RICH_ROW] },
    });
    tabToModels(dialog);
    dialog.handleInput(ENTER); // open the row editor

    // Walk every row field so each focused hint is rendered at least once.
    for (let focus = 0; focus < 14; focus++) {
      if (focus > 0) dialog.handleInput(DOWN);
      for (const width of [39, 35, 20, 10]) {
        for (const line of dialog.render(width)) {
          expect(visibleWidth(line)).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it('renders a managed provider read-only', () => {
    const { dialog, onDone } = makeDialog({
      mode: 'edit',
      provider: MANAGED_PROVIDER,
      readOnly: true,
    });

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

  it('carries a stored type it cannot offer instead of rewriting it', () => {
    const { dialog, onDone } = makeDialog({
      mode: 'edit',
      provider: { ...EDIT_PROVIDER, type: 'astron' },
    });

    // The field shows the stored type. Left to the six the form offers it would
    // read `kimi` and submit that, silently changing the record's transport.
    expect(plain(dialog)).toContain('‹ astron ›');
    // It joins the cycle at the end, so the six official types keep their
    // relative order and the stored one is reachable again by cycling around.
    for (let i = 0; i < 7; i++) dialog.handleInput(RIGHT);
    expect(plain(dialog)).toContain('‹ astron ›');

    // Submitting without touching the field writes the type back verbatim.
    for (let i = 0; i < 9; i++) dialog.handleInput(TAB); // id → save
    dialog.handleInput(ENTER);
    expect(onDone).toHaveBeenCalledTimes(1);
    const result = onDone.mock.calls[0]?.[0] as ProviderFormDialogResult;
    expect(result.kind).toBe('ok');
    expect(result.kind === 'ok' ? result.value.type : undefined).toBe('astron');
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

  // -------------------------------------------------------------------------
  // The provider-level fields the form owns in full
  // -------------------------------------------------------------------------

  it('prefills and writes back every optional provider field', () => {
    const { dialog, onDone } = makeDialog({ mode: 'edit', provider: RICH_PROVIDER });
    const out = plain(dialog);

    expect(out).toContain('DEMO_API_KEY');
    expect(out).toContain('X-Tenant=acme');
    expect(out).toContain('REGION=cn');
    // The field shows the bare model id behind the stored `${id}/${model}` pointer.
    expect(out).toContain('gpt-4.1');
    expect(out).not.toContain('demo/gpt-4.1');

    for (let i = 0; i < 9; i++) dialog.handleInput(TAB); // id → save
    dialog.handleInput(ENTER);

    expect(submittedValue(onDone)).toEqual({
      id: 'demo',
      type: 'openai',
      apiKey: '',
      apiKeyEnv: 'DEMO_API_KEY',
      baseUrl: 'https://api.example.com/v1',
      defaultModel: 'gpt-4.1',
      customHeaders: 'X-Tenant=acme',
      env: 'REGION=cn',
      models: [{ model: 'gpt-4.1', maxContextSize: '128000', displayName: 'GPT-4.1' }],
    });
  });

  it('clears a declared provider field but leaves an undeclared one absent', () => {
    // A record that declares the field: blanking it out means "delete the key".
    const declared = makeDialog({ mode: 'edit', provider: RICH_PROVIDER });
    declared.dialog.handleInput(ENTER); // id -> type
    declared.dialog.handleInput(ENTER); // type -> apiKey
    declared.dialog.handleInput(ENTER); // apiKey -> apiKeyEnv
    replaceText(declared.dialog, 'DEMO_API_KEY', '');
    for (let i = 0; i < 6; i++) declared.dialog.handleInput(TAB); // apiKeyEnv → save
    declared.dialog.handleInput(ENTER);

    const cleared = submittedValue(declared.onDone);
    expect(cleared.apiKeyEnv).toBe('');
    expect(cleared.defaultModel).toBe('gpt-4.1'); // an untouched sibling
    expect(cleared.customHeaders).toBe('X-Tenant=acme');

    // A record that declares none of them: walking through the form must not
    // turn "not declared" into "cleared".
    const undeclared = makeDialog({ mode: 'edit', provider: EDIT_PROVIDER });
    for (let i = 0; i < 9; i++) undeclared.dialog.handleInput(TAB); // id → save
    undeclared.dialog.handleInput(ENTER);

    const untouched = submittedValue(undeclared.onDone);
    for (const key of ['apiKeyEnv', 'defaultModel', 'customHeaders', 'env'] as const) {
      expect(untouched[key]).toBeUndefined();
    }
  });

  it('takes the credential from the environment-variable field when adding', () => {
    const { dialog, onDone } = makeDialog({ mode: 'add' });
    typeText(dialog, 'demo');
    dialog.handleInput(ENTER); // id -> type
    dialog.handleInput(ENTER); // type -> apiKey
    dialog.handleInput(ENTER); // the inline key stays empty
    typeText(dialog, 'DEMO_API_KEY'); // the variable names the credential instead
    dialog.handleInput(ENTER); // apiKeyEnv -> baseUrl
    typeText(dialog, 'https://api.example.com/v1');
    dialog.handleInput(ENTER); // baseUrl -> defaultModel
    dialog.handleInput(ENTER); // defaultModel -> customHeaders
    dialog.handleInput(ENTER); // customHeaders -> env
    dialog.handleInput(ENTER); // env -> models
    dialog.handleInput(ENTER); // row editor
    typeText(dialog, 'gpt-4.1');
    dialog.handleInput(ENTER); // model -> context
    typeText(dialog, '128000');
    dialog.handleInput(ENTER); // context -> max input
    commitRow(dialog);
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    const value = submittedValue(onDone);
    expect(value.apiKey).toBe('');
    expect(value.apiKeyEnv).toBe('DEMO_API_KEY');
  });

  it('shows error.apiKeyConflict and focuses the env-var field', () => {
    const { dialog, onDone } = makeDialog({ mode: 'edit', provider: EDIT_PROVIDER });
    dialog.handleInput(ENTER); // id -> type
    dialog.handleInput(ENTER); // type -> apiKey
    dialog.handleInput(ENTER); // apiKey -> apiKeyEnv
    typeText(dialog, 'DEMO_API_KEY'); // the stored inline key is still there
    for (let i = 0; i < 6; i++) dialog.handleInput(TAB); // apiKeyEnv → save
    dialog.handleInput(ENTER);

    expect(onDone).not.toHaveBeenCalled();
    const out = plain(dialog);
    expect(out).toContain(t(`${FORM}.error.apiKeyConflict`));
    expect(footerOf(dialog)).toBe('fields');
    expect(out).toContain('DEMO_API_KEY'); // the typed value survives the refusal
    // The focus landed on the env-var field: typing goes there, not to the id.
    dialog.handleInput('X');
    expect(plain(dialog)).toContain('DEMO_API_KEYX');
  });

  it('shows error.defaultModelUnknown and keeps the value in the focused field', () => {
    const { dialog, onDone } = makeDialog({ mode: 'edit', provider: EDIT_PROVIDER });
    dialog.handleInput(ENTER); // id -> type
    dialog.handleInput(ENTER); // -> apiKey
    dialog.handleInput(ENTER); // -> apiKeyEnv
    dialog.handleInput(ENTER); // -> baseUrl
    dialog.handleInput(ENTER); // -> defaultModel
    typeText(dialog, 'gpt-5'); // names no row of this provider
    for (let i = 0; i < 4; i++) dialog.handleInput(TAB); // defaultModel → save
    dialog.handleInput(ENTER);

    expect(onDone).not.toHaveBeenCalled();
    expect(plain(dialog)).toContain(t(`${FORM}.error.defaultModelUnknown`));
    dialog.handleInput('9');
    expect(plain(dialog)).toContain('gpt-59');
  });

  it('shows error.headerInvalid and error.envInvalid on their own fields', () => {
    const headers = makeDialog({ mode: 'edit', provider: EDIT_PROVIDER });
    for (let i = 0; i < 6; i++) headers.dialog.handleInput(TAB); // id → customHeaders
    typeText(headers.dialog, 'X-Tenant'); // no `=`
    for (let i = 0; i < 3; i++) headers.dialog.handleInput(TAB); // customHeaders → save
    headers.dialog.handleInput(ENTER);

    expect(headers.onDone).not.toHaveBeenCalled();
    expect(plain(headers.dialog)).toContain(t(`${FORM}.error.headerInvalid`));
    headers.dialog.handleInput('+');
    expect(plain(headers.dialog)).toContain('X-Tenant+');

    const env = makeDialog({ mode: 'edit', provider: EDIT_PROVIDER });
    for (let i = 0; i < 7; i++) env.dialog.handleInput(TAB); // id → env
    typeText(env.dialog, 'REGION'); // no `=`
    for (let i = 0; i < 2; i++) env.dialog.handleInput(TAB); // env → save
    env.dialog.handleInput(ENTER);

    expect(env.onDone).not.toHaveBeenCalled();
    expect(plain(env.dialog)).toContain(t(`${FORM}.error.envInvalid`));
    env.dialog.handleInput('+');
    expect(plain(env.dialog)).toContain('REGION+');
  });

  // -------------------------------------------------------------------------
  // The row fields the form owns in full
  // -------------------------------------------------------------------------

  it('cycles the per-model protocol without touching its base URL', () => {
    const { dialog, onDone } = makeDialog({ mode: 'add' });
    fillAddForm(dialog);
    dialog.handleInput(ENTER); // reopen the row editor
    focusRowField(dialog, 13); // model → model base URL, the last field
    typeText(dialog, 'https://alt.example.com/v1');
    dialog.handleInput(UP); // -> reasoning key
    dialog.handleInput(UP); // -> beta API
    dialog.handleInput(UP); // -> protocol

    expect(plain(dialog)).toContain(`‹ ${t(`${FORM}.protocolNotSet`)} ›`);
    dialog.handleInput(RIGHT);
    expect(plain(dialog)).toContain('‹ anthropic ›');
    // The provider `type` field re-normalizes the base URL for the new type;
    // the row's own protocol leaves the endpoint exactly as typed.
    expect(plain(dialog)).toContain('https://alt.example.com/v1');
    dialog.handleInput(RIGHT);
    expect(plain(dialog)).toContain('‹ openai_responses ›');
    dialog.handleInput(RIGHT); // wraps back to "not set"
    expect(plain(dialog)).toContain(`‹ ${t(`${FORM}.protocolNotSet`)} ›`);
    dialog.handleInput(LEFT); // wraps to the last entry
    expect(plain(dialog)).toContain('‹ openai_responses ›');
    commitRow(dialog);
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    expect(submittedValue(onDone).models?.[0]?.protocol).toBe('openai_responses');
  });

  it('round-trips a declared-empty effort ladder as the literal []', () => {
    const emptyLadder: ProviderFormModelRow = {
      model: 'gpt-4.1',
      maxContextSize: '128000',
      displayName: 'GPT-4.1',
      supportEfforts: '[]',
      defaultEffort: '',
    };
    const { dialog, onDone } = makeDialog({
      mode: 'edit',
      provider: { ...EDIT_PROVIDER, models: [emptyLadder] },
    });
    tabToModels(dialog);
    dialog.handleInput(ENTER); // open the row editor

    expect(plain(dialog)).toContain('> []'); // the literal survives the prefill
    focusRowField(dialog, 7); // model → default effort
    // An empty ladder offers no effort, so only "not declared" is selectable.
    expect(plain(dialog)).toContain(`‹ ${t(`${FORM}.toggleNotDeclared`)} ›`);
    dialog.handleInput(LEFT);
    expect(plain(dialog)).toContain(`‹ ${t(`${FORM}.toggleNotDeclared`)} ›`);
    commitRow(dialog);
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    const row = submittedValue(onDone).models?.[0];
    expect(row?.supportEfforts).toBe('[]');
    expect(row?.defaultEffort).toBe('');
  });

  it('announces stored overrides and queues their removal with Ctrl-X', () => {
    const { dialog, onDone } = makeDialog({
      mode: 'edit',
      provider: { ...EDIT_PROVIDER, models: [RICH_ROW] },
    });
    tabToModels(dialog);
    dialog.handleInput(ENTER); // open the row editor

    const notice = t(`${FORM}.overridesNotice`);
    const hint = t(`${FORM}.overridesClearHint`);
    expect(plain(dialog, 200)).toContain(notice);
    expect(plain(dialog)).toContain(hint);
    // Nothing queued yet: the block is plain muted text.
    expect(raw(dialog, 200)).toContain(currentTheme.fg('textMuted', notice));
    expect(raw(dialog, 200)).not.toContain(currentTheme.boldFg('warning', notice));

    dialog.handleInput(CTRL_X); // queue the drop
    expect(plain(dialog, 200)).toContain(notice);
    expect(plain(dialog, 200)).toContain(hint);
    expect(raw(dialog, 200)).toContain(currentTheme.boldFg('warning', notice));
    expect(raw(dialog, 200)).toContain(currentTheme.boldFg('warning', hint));

    commitRow(dialog);
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    const row = submittedValue(onDone).models?.[0];
    expect(row?.clearOverrides).toBe(true);
    expect(row?.hasStoredOverrides).toBe(true); // the notice survives the round-trip
  });

  it('drops a queued override removal when the row edit is discarded', () => {
    const { dialog, onDone } = makeDialog({
      mode: 'edit',
      provider: { ...EDIT_PROVIDER, models: [RICH_ROW] },
    });
    tabToModels(dialog);
    dialog.handleInput(ENTER); // open the row editor
    dialog.handleInput(CTRL_X);
    dialog.handleInput(ESC); // discard this row
    dialog.handleInput(ENTER); // and open it again

    const notice = t(`${FORM}.overridesNotice`);
    expect(plain(dialog, 200)).toContain(notice);
    expect(raw(dialog, 200)).not.toContain(currentTheme.boldFg('warning', notice));

    commitRow(dialog);
    dialog.handleInput(TAB); // models -> save
    dialog.handleInput(ENTER);

    expect(submittedValue(onDone).models?.[0]?.clearOverrides).toBeUndefined();
  });
});
