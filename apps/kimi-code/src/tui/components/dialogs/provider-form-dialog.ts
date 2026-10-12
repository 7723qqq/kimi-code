/**
 * ProviderFormDialog — the manual provider form behind `/provider` → add /
 * edit. Rounded box geometry mirrors `CustomRegistryImportDialogComponent`
 * (Container + Focusable, hint line, focus-driven footer) so the chrome stays
 * consistent with the API-key login flow.
 *
 * Field order: id → type → apiKey → baseUrl → models → Save. Tab / Shift-Tab /
 * Up / Down move between fields, Enter advances (from the models zone it opens
 * the selected row, from Save it submits), Esc / Ctrl-C cancel. `type` is not
 * an input: Left / Right / Space cycle `PROVIDER_WIRE_TYPES` and re-normalize
 * a filled base URL for the new type (anthropic drops a trailing `/v1`).
 *
 * The models zone is a row summary list (Up / Down select, `A` append, `D`
 * delete — never below one row, `E` / Enter edit); the row editor (Model ID →
 * Context → Max input → Max output → Display name → Capabilities → Thinking
 * efforts → Default effort → Off effort → Adaptive thinking) lives inside the
 * same box as a sub-state, so no nested dialog is needed. Two of those fields
 * are not text: Capabilities is a Left / Right cursor with Space toggling the
 * name under it, Adaptive thinking is a Space toggle. The API key renders
 * masked; Ctrl-R reveals it.
 *
 * Every optional row field is three-state — `undefined` means the form does
 * not own it (the alias keeps what it declared), `''` means the user cleared
 * it (the write deletes the key), anything else is written as typed — so the
 * editor only turns a blank into `''` for a field the row already carried.
 *
 * Validation is `validateProviderForm` from `#/utils/provider-form`; the
 * failing code renders as an inline hint (top of the form) and the focus
 * jumps to the offending field, keeping every value the user typed.
 *
 * A managed provider (`provider.oauth !== undefined`) renders read-only:
 * nothing is focusable, no key mutates the form, and the footer explains why.
 */

import type { ProviderConfig } from '@moonshot-ai/kimi-code-sdk';
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
  isCapabilityName,
  normalizeBaseUrlForType,
  parseEffortList,
  PROVIDER_WIRE_TYPES,
  validateProviderForm,
  type ProviderFormError,
  type ProviderFormModelRow,
  type ProviderFormValue,
  type ProviderWireType,
} from '#/utils/provider-form';

/** Edit-mode prefill; `oauth` marks a managed provider and locks the form. */
export interface ProviderFormInitial {
  readonly id: string;
  readonly type: ProviderWireType;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly models?: readonly ProviderFormModelRow[];
  readonly oauth?: ProviderConfig['oauth'];
}

export interface ProviderFormDialogOptions {
  readonly mode: 'add' | 'edit';
  /** Ignored in add mode. */
  readonly provider?: ProviderFormInitial;
}

export type ProviderFormDialogResult =
  | { readonly kind: 'ok'; readonly value: ProviderFormValue }
  | { readonly kind: 'cancel' };

type FieldId = 'id' | 'type' | 'apiKey' | 'baseUrl' | 'models' | 'save';
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
  | 'adaptiveThinking';

const FIELD_ORDER: readonly FieldId[] = ['id', 'type', 'apiKey', 'baseUrl', 'models', 'save'];
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
];
const INPUT_PREFIX = '> ';
const POSITIVE_INTEGER_PATTERN = /^\d+$/;

function hintText(code: ProviderFormError): string {
  switch (code) {
    case 'idRequired':
      return t('tui.dialogs.providerForm.error.idRequired');
    case 'idInvalid':
      return t('tui.dialogs.providerForm.error.idInvalid');
    case 'apiKeyRequired':
      return t('tui.dialogs.providerForm.error.apiKeyRequired');
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
  key: 'maxInputSize' | 'maxOutputSize' | 'supportEfforts' | 'defaultEffort' | 'offEffort',
  raw: string,
  previous: string | undefined,
): void {
  if (raw === '' && previous === undefined) return;
  row[key] = raw;
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

  /** True for a managed provider (`oauth` set): every field is locked. */
  readonly disabled: boolean;

  private readonly mode: 'add' | 'edit';
  private readonly onDone: (result: ProviderFormDialogResult) => void;
  private readonly idInput = new Input();
  private readonly apiKeyInput = new Input();
  private readonly baseUrlInput = new Input();
  private readonly rowModelInput = new Input();
  private readonly rowContextInput = new Input();
  private readonly rowMaxInputSizeInput = new Input();
  private readonly rowMaxOutputSizeInput = new Input();
  private readonly rowDisplayNameInput = new Input();
  private readonly rowSupportEffortsInput = new Input();
  private readonly rowDefaultEffortInput = new Input();
  private readonly rowOffEffortInput = new Input();

  private activeField: FieldId = 'id';
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
  private rowAdaptiveThinking: boolean | undefined;
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
    this.disabled = provider?.oauth !== undefined;
    if (provider !== undefined) {
      this.idInput.setValue(provider.id);
      this.typeIndex = Math.max(0, PROVIDER_WIRE_TYPES.indexOf(provider.type));
      if (provider.apiKey !== undefined) this.apiKeyInput.setValue(provider.apiKey);
      if (provider.baseUrl !== undefined) this.baseUrlInput.setValue(provider.baseUrl);
      this.models = (provider.models ?? []).map((row) => ({ ...row }));
    }
    if (this.models.length === 0) this.models.push(defaultModelRow());

    // Enter on a text field advances instead of submitting; the row editor's
    // last field writes the row back and returns to the summary list.
    this.idInput.onSubmit = () => {
      this.moveField(1, false);
    };
    this.apiKeyInput.onSubmit = () => {
      this.moveField(1, false);
    };
    this.baseUrlInput.onSubmit = () => {
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
    this.rowDefaultEffortInput.onSubmit = () => {
      this.rowField = 'offEffort';
    };
    this.rowOffEffortInput.onSubmit = () => {
      this.rowField = 'adaptiveThinking';
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
    this.baseUrlInput.focused = fieldFocused('baseUrl');
    this.rowModelInput.focused = rowFocused('model');
    this.rowContextInput.focused = rowFocused('context');
    this.rowMaxInputSizeInput.focused = rowFocused('maxInputSize');
    this.rowMaxOutputSizeInput.focused = rowFocused('maxOutputSize');
    this.rowDisplayNameInput.focused = rowFocused('displayName');
    this.rowSupportEffortsInput.focused = rowFocused('supportEfforts');
    this.rowDefaultEffortInput.focused = rowFocused('defaultEffort');
    this.rowOffEffortInput.focused = rowFocused('offEffort');

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];
    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    const border = (s: string): string => currentTheme.fg('primary', s);
    const title =
      this.mode === 'add'
        ? t('tui.dialogs.providerForm.titleAdd')
        : t('tui.dialogs.providerForm.titleEdit');

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
      labelStyled(t('tui.dialogs.providerForm.baseUrlLabel'), fieldFocused('baseUrl')),
      this.inputLine(this.baseUrlInput, innerWidth),
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
      this.baseUrlInput,
      this.rowModelInput,
      this.rowContextInput,
      this.rowMaxInputSizeInput,
      this.rowMaxOutputSizeInput,
      this.rowDisplayNameInput,
      this.rowSupportEffortsInput,
      this.rowDefaultEffortInput,
      this.rowOffEffortInput,
    ];
  }

  /** The text field a printable key belongs to in the field (list) mode. */
  private activeInput(): Input {
    switch (this.activeField) {
      case 'apiKey':
        return this.apiKeyInput;
      case 'baseUrl':
        return this.baseUrlInput;
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
      this.inputLine(this.rowDefaultEffortInput, innerWidth),
      labelStyled(t('tui.dialogs.providerForm.offEffortLabel'), focusedHere('offEffort')),
      this.inputLine(this.rowOffEffortInput, innerWidth),
      labelStyled(
        t('tui.dialogs.providerForm.adaptiveThinkingLabel'),
        focusedHere('adaptiveThinking'),
      ),
      this.adaptiveThinkingLine(),
      ...hintFor('adaptiveThinking', t('tui.dialogs.providerForm.adaptiveThinkingHint')),
    ];
  }

  /** The capability under the Left / Right cursor, checked when selected. */
  private capabilityPickerLine(capability: string, selected: boolean): string {
    const text = `‹ [${selected ? '✓' : ' '}] ${capability} ›`;
    if (this.disabled) return currentTheme.dim(text);
    return this.rowFieldFocused('capabilities')
      ? currentTheme.boldFg('accent', text)
      : currentTheme.fg('text', text);
  }

  /** The adaptive-thinking toggle: a Space-driven on / off switch. */
  private adaptiveThinkingLine(): string {
    const on = this.rowAdaptiveThinking === true;
    const text = on ? '[✓] enabled' : '[ ] disabled';
    if (this.disabled) return currentTheme.dim(text);
    if (this.rowFieldFocused('adaptiveThinking')) return currentTheme.boldFg('accent', text);
    return on ? currentTheme.fg('success', text) : currentTheme.fg('textDim', text);
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
      case 'baseUrl':
        return currentTheme.fg('textDim', t('tui.dialogs.providerForm.footerFields'));
    }
  }

  private currentType(): ProviderWireType {
    return PROVIDER_WIRE_TYPES[this.typeIndex] ?? PROVIDER_WIRE_TYPES[0];
  }

  private moveField(delta: number, wrap: boolean): void {
    this.activeField = step(FIELD_ORDER, this.activeField, delta, wrap) ?? this.activeField;
  }

  private cycleType(delta: number): void {
    const count = PROVIDER_WIRE_TYPES.length;
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
    this.rowDefaultEffortInput.setValue(row.defaultEffort ?? '');
    this.rowOffEffortInput.setValue(row.offEffort ?? '');
    this.rowCapabilities = row.capabilities === undefined ? undefined : [...row.capabilities];
    this.rowCapabilityCursor = 0;
    this.rowAdaptiveThinking = row.adaptiveThinking;
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
    assignOptionalText(
      row,
      'defaultEffort',
      this.rowDefaultEffortInput.getValue(),
      previous.defaultEffort,
    );
    assignOptionalText(row, 'offEffort', this.rowOffEffortInput.getValue(), previous.offEffort);
    if (this.rowCapabilities !== undefined) row.capabilities = [...this.rowCapabilities];
    if (this.rowAdaptiveThinking !== undefined) row.adaptiveThinking = this.rowAdaptiveThinking;
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
    if (this.rowField === 'adaptiveThinking') {
      if (matchesKey(data, Key.space) || printableChar(data) === ' ') {
        this.toggleAdaptiveThinking();
        return;
      }
      if (isSubmit(data)) this.commitRow();
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

  private toggleAdaptiveThinking(): void {
    this.rowAdaptiveThinking = this.rowAdaptiveThinking !== true;
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
      case 'defaultEffort':
        return this.rowDefaultEffortInput;
      case 'offEffort':
        return this.rowOffEffortInput;
      case 'capabilities':
      case 'adaptiveThinking':
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
      baseUrl: this.baseUrlInput.getValue(),
      models: this.models.map((row) => ({ ...row })),
    };
    const error = validateProviderForm(value, { requireApiKey: this.mode === 'add' });
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
          return !parseEffortList(row.supportEfforts).includes(effort);
        }, 'defaultEffort');
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
