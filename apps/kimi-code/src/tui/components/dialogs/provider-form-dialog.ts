/**
 * ProviderFormDialog — the manual provider form behind `/provider` → add /
 * edit. Rounded box geometry mirrors `CustomRegistryImportDialogComponent`
 * (Container + Focusable, hint line, focus-driven footer) so the chrome stays
 * consistent with the API-key login flow.
 *
 * Field order: id → type → apiKey → apiKeyEnv → baseUrl → defaultModel →
 * customHeaders → env → models → Save. Tab / Shift-Tab / Up / Down move
 * between fields, Enter advances (from the models zone it opens the selected
 * row, from Save it submits), Esc / Ctrl-C cancel. `type` is not an input:
 * Left / Right / Space cycle the six `PROVIDER_WIRE_TYPES` — plus the stored
 * type when it is not one of them, so editing an `astron` record cannot
 * silently rewrite it to `kimi` — and re-normalize a filled base URL for the
 * new type (anthropic drops a trailing `/v1`). The API key renders masked and
 * Ctrl-R reveals it; the environment-variable name beside it is not masked,
 * because the NAME of a variable is not a secret.
 *
 * The models zone is a row summary list (Up / Down select, `A` append, `D`
 * delete — never below one row, `E` / Enter edit); the row editor (Model ID →
 * Context → Max input → Max output → Display name → Capabilities → Thinking
 * efforts → Default effort → Off effort → Adaptive thinking → Protocol →
 * Beta API → Reasoning key → Model base URL) lives inside the same box as a
 * sub-state, so no nested dialog is needed. Four of those fields are not
 * text: Capabilities, Protocol and Default effort are Left / Right cursors,
 * and Adaptive thinking / Beta API are Space toggles over three states.
 *
 * Every optional field is three-state: `undefined` means the form does not own
 * it (the record keeps whatever it declared), `''` means the user cleared it
 * (the write deletes the key), anything else is written as typed. The row
 * fields implement that by comparing the input against the row they were
 * opened on (`assignOptionalText`); the provider-level fields remember the
 * same thing per field, in `declared`. Either way a blank only reads as
 * "cleared" for a field the form had shown a value for — walking through the
 * form cannot turn "not declared" into "cleared".
 *
 * Validation is `validateProviderForm` from `#/utils/provider-form`; the
 * failing code renders as an inline hint (top of the form) and the focus
 * jumps to the offending field, keeping every value the user typed.
 *
 * The caller decides what is read-only, through `ProviderFormDialogOptions.
 * readOnly`: a managed `oauth` record, or an Open Platform provider whose
 * account `/login` owns. The record alone cannot say — an Open Platform
 * provider is written with `oauth` dropped — and getting it wrong is not
 * cosmetic: renaming one would orphan its credential and let the next refresh
 * re-add the original id beside it. Nothing is focusable in that mode, no key
 * mutates the form, and the footer explains why.
 */

import type { ProviderConfig, ProviderType } from '@moonshot-ai/kimi-code-sdk';
import {
  Container,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import {
  CAPABILITY_NAMES,
  defaultModelRow,
  formatKeyValueList,
  isCapabilityName,
  normalizeBaseUrlForType,
  PROVIDER_WIRE_TYPES,
  rowEffortLadder,
  validateProviderForm,
  type ProviderFormError,
  type ProviderFormModelRow,
  type ProviderFormToggle,
  type ProviderFormValue,
} from '#/utils/provider-form';

/** Edit-mode prefill. */
export interface ProviderFormInitial {
  readonly id: string;
  /** The stored wire type; one the form cannot offer (`astron`) is carried as-is. */
  readonly type: ProviderType;
  readonly apiKey?: string;
  /** The NAME of an environment variable holding the credential. */
  readonly apiKeyEnv?: string;
  readonly baseUrl?: string;
  /** The stored `${id}/${model}` pointer, verbatim; the form edits its bare model id. */
  readonly defaultModel?: string;
  readonly customHeaders?: ProviderConfig['customHeaders'];
  readonly env?: ProviderConfig['env'];
  readonly models?: readonly ProviderFormModelRow[];
}

export interface ProviderFormDialogOptions {
  readonly mode: 'add' | 'edit';
  /** Ignored in add mode. */
  readonly provider?: ProviderFormInitial;
  /**
   * Locks every field. The caller decides what counts as managed — a record
   * carrying `oauth`, or an Open Platform id whose account `/login` owns —
   * because the record alone cannot say (an Open Platform provider is written
   * with `oauth` dropped). Letting one be renamed would orphan its credential
   * and let the next refresh re-add the original id beside it.
   */
  readonly readOnly?: boolean;
}

export type ProviderFormDialogResult =
  | { readonly kind: 'ok'; readonly value: ProviderFormValue }
  | { readonly kind: 'cancel' };

type FieldId =
  | 'id'
  | 'type'
  | 'apiKey'
  | 'apiKeyEnv'
  | 'baseUrl'
  | 'defaultModel'
  | 'customHeaders'
  | 'env'
  | 'models'
  | 'save';
type RowFieldId =
  | 'model'
  | 'context'
  | 'maxInputSize'
  | 'maxOutputSize'
  | 'displayName'
  | 'capabilities'
  | 'supportEfforts'
  | 'defaultEffort'
  | 'offEffort'
  | 'adaptiveThinking'
  | 'protocol'
  | 'betaApi'
  | 'reasoningKey'
  | 'baseUrl';

const FIELD_ORDER: readonly FieldId[] = [
  'id',
  'type',
  'apiKey',
  'apiKeyEnv',
  'baseUrl',
  'defaultModel',
  'customHeaders',
  'env',
  'models',
  'save',
];
const ROW_FIELD_ORDER: readonly RowFieldId[] = [
  'model',
  'context',
  'maxInputSize',
  'maxOutputSize',
  'displayName',
  'capabilities',
  'supportEfforts',
  'defaultEffort',
  'offEffort',
  'adaptiveThinking',
  'protocol',
  'betaApi',
  'reasoningKey',
  'baseUrl',
];
const INPUT_PREFIX = '> ';
const POSITIVE_INTEGER_PATTERN = /^\d+$/;
const HTTP_URL_PATTERN = /^https?:\/\//;
/** The row's protocol override cycle; `''` leaves the provider's own type in charge. */
const ROW_PROTOCOLS = ['', 'anthropic', 'openai_responses'] as const;

function hintText(code: ProviderFormError): string {
  switch (code) {
    case 'idRequired':
      return t('tui.dialogs.providerForm.error.idRequired');
    case 'idInvalid':
      return t('tui.dialogs.providerForm.error.idInvalid');
    case 'apiKeyRequired':
      return t('tui.dialogs.providerForm.error.apiKeyRequired');
    case 'apiKeyConflict':
      return t('tui.dialogs.providerForm.error.apiKeyConflict');
    case 'baseUrlRequired':
      return t('tui.dialogs.providerForm.error.baseUrlRequired');
    case 'modelRequired':
      return t('tui.dialogs.providerForm.error.modelRequired');
    case 'contextSizeRequired':
      return t('tui.dialogs.providerForm.error.contextSizeRequired');
    case 'contextSizeInvalid':
      return t('tui.dialogs.providerForm.error.contextSizeInvalid');
    case 'modelDuplicate':
      return t('tui.dialogs.providerForm.error.modelDuplicate');
    case 'capabilityUnknown':
      return t('tui.dialogs.providerForm.error.capabilityUnknown');
    case 'defaultEffortNotSupported':
      return t('tui.dialogs.providerForm.error.defaultEffortNotSupported');
    case 'defaultModelUnknown':
      return t('tui.dialogs.providerForm.error.defaultModelUnknown');
    case 'betaApiWithoutAnthropic':
      return t('tui.dialogs.providerForm.error.betaApiWithoutAnthropic');
    case 'modelBaseUrlInvalid':
      return t('tui.dialogs.providerForm.error.modelBaseUrlInvalid');
    case 'headerInvalid':
      return t('tui.dialogs.providerForm.error.headerInvalid');
    case 'envInvalid':
      return t('tui.dialogs.providerForm.error.envInvalid');
  }
}

function labelStyled(text: string, focused: boolean): string {
  return focused ? currentTheme.boldFg('accent', text) : currentTheme.fg('textDim', text);
}

/**
 * Commit one optional text field from the row editor.
 *
 * A blank input clears the key only when the row already carried something to
 * clear; a row that never declared the field keeps it absent, so merely
 * opening the editor cannot turn "not set" into "cleared" — the pure layer
 * treats the two differently.
 */
function assignOptionalText(
  row: ProviderFormModelRow,
  key:
    | 'maxInputSize'
    | 'maxOutputSize'
    | 'supportEfforts'
    | 'defaultEffort'
    | 'offEffort'
    | 'reasoningKey'
    | 'baseUrl',
  raw: string,
  previous: string | undefined,
): void {
  if (raw === '' && previous === undefined) return;
  row[key] = raw;
}

/** A stored value the form presents, or `undefined` when the record declares none. */
function declaredText(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? undefined : trimmed;
}

/** The bare model id a stored `${id}/${model}` pointer names, `''` for anything else. */
function bareProviderDefaultModel(provider: ProviderFormInitial | undefined): string {
  const pointer = provider?.defaultModel;
  const prefix = `${provider?.id ?? ''}/`;
  if (pointer === undefined || !pointer.startsWith(prefix)) return '';
  return pointer.slice(prefix.length);
}

/**
 * The provider-level counterpart of {@link assignOptionalText}: a blank input
 * reads as "clear" only for a field whose record declared a value, so the form
 * merely showing an empty field cannot delete a key it never read.
 */
function ownedText(raw: string, declared: string | undefined): string | undefined {
  return raw === '' && declared === undefined ? undefined : raw;
}

/** The three toggle states in the locale's own words. */
function toggleStateText(value: ProviderFormToggle | undefined): string {
  if (value === true) return t('tui.dialogs.providerForm.toggleEnabled');
  if (value === false) return t('tui.dialogs.providerForm.toggleDisabled');
  // `'clear'` reads like the undeclared state: both leave the record without the
  // key, the difference is only whether there was one to delete.
  return t('tui.dialogs.providerForm.toggleNotDeclared');
}

/**
 * The state `Space` moves to: not declared → enabled → disabled → not declared.
 * A `'clear'` handed in by a caller sits at the undeclared position, so the
 * first press declares the field instead of deleting it again.
 */
function nextToggleState(value: ProviderFormToggle | undefined): ProviderFormToggle | undefined {
  if (value === true) return false;
  if (value === false) return undefined;
  return true;
}

/**
 * Mask an Input render line so a credential never reaches the screen. ANSI
 * escape sequences (reverse-video cursor, IME marker) survive; every other
 * visible character becomes a bullet. Mirrors `CustomRegistryImportDialog`.
 */
function maskInputLine(raw: string): string {
  if (!raw.startsWith(INPUT_PREFIX)) return raw;

  let end = raw.length;
  while (end > INPUT_PREFIX.length && raw[end - 1] === ' ') {
    end--;
  }
  const padding = raw.slice(end);
  const content = raw.slice(INPUT_PREFIX.length, end);

  const parts = content.split(/(\u001B(?:\[[0-9;]*m|_pi:c\u0007))/);
  const maskedContent = parts
    .map((part, index) => {
      if (index % 2 === 1) return part; // ANSI sequence
      return part.replaceAll(/[^ ]/g, '•');
    })
    .join('');

  return INPUT_PREFIX + maskedContent + padding;
}

export class ProviderFormDialogComponent extends Container implements Focusable {
  focused = false;

  /** True when the caller marked the record managed: every field is locked. */
  readonly disabled: boolean;

  private readonly mode: 'add' | 'edit';
  private readonly onDone: (result: ProviderFormDialogResult) => void;
  private readonly idInput = new Input();
  private readonly apiKeyInput = new Input();
  private readonly apiKeyEnvInput = new Input();
  private readonly baseUrlInput = new Input();
  private readonly defaultModelInput = new Input();
  private readonly customHeadersInput = new Input();
  private readonly envInput = new Input();
  private readonly rowModelInput = new Input();
  private readonly rowContextInput = new Input();
  private readonly rowMaxInputSizeInput = new Input();
  private readonly rowMaxOutputSizeInput = new Input();
  private readonly rowDisplayNameInput = new Input();
  private readonly rowSupportEffortsInput = new Input();
  private readonly rowOffEffortInput = new Input();
  private readonly rowReasoningKeyInput = new Input();
  private readonly rowBaseUrlInput = new Input();

  private activeField: FieldId = 'id';
  /**
   * What the edited record declared for each provider-level field the form
   * owns, as the form received it. Blank reads as "clear" only for a field
   * that has an entry here; see {@link ownedText}.
   */
  private readonly declared: {
    apiKeyEnv?: string;
    defaultModel?: string;
    customHeaders?: string;
    env?: string;
  } = {};
  /**
   * The wire types the `type` field cycles: the six the form offers, plus the
   * stored type when it is outside them (`astron`). Without that extra entry
   * `typeIndex` would stay at the first type for such a record and submit would
   * rewrite its transport to `kimi` — a change the user never asked for.
   */
  private readonly types: readonly ProviderType[];
  private typeIndex = 0;
  private models: ProviderFormModelRow[] = [];
  private selectedRow = 0;
  private modelsMode: 'list' | 'row' = 'list';
  private rowField: RowFieldId = 'model';
  private rowBackup: ProviderFormModelRow | null = null;
  /** Capabilities being edited; `undefined` until the user toggles one. */
  private rowCapabilities: string[] | undefined;
  private rowCapabilityCursor = 0;
  /** Adaptive thinking being edited; `undefined` until the user toggles it. */
  private rowAdaptiveThinking: ProviderFormToggle | undefined;
  /** Beta API being edited; the same three states as {@link rowAdaptiveThinking}. */
  private rowBetaApi: ProviderFormToggle | undefined;
  /** The protocol override being edited; `''` lets the provider's type decide. */
  private rowProtocol: '' | 'anthropic' | 'openai_responses' = '';
  /** The selected default effort; `''` is the leading "not declared" position. */
  private rowDefaultEffort = '';
  private apiKeyRevealed = false;
  private hint: ProviderFormError | null = null;
  private done = false;

  constructor(
    onDone: (result: ProviderFormDialogResult) => void,
    options: ProviderFormDialogOptions,
  ) {
    super();
    this.onDone = onDone;
    this.mode = options.mode;

    const provider = options.mode === 'edit' ? options.provider : undefined;
    this.disabled = options.readOnly === true;
    const storedType = provider?.type;
    this.types =
      storedType === undefined || (PROVIDER_WIRE_TYPES as readonly string[]).includes(storedType)
        ? PROVIDER_WIRE_TYPES
        : [...PROVIDER_WIRE_TYPES, storedType];
    if (provider !== undefined) {
      this.idInput.setValue(provider.id);
      this.typeIndex = Math.max(0, this.types.indexOf(provider.type));
      if (provider.apiKey !== undefined) this.apiKeyInput.setValue(provider.apiKey);
      if (provider.baseUrl !== undefined) this.baseUrlInput.setValue(provider.baseUrl);
      this.models = (provider.models ?? []).map((row) => ({ ...row }));
    }
    if (this.models.length === 0) this.models.push(defaultModelRow());

    // The four optional provider fields, each presented as the record holds it.
    // The stored values are remembered separately so that a field the record
    // never declared keeps its absence when the user leaves it blank.
    const apiKeyEnv = provider?.apiKeyEnv ?? '';
    const defaultModel = bareProviderDefaultModel(provider);
    const customHeaders = formatKeyValueList(provider?.customHeaders);
    const env = formatKeyValueList(provider?.env);
    this.apiKeyEnvInput.setValue(apiKeyEnv);
    this.defaultModelInput.setValue(defaultModel);
    this.customHeadersInput.setValue(customHeaders);
    this.envInput.setValue(env);
    this.declared.apiKeyEnv = declaredText(apiKeyEnv);
    this.declared.defaultModel = declaredText(defaultModel);
    this.declared.customHeaders = declaredText(customHeaders);
    this.declared.env = declaredText(env);

    // Enter on a text field advances instead of submitting; the row editor's
    // last field writes the row back and returns to the summary list.
    this.idInput.onSubmit = () => {
      this.moveField(1, false);
    };
    this.apiKeyInput.onSubmit = () => {
      this.moveField(1, false);
    };
    this.apiKeyEnvInput.onSubmit = () => {
      this.moveField(1, false);
    };
    this.baseUrlInput.onSubmit = () => {
      this.moveField(1, false);
    };
    this.defaultModelInput.onSubmit = () => {
      this.moveField(1, false);
    };
    this.customHeadersInput.onSubmit = () => {
      this.moveField(1, false);
    };
    this.envInput.onSubmit = () => {
      this.moveField(1, false);
    };
    this.rowModelInput.onSubmit = () => {
      this.rowField = 'context';
    };
    this.rowContextInput.onSubmit = () => {
      this.rowField = 'maxInputSize';
    };
    this.rowMaxInputSizeInput.onSubmit = () => {
      this.rowField = 'maxOutputSize';
    };
    this.rowMaxOutputSizeInput.onSubmit = () => {
      this.rowField = 'displayName';
    };
    this.rowDisplayNameInput.onSubmit = () => {
      this.rowField = 'capabilities';
    };
    this.rowSupportEffortsInput.onSubmit = () => {
      this.rowField = 'defaultEffort';
    };
    this.rowOffEffortInput.onSubmit = () => {
      this.rowField = 'adaptiveThinking';
    };
    this.rowReasoningKeyInput.onSubmit = () => {
      this.rowField = 'baseUrl';
    };
    this.rowBaseUrlInput.onSubmit = () => {
      this.commitRow();
    };
  }

  handleInput(data: string): void {
    if (this.done) return;
    if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
      this.cancel();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      // Esc leaves the row editor first, then the dialog.
      if (this.modelsMode === 'row') {
        this.discardRow();
        return;
      }
      this.cancel();
      return;
    }
    if (this.disabled) return;

    if (this.modelsMode === 'row') {
      this.handleRowInput(data);
      return;
    }

    if (matchesKey(data, Key.tab)) {
      this.moveField(1, true);
      return;
    }
    if (matchesKey(data, Key.shift('tab'))) {
      this.moveField(-1, true);
      return;
    }

    const decoded = printableChar(data);

    if (this.activeField === 'models') {
      // Up / Down belong to the row cursor here; Tab still leaves the zone.
      if (matchesKey(data, Key.up)) {
        this.selectRow(this.selectedRow - 1);
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.selectRow(this.selectedRow + 1);
        return;
      }
      if (decoded === 'A' || decoded === 'a') {
        this.appendRow();
        return;
      }
      if (decoded === 'D' || decoded === 'd') {
        this.removeRow();
        return;
      }
      if (decoded === 'E' || decoded === 'e' || isSubmit(data)) {
        this.openRowEditor();
      }
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.moveField(-1, false);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveField(1, false);
      return;
    }
    if (this.activeField === 'type') {
      if (matchesKey(data, Key.left)) {
        this.cycleType(-1);
        return;
      }
      if (matchesKey(data, Key.right)) {
        this.cycleType(1);
        return;
      }
      if (matchesKey(data, Key.space) || decoded === ' ') {
        this.cycleType(1);
        return;
      }
      if (isSubmit(data)) this.moveField(1, false);
      return;
    }
    if (this.activeField === 'save') {
      if (isSubmit(data)) this.submit();
      return;
    }
    if (this.activeField === 'apiKey' && matchesKey(data, Key.ctrl('r'))) {
      this.apiKeyRevealed = !this.apiKeyRevealed;
      return;
    }

    this.hint = null;
    this.activeInput().handleInput(data);
  }

  override invalidate(): void {
    super.invalidate();
    for (const input of this.allInputs()) input.invalidate();
  }

  override render(width: number): string[] {
    const dialogActive = this.focused && !this.done;
    const editable = dialogActive && !this.disabled;
    const fieldFocused = (field: FieldId): boolean =>
      editable && this.modelsMode === 'list' && this.activeField === field;
    const rowFocused = (field: RowFieldId): boolean =>
      editable && this.modelsMode === 'row' && this.rowField === field;
    this.idInput.focused = fieldFocused('id');
    this.apiKeyInput.focused = fieldFocused('apiKey');
    this.apiKeyEnvInput.focused = fieldFocused('apiKeyEnv');
    this.baseUrlInput.focused = fieldFocused('baseUrl');
    this.defaultModelInput.focused = fieldFocused('defaultModel');
    this.customHeadersInput.focused = fieldFocused('customHeaders');
    this.envInput.focused = fieldFocused('env');
    this.rowModelInput.focused = rowFocused('model');
    this.rowContextInput.focused = rowFocused('context');
    this.rowMaxInputSizeInput.focused = rowFocused('maxInputSize');
    this.rowMaxOutputSizeInput.focused = rowFocused('maxOutputSize');
    this.rowDisplayNameInput.focused = rowFocused('displayName');
    this.rowSupportEffortsInput.focused = rowFocused('supportEfforts');
    this.rowOffEffortInput.focused = rowFocused('offEffort');
    this.rowReasoningKeyInput.focused = rowFocused('reasoningKey');
    this.rowBaseUrlInput.focused = rowFocused('baseUrl');

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    const border = (s: string): string => currentTheme.fg('primary', s);
    const title =
      this.mode === 'add'
        ? t('tui.dialogs.providerForm.titleAdd')
        : t('tui.dialogs.providerForm.titleEdit');
    /** The per-field hint under an input, rendered only while it has focus. */
    const hintFor = (fields: readonly FieldId[], text: string): string[] =>
      fields.some((field) => fieldFocused(field)) ? [currentTheme.fg('textMuted', text)] : [];

    const rawLines: string[] = [currentTheme.boldFg('textStrong', title)];
    if (this.hint !== null) rawLines.push(currentTheme.fg('error', hintText(this.hint)));
    rawLines.push(
      '',
      labelStyled(t('tui.dialogs.providerForm.idLabel'), fieldFocused('id')),
      this.inputLine(this.idInput, innerWidth),
      '',
      labelStyled(t('tui.dialogs.providerForm.typeLabel'), fieldFocused('type')),
      this.typeLine(),
      '',
      labelStyled(t('tui.dialogs.providerForm.apiKeyLabel'), fieldFocused('apiKey')),
      this.apiKeyLine(innerWidth),
    );
    const apiKeyNote = this.apiKeyNoteLine();
    if (apiKeyNote !== null) rawLines.push(currentTheme.fg('textMuted', apiKeyNote));
    rawLines.push(
      '',
      labelStyled(t('tui.dialogs.providerForm.apiKeyEnvLabel'), fieldFocused('apiKeyEnv')),
      this.inputLine(this.apiKeyEnvInput, innerWidth),
      // The rule the field implements binds both credential sources, so the
      // hint is shown from whichever of the two has focus.
      ...hintFor(['apiKey', 'apiKeyEnv'], t('tui.dialogs.providerForm.apiKeyEnvHint')),
      '',
      labelStyled(t('tui.dialogs.providerForm.baseUrlLabel'), fieldFocused('baseUrl')),
      this.inputLine(this.baseUrlInput, innerWidth),
      '',
      labelStyled(
        t('tui.dialogs.providerForm.providerDefaultModelLabel'),
        fieldFocused('defaultModel'),
      ),
      this.inputLine(this.defaultModelInput, innerWidth),
      ...hintFor(['defaultModel'], t('tui.dialogs.providerForm.providerDefaultModelHint')),
      '',
      labelStyled(t('tui.dialogs.providerForm.customHeadersLabel'), fieldFocused('customHeaders')),
      this.inputLine(this.customHeadersInput, innerWidth),
      ...hintFor(['customHeaders'], t('tui.dialogs.providerForm.customHeadersHint')),
      '',
      labelStyled(t('tui.dialogs.providerForm.envLabel'), fieldFocused('env')),
      this.inputLine(this.envInput, innerWidth),
      ...hintFor(['env'], t('tui.dialogs.providerForm.envHint')),
      '',
      labelStyled(t('tui.dialogs.providerForm.modelsLabel'), fieldFocused('models')),
      ...this.modelsLines(innerWidth, fieldFocused('models')),
      '',
      this.saveLine(fieldFocused('save')),
      '',
      this.footerLine(),
    );
    const contentLines = rawLines.map((line) => truncateToWidth(line, innerWidth, '…'));

    if (safeWidth < 4) {
      return ['', ...contentLines.map((line) => truncateToWidth(line, safeWidth, '…'))];
    }

    const lines: string[] = [
      '',
      border('╭' + '─'.repeat(safeWidth - 2) + '╮'),
      border('│') + ' '.repeat(safeWidth - 2) + border('│'),
    ];
    for (const content of contentLines) {
      const rightPad = Math.max(0, innerWidth - visibleWidth(content));
      lines.push(border('│') + pad + content + ' '.repeat(rightPad) + border('│'));
    }
    lines.push(border('│') + ' '.repeat(safeWidth - 2) + border('│'));
    lines.push(border('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }

  private allInputs(): readonly Input[] {
    return [
      this.idInput,
      this.apiKeyInput,
      this.apiKeyEnvInput,
      this.baseUrlInput,
      this.defaultModelInput,
      this.customHeadersInput,
      this.envInput,
      this.rowModelInput,
      this.rowContextInput,
      this.rowMaxInputSizeInput,
      this.rowMaxOutputSizeInput,
      this.rowDisplayNameInput,
      this.rowSupportEffortsInput,
      this.rowOffEffortInput,
      this.rowReasoningKeyInput,
      this.rowBaseUrlInput,
    ];
  }

  /** The text field a printable key belongs to in the field (list) mode. */
  private activeInput(): Input {
    switch (this.activeField) {
      case 'apiKey':
        return this.apiKeyInput;
      case 'apiKeyEnv':
        return this.apiKeyEnvInput;
      case 'baseUrl':
        return this.baseUrlInput;
      case 'defaultModel':
        return this.defaultModelInput;
      case 'customHeaders':
        return this.customHeadersInput;
      case 'env':
        return this.envInput;
      case 'id':
      case 'type':
      case 'models':
      case 'save':
        return this.idInput;
    }
  }

  private inputLine(input: Input, innerWidth: number): string {
    const raw = input.render(innerWidth)[0] ?? INPUT_PREFIX;
    return this.disabled ? currentTheme.dim(raw) : raw;
  }

  private apiKeyLine(innerWidth: number): string {
    const raw = this.apiKeyInput.render(innerWidth)[0] ?? INPUT_PREFIX;
    // The managed (disabled) form is prefilled with the stored credential so a
    // submit round-trips it; masking therefore has to hold on this path too,
    // or the secret would render in clear text.
    if (this.disabled) return currentTheme.dim(maskInputLine(raw));
    if (this.apiKeyRevealed) return raw;
    return maskInputLine(raw);
  }

  /** The Ctrl-R affordance while the key is masked, or the managed note. */
  private apiKeyNoteLine(): string | null {
    if (this.disabled) return t('tui.dialogs.providerForm.apiKeyManaged');
    if (this.activeField !== 'apiKey' || this.apiKeyRevealed) return null;
    return t('tui.dialogs.providerForm.apiKeyRevealHint');
  }

  private typeLine(): string {
    const text = `‹ ${this.currentType()} ›`;
    if (this.disabled) return currentTheme.dim(text);
    const focused = this.focused && !this.done && this.modelsMode === 'list';
    return focused && this.activeField === 'type'
      ? currentTheme.boldFg('accent', text)
      : currentTheme.fg('text', text);
  }

  private modelsLines(innerWidth: number, focused: boolean): string[] {
    if (this.modelsMode === 'row') return this.rowEditorLines(innerWidth);
    const lines: string[] = [];
    for (const [index, row] of this.models.entries()) {
      const selected = focused && index === this.selectedRow;
      const summary = `${index + 1}. ${row.model}`;
      const pointer = selected ? currentTheme.fg('primary', `${SELECT_POINTER} `) : '  ';
      const label = selected
        ? currentTheme.boldFg('primary', summary)
        : currentTheme.fg(this.disabled ? 'textMuted' : 'text', summary);
      const left = pointer + label;
      const context = row.maxContextSize;
      const gap = Math.max(2, innerWidth - visibleWidth(left) - visibleWidth(context));
      lines.push(left + ' '.repeat(gap) + currentTheme.fg('textMuted', context));
    }
    if (focused) {
      const legend = [
        t('tui.dialogs.providerForm.addRow'),
        t('tui.dialogs.providerForm.removeRow'),
      ].join(' · ');
      lines.push(currentTheme.fg('textMuted', legend));
    }
    return lines;
  }

  private rowEditorLines(innerWidth: number): string[] {
    const draft = this.draftRow();
    const summary = t('tui.dialogs.providerForm.modelRowLabel', {
      index: String(this.selectedRow + 1),
      model: draft.model,
    });
    const active = this.focused && !this.done;
    const focusedHere = (field: RowFieldId): boolean => active && this.rowField === field;
    const hintFor = (field: RowFieldId, text: string): string[] =>
      focusedHere(field) ? [currentTheme.fg('textMuted', text)] : [];
    const selected = this.rowCapabilities ?? [];
    const capability = CAPABILITY_NAMES[this.rowCapabilityCursor] ?? CAPABILITY_NAMES[0];
    const capabilityValue =
      selected.length === 0 ? t('tui.dialogs.providerForm.capabilitiesNone') : selected.join(', ');
    return [
      currentTheme.fg('textStrong', summary),
      currentTheme.fg('textMuted', t('tui.dialogs.providerForm.optionalHint')),
      ...this.overridesLines(),
      labelStyled(t('tui.dialogs.providerForm.modelIdLabel'), focusedHere('model')),
      this.inputLine(this.rowModelInput, innerWidth),
      labelStyled(t('tui.dialogs.providerForm.contextLabel'), focusedHere('context')),
      this.inputLine(this.rowContextInput, innerWidth),
      labelStyled(t('tui.dialogs.providerForm.maxInputSizeLabel'), focusedHere('maxInputSize')),
      this.inputLine(this.rowMaxInputSizeInput, innerWidth),
      ...hintFor('maxInputSize', t('tui.dialogs.providerForm.maxInputSizeHint')),
      labelStyled(t('tui.dialogs.providerForm.maxOutputSizeLabel'), focusedHere('maxOutputSize')),
      this.inputLine(this.rowMaxOutputSizeInput, innerWidth),
      labelStyled(t('tui.dialogs.providerForm.displayNameLabel'), focusedHere('displayName')),
      this.inputLine(this.rowDisplayNameInput, innerWidth),
      labelStyled(
        t('tui.dialogs.providerForm.capabilitiesValue', { value: capabilityValue }),
        focusedHere('capabilities'),
      ),
      this.capabilityPickerLine(capability, selected.includes(capability)),
      ...hintFor('capabilities', t('tui.dialogs.providerForm.capabilitiesHint')),
      labelStyled(t('tui.dialogs.providerForm.supportEffortsLabel'), focusedHere('supportEfforts')),
      this.inputLine(this.rowSupportEffortsInput, innerWidth),
      ...hintFor('supportEfforts', t('tui.dialogs.providerForm.supportEffortsHint')),
      labelStyled(t('tui.dialogs.providerForm.defaultEffortLabel'), focusedHere('defaultEffort')),
      this.defaultEffortLine(),
      labelStyled(t('tui.dialogs.providerForm.offEffortLabel'), focusedHere('offEffort')),
      this.inputLine(this.rowOffEffortInput, innerWidth),
      this.toggleLine(
        'adaptiveThinking',
        t('tui.dialogs.providerForm.adaptiveThinkingLabel'),
        this.rowAdaptiveThinking,
      ),
      ...hintFor('adaptiveThinking', t('tui.dialogs.providerForm.adaptiveThinkingHint')),
      labelStyled(t('tui.dialogs.providerForm.protocolLabel'), focusedHere('protocol')),
      this.protocolLine(),
      ...hintFor('protocol', t('tui.dialogs.providerForm.protocolHint')),
      this.toggleLine('betaApi', t('tui.dialogs.providerForm.betaApiLabel'), this.rowBetaApi),
      ...hintFor('betaApi', t('tui.dialogs.providerForm.betaApiHint')),
      labelStyled(t('tui.dialogs.providerForm.reasoningKeyLabel'), focusedHere('reasoningKey')),
      this.inputLine(this.rowReasoningKeyInput, innerWidth),
      ...hintFor('reasoningKey', t('tui.dialogs.providerForm.reasoningKeyHint')),
      labelStyled(t('tui.dialogs.providerForm.modelBaseUrlLabel'), focusedHere('baseUrl')),
      this.inputLine(this.rowBaseUrlInput, innerWidth),
      ...hintFor('baseUrl', t('tui.dialogs.providerForm.modelBaseUrlHint')),
    ];
  }

  /**
   * The stored-overrides block: the layer the engine applies OVER every field
   * above, which the form deliberately does not edit. Ctrl-X queues a drop, and
   * a queued drop is rendered in the warning colour so the pending change is
   * visible before the row is committed.
   */
  private overridesLines(): string[] {
    const row = this.draftRow();
    if (row.hasStoredOverrides !== true) return [];
    const notice = t('tui.dialogs.providerForm.overridesNotice');
    const hint = t('tui.dialogs.providerForm.overridesClearHint');
    return row.clearOverrides === true
      ? [currentTheme.boldFg('warning', notice), currentTheme.boldFg('warning', hint)]
      : [currentTheme.fg('textMuted', notice), currentTheme.fg('textMuted', hint)];
  }

  /** The capability under the Left / Right cursor, checked when selected. */
  private capabilityPickerLine(capability: string, selected: boolean): string {
    const text = `‹ [${selected ? '✓' : ' '}] ${capability} ›`;
    if (this.disabled) return currentTheme.dim(text);
    return this.rowFieldFocused('capabilities')
      ? currentTheme.boldFg('accent', text)
      : currentTheme.fg('text', text);
  }

  /** The default effort under the Left / Right cursor, limited to the row's ladder. */
  private defaultEffortLine(): string {
    const text = `‹ ${this.defaultEffortText()} ›`;
    if (this.disabled) return currentTheme.dim(text);
    return this.rowFieldFocused('defaultEffort')
      ? currentTheme.boldFg('accent', text)
      : currentTheme.fg('text', text);
  }

  /** The protocol override under the Left / Right cursor. */
  private protocolLine(): string {
    const protocol =
      this.rowProtocol === '' ? t('tui.dialogs.providerForm.protocolNotSet') : this.rowProtocol;
    const text = `‹ ${protocol} ›`;
    if (this.disabled) return currentTheme.dim(text);
    return this.rowFieldFocused('protocol')
      ? currentTheme.boldFg('accent', text)
      : currentTheme.fg('text', text);
  }

  /** The selected default effort, or the "not declared" label standing for `''`. */
  private defaultEffortText(): string {
    if (this.rowDefaultEffort !== '') return this.rowDefaultEffort;
    return t('tui.dialogs.providerForm.toggleNotDeclared');
  }

  /**
   * A Space-driven field: the label with its state beside it, two spaces apart,
   * coloured the way DESIGN.md §7 prescribes — `success` while declared on,
   * `textDim` while declared off, and the faintest token for the state the form
   * does not own.
   */
  private toggleLine(
    field: RowFieldId,
    label: string,
    value: ProviderFormToggle | undefined,
  ): string {
    const state = toggleStateText(value);
    if (this.disabled) return currentTheme.dim(`${label}  ${state}`);
    if (this.rowFieldFocused(field)) return currentTheme.boldFg('accent', `${label}  ${state}`);
    const styled =
      value === true
        ? currentTheme.fg('success', state)
        : currentTheme.fg(value === false ? 'textDim' : 'textMuted', state);
    return `${labelStyled(label, false)}  ${styled}`;
  }

  private rowFieldFocused(field: RowFieldId): boolean {
    return this.focused && !this.done && this.modelsMode === 'row' && this.rowField === field;
  }

  private saveLine(focused: boolean): string {
    const text = `[ ${t('tui.dialogs.providerForm.save')} ]`;
    if (this.disabled) return currentTheme.fg('textMuted', text);
    return focused ? currentTheme.boldFg('accent', text) : currentTheme.fg('text', text);
  }

  private footerLine(): string {
    if (this.disabled) {
      return currentTheme.fg('textDim', t('tui.dialogs.providerForm.managedReadonly'));
    }
    if (this.modelsMode === 'row') {
      return currentTheme.fg('textDim', t('tui.dialogs.providerForm.footerRow'));
    }
    switch (this.activeField) {
      case 'models':
        return currentTheme.fg('textDim', t('tui.dialogs.providerForm.footerList'));
      case 'save':
        return currentTheme.fg('textDim', t('tui.dialogs.providerForm.footerSave'));
      case 'id':
      case 'type':
      case 'apiKey':
      case 'apiKeyEnv':
      case 'baseUrl':
      case 'defaultModel':
      case 'customHeaders':
      case 'env':
        return currentTheme.fg('textDim', t('tui.dialogs.providerForm.footerFields'));
    }
  }

  private currentType(): ProviderType {
    // `types` always holds at least the six, so the fallback is unreachable —
    // it exists because an index read is `| undefined` under
    // `noUncheckedIndexedAccess`, not because `kimi` is a real answer.
    return this.types[this.typeIndex] ?? PROVIDER_WIRE_TYPES[0];
  }

  private moveField(delta: number, wrap: boolean): void {
    this.activeField = step(FIELD_ORDER, this.activeField, delta, wrap) ?? this.activeField;
  }

  private cycleType(delta: number): void {
    const count = this.types.length;
    this.typeIndex = (this.typeIndex + delta + count) % count;
    const baseUrl = this.baseUrlInput.getValue();
    if (baseUrl !== '') {
      this.baseUrlInput.setValue(normalizeBaseUrlForType(baseUrl, this.currentType()));
    }
  }

  private selectRow(index: number): void {
    this.selectedRow = Math.min(this.models.length - 1, Math.max(0, index));
  }

  private appendRow(): void {
    this.models.push(defaultModelRow());
    this.selectedRow = this.models.length - 1;
    this.openRowEditor();
  }

  private removeRow(): void {
    // The official form disables delete at one row; keep the last row.
    if (this.models.length <= 1) return;
    this.models.splice(this.selectedRow, 1);
    this.selectRow(this.selectedRow);
  }

  private draftRow(): ProviderFormModelRow {
    return this.models[this.selectedRow] ?? defaultModelRow();
  }

  private openRowEditor(): void {
    const row = this.draftRow();
    this.rowBackup = { ...row };
    this.rowModelInput.setValue(row.model);
    this.rowContextInput.setValue(row.maxContextSize);
    this.rowMaxInputSizeInput.setValue(row.maxInputSize ?? '');
    this.rowMaxOutputSizeInput.setValue(row.maxOutputSize ?? '');
    this.rowDisplayNameInput.setValue(row.displayName);
    this.rowSupportEffortsInput.setValue(row.supportEfforts ?? '');
    this.rowOffEffortInput.setValue(row.offEffort ?? '');
    this.rowReasoningKeyInput.setValue(row.reasoningKey ?? '');
    this.rowBaseUrlInput.setValue(row.baseUrl ?? '');
    this.rowCapabilities = row.capabilities === undefined ? undefined : [...row.capabilities];
    this.rowCapabilityCursor = 0;
    this.rowAdaptiveThinking = row.adaptiveThinking;
    this.rowBetaApi = row.betaApi;
    this.rowProtocol = row.protocol ?? '';
    // A stored value is presented as it is, even when the ladder does not offer
    // it: the form never rewrites a declaration it cannot show, and validation
    // refuses such a value instead (`defaultEffortNotSupported`). `←` / `→` step
    // from it into the ladder.
    this.rowDefaultEffort = (row.defaultEffort ?? '').trim();
    this.rowField = 'model';
    this.modelsMode = 'row';
  }

  private commitRow(): void {
    const previous = this.draftRow();
    const row: ProviderFormModelRow = {
      model: this.rowModelInput.getValue(),
      maxContextSize: this.rowContextInput.getValue(),
      displayName: this.rowDisplayNameInput.getValue(),
    };
    assignOptionalText(
      row,
      'maxInputSize',
      this.rowMaxInputSizeInput.getValue(),
      previous.maxInputSize,
    );
    assignOptionalText(
      row,
      'maxOutputSize',
      this.rowMaxOutputSizeInput.getValue(),
      previous.maxOutputSize,
    );
    assignOptionalText(
      row,
      'supportEfforts',
      this.rowSupportEffortsInput.getValue(),
      previous.supportEfforts,
    );
    assignOptionalText(row, 'defaultEffort', this.rowDefaultEffort, previous.defaultEffort);
    assignOptionalText(row, 'offEffort', this.rowOffEffortInput.getValue(), previous.offEffort);
    assignOptionalText(
      row,
      'reasoningKey',
      this.rowReasoningKeyInput.getValue(),
      previous.reasoningKey,
    );
    assignOptionalText(row, 'baseUrl', this.rowBaseUrlInput.getValue(), previous.baseUrl);
    if (this.rowCapabilities !== undefined) row.capabilities = [...this.rowCapabilities];
    if (this.rowAdaptiveThinking !== undefined) row.adaptiveThinking = this.rowAdaptiveThinking;
    if (this.rowBetaApi !== undefined) row.betaApi = this.rowBetaApi;
    if (this.rowProtocol !== '' || previous.protocol !== undefined) row.protocol = this.rowProtocol;
    // Both flags are the editor's, not the write's: the notice has to survive
    // the round-trip through the row, and a queued clear has to reach the write.
    if (previous.hasStoredOverrides === true) row.hasStoredOverrides = true;
    if (previous.clearOverrides === true) row.clearOverrides = true;
    this.models[this.selectedRow] = row;
    this.rowBackup = null;
    this.modelsMode = 'list';
  }

  private discardRow(): void {
    if (this.rowBackup !== null) this.models[this.selectedRow] = this.rowBackup;
    this.rowBackup = null;
    this.modelsMode = 'list';
  }

  private handleRowInput(data: string): void {
    if (matchesKey(data, Key.tab)) {
      this.moveRowField(1, true);
      return;
    }
    if (matchesKey(data, Key.shift('tab'))) {
      this.moveRowField(-1, true);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveRowField(-1, false);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveRowField(1, false);
      return;
    }
    this.hint = null;
    if (matchesKey(data, Key.ctrl('x'))) {
      this.clearStoredOverrides();
      return;
    }
    if (this.rowField === 'capabilities') {
      if (matchesKey(data, Key.left)) {
        this.moveCapabilityCursor(-1);
        return;
      }
      if (matchesKey(data, Key.right)) {
        this.moveCapabilityCursor(1);
        return;
      }
      if (matchesKey(data, Key.space) || printableChar(data) === ' ') {
        this.toggleCapability();
        return;
      }
      if (isSubmit(data)) this.moveRowField(1, false);
      return;
    }
    if (this.rowField === 'protocol') {
      if (matchesKey(data, Key.left)) {
        this.cycleRowProtocol(-1);
        return;
      }
      if (matchesKey(data, Key.right)) {
        this.cycleRowProtocol(1);
        return;
      }
      if (isSubmit(data)) this.moveRowField(1, false);
      return;
    }
    if (this.rowField === 'defaultEffort') {
      if (matchesKey(data, Key.left)) {
        this.cycleDefaultEffort(-1);
        return;
      }
      if (matchesKey(data, Key.right)) {
        this.cycleDefaultEffort(1);
        return;
      }
      if (isSubmit(data)) this.moveRowField(1, false);
      return;
    }
    if (this.rowField === 'adaptiveThinking' || this.rowField === 'betaApi') {
      if (matchesKey(data, Key.space) || printableChar(data) === ' ') {
        this.toggleRowSwitch(this.rowField);
        return;
      }
      if (isSubmit(data)) this.moveRowField(1, false);
      return;
    }
    this.rowInput(this.rowField).handleInput(data);
  }

  /** Next / previous row field, clamped or wrapping at the ends. */
  private moveRowField(delta: number, wrap: boolean): void {
    this.rowField = step(ROW_FIELD_ORDER, this.rowField, delta, wrap) ?? this.rowField;
  }

  private moveCapabilityCursor(delta: number): void {
    const count = CAPABILITY_NAMES.length;
    this.rowCapabilityCursor = (this.rowCapabilityCursor + delta + count) % count;
  }

  /**
   * Flip the capability under the cursor. Toggling also drops names the form
   * does not offer — validation refuses them anyway, so this is the only way
   * to clear one a stored alias carried.
   */
  private toggleCapability(): void {
    const name = CAPABILITY_NAMES[this.rowCapabilityCursor] ?? CAPABILITY_NAMES[0];
    const selected = new Set<string>(this.rowCapabilities ?? []);
    if (selected.has(name)) selected.delete(name);
    else selected.add(name);
    // Rebuilt in CAPABILITY_NAMES order so the summary line does not reshuffle
    // as the user toggles.
    this.rowCapabilities = CAPABILITY_NAMES.filter((capability) => selected.has(capability));
  }

  /** Space on a toggle field: not declared → enabled → disabled → not declared. */
  private toggleRowSwitch(field: 'adaptiveThinking' | 'betaApi'): void {
    if (field === 'adaptiveThinking') {
      this.rowAdaptiveThinking = nextToggleState(this.rowAdaptiveThinking);
      return;
    }
    this.rowBetaApi = nextToggleState(this.rowBetaApi);
  }

  /**
   * Ctrl-X queues the stored `overrides` for deletion; the pending state is
   * rendered from the draft row, and only a row that carries them can be
   * queued. Esc discards the row, which drops the queue with it.
   */
  private clearStoredOverrides(): void {
    const row = this.draftRow();
    if (row.hasStoredOverrides !== true) return;
    row.clearOverrides = true;
  }

  /**
   * The row's protocol override cycle. Unlike the provider `type` field this
   * never touches the base URL: the per-model endpoint is its own field, and a
   * model's override may legitimately disagree with the type's normalization.
   */
  private cycleRowProtocol(delta: number): void {
    const count = ROW_PROTOCOLS.length;
    const index = Math.max(0, ROW_PROTOCOLS.indexOf(this.rowProtocol));
    this.rowProtocol = ROW_PROTOCOLS[(index + delta + count) % count] ?? '';
  }

  /**
   * The ladder the row declares, with the leading "not declared" position that
   * yields `''`. `rowEffortLadder` decodes the `[]` literal, which
   * `parseEffortList` alone would read as a single effort named `[]`.
   */
  private effortOptions(ladderText: string): string[] {
    const ladder = rowEffortLadder(ladderText);
    return ['', ...(ladder === undefined || ladder === 'clear' ? [] : ladder)];
  }

  private cycleDefaultEffort(delta: number): void {
    const options = this.effortOptions(this.rowSupportEffortsInput.getValue());
    const index = Math.max(0, options.indexOf(this.rowDefaultEffort));
    this.rowDefaultEffort = options[(index + delta + options.length) % options.length] ?? '';
  }

  private rowInput(field: RowFieldId): Input {
    switch (field) {
      case 'model':
        return this.rowModelInput;
      case 'context':
        return this.rowContextInput;
      case 'maxInputSize':
        return this.rowMaxInputSizeInput;
      case 'maxOutputSize':
        return this.rowMaxOutputSizeInput;
      case 'displayName':
        return this.rowDisplayNameInput;
      case 'supportEfforts':
        return this.rowSupportEffortsInput;
      case 'offEffort':
        return this.rowOffEffortInput;
      case 'reasoningKey':
        return this.rowReasoningKeyInput;
      case 'baseUrl':
        return this.rowBaseUrlInput;
      case 'capabilities':
      case 'defaultEffort':
      case 'adaptiveThinking':
      case 'protocol':
      case 'betaApi':
        // Not text fields: their keys are handled before this point.
        return this.rowModelInput;
    }
  }

  private submit(): void {
    if (this.done) return;
    const value: ProviderFormValue = {
      id: this.idInput.getValue(),
      type: this.currentType(),
      apiKey: this.apiKeyInput.getValue(),
      apiKeyEnv: ownedText(this.apiKeyEnvInput.getValue(), this.declared.apiKeyEnv),
      baseUrl: this.baseUrlInput.getValue(),
      defaultModel: ownedText(this.defaultModelInput.getValue(), this.declared.defaultModel),
      customHeaders: ownedText(this.customHeadersInput.getValue(), this.declared.customHeaders),
      env: ownedText(this.envInput.getValue(), this.declared.env),
      models: this.models.map((row) => ({ ...row })),
    };
    // Adding requires a credential, and the engine takes it from either source:
    // requiring the inline key unconditionally would make the environment-variable
    // field unusable in the one mode where nothing is stored yet, because
    // `validateProviderForm` refuses a record that sets both.
    const error = validateProviderForm(value, {
      requireApiKey: this.mode === 'add' && (value.apiKeyEnv ?? '').trim() === '',
    });
    if (error !== null) {
      this.hint = error;
      this.focusError(error);
      return;
    }
    this.done = true;
    this.onDone({ kind: 'ok', value });
  }

  /** Moves focus to whatever the failing code points at, keeping the input. */
  private focusError(error: ProviderFormError): void {
    switch (error) {
      case 'idRequired':
      case 'idInvalid':
        this.activeField = 'id';
        return;
      case 'apiKeyRequired':
        this.activeField = 'apiKey';
        return;
      case 'baseUrlRequired':
        this.activeField = 'baseUrl';
        return;
      case 'modelRequired':
        this.focusRowError((row) => row.model.trim() === '', 'model');
        return;
      case 'contextSizeRequired':
        this.focusRowError((row) => row.maxContextSize.trim() === '', 'context');
        return;
      case 'contextSizeInvalid':
        this.focusRowError(
          (row) =>
            row.maxContextSize.trim() !== '' &&
            !POSITIVE_INTEGER_PATTERN.test(row.maxContextSize.trim()),
          'context',
        );
        return;
      case 'modelDuplicate':
        // Focus the first row of every duplicated-model group.
        this.focusRowError(
          (row) =>
            this.models.some((other) => other !== row && other.model.trim() === row.model.trim()),
          'model',
        );
        return;
      case 'capabilityUnknown':
        this.focusRowError(
          (row) => (row.capabilities ?? []).some((capability) => !isCapabilityName(capability)),
          'capabilities',
        );
        return;
      case 'defaultEffortNotSupported':
        this.focusRowError((row) => {
          const effort = row.defaultEffort?.trim() ?? '';
          if (effort === '') return false;
          const ladder = rowEffortLadder(row.supportEfforts);
          const efforts = ladder === undefined || ladder === 'clear' ? [] : ladder;
          return !efforts.includes(effort);
        }, 'defaultEffort');
        return;
      case 'apiKeyConflict':
        // Both credential sources are filled; the environment-variable field is
        // the one whose hint spells the rule out.
        this.activeField = 'apiKeyEnv';
        return;
      case 'defaultModelUnknown':
        this.activeField = 'defaultModel';
        return;
      case 'headerInvalid':
        this.activeField = 'customHeaders';
        return;
      case 'envInvalid':
        this.activeField = 'env';
        return;
      case 'betaApiWithoutAnthropic':
        // Mirrors the validator: the beta API reaches the wire only through the
        // Anthropic transport, selected by the provider's type or the row's own
        // protocol override.
        this.focusRowError(
          (row) =>
            row.betaApi === true &&
            this.currentType() !== 'anthropic' &&
            row.protocol !== 'anthropic',
          'betaApi',
        );
        return;
      case 'modelBaseUrlInvalid':
        this.focusRowError((row) => {
          const baseUrl = (row.baseUrl ?? '').trim();
          return baseUrl !== '' && !HTTP_URL_PATTERN.test(baseUrl);
        }, 'baseUrl');
        return;
    }
  }

  private focusRowError(
    predicate: (row: ProviderFormModelRow) => boolean,
    field: RowFieldId,
  ): void {
    const index = this.models.findIndex(predicate);
    this.activeField = 'models';
    this.selectRow(Math.max(0, index));
    this.openRowEditor();
    this.rowField = field;
  }

  private cancel(): void {
    if (this.done) return;
    this.done = true;
    this.onDone({ kind: 'cancel' });
  }
}

/** True for the keys an Input's own submit binding accepts (Enter / Ctrl-J). */
function isSubmit(data: string): boolean {
  return matchesKey(data, Key.enter) || data === '\n';
}

/** Next value in a fixed order, wrapping or clamping at the ends. */
function step<T>(order: readonly T[], current: T, delta: number, wrap: boolean): T | undefined {
  const count = order.length;
  const index = order.indexOf(current);
  const next = wrap
    ? (index + delta + count) % count
    : Math.min(count - 1, Math.max(0, index + delta));
  return order[next];
}
