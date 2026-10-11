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
 * Context → Display name) lives inside the same box as a sub-state, so no
 * nested dialog is needed. The API key renders masked; Ctrl-R reveals it.
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
  defaultModelRow,
  normalizeBaseUrlForType,
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
type RowFieldId = 'model' | 'context' | 'displayName';

const FIELD_ORDER: readonly FieldId[] = ['id', 'type', 'apiKey', 'baseUrl', 'models', 'save'];
const ROW_FIELD_ORDER: readonly RowFieldId[] = ['model', 'context', 'displayName'];
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
  }
}

function labelStyled(text: string, focused: boolean): string {
  return focused ? currentTheme.boldFg('accent', text) : currentTheme.fg('textDim', text);
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
  private readonly rowDisplayNameInput = new Input();

  private activeField: FieldId = 'id';
  private typeIndex = 0;
  private models: ProviderFormModelRow[] = [];
  private selectedRow = 0;
  private modelsMode: 'list' | 'row' = 'list';
  private rowField: RowFieldId = 'model';
  private rowBackup: ProviderFormModelRow | null = null;
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
      this.rowField = 'displayName';
    };
    this.rowDisplayNameInput.onSubmit = () => {
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
    this.baseUrlInput.focused = fieldFocused('baseUrl');
    this.rowModelInput.focused = rowFocused('model');
    this.rowContextInput.focused = rowFocused('context');
    this.rowDisplayNameInput.focused = rowFocused('displayName');

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
      this.rowDisplayNameInput,
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
    return [
      currentTheme.fg('textStrong', summary),
      labelStyled(t('tui.dialogs.providerForm.modelIdLabel'), active && this.rowField === 'model'),
      this.inputLine(this.rowModelInput, innerWidth),
      labelStyled(
        t('tui.dialogs.providerForm.contextLabel'),
        active && this.rowField === 'context',
      ),
      this.inputLine(this.rowContextInput, innerWidth),
      labelStyled(
        t('tui.dialogs.providerForm.displayNameLabel'),
        active && this.rowField === 'displayName',
      ),
      this.inputLine(this.rowDisplayNameInput, innerWidth),
    ];
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
    this.rowDisplayNameInput.setValue(row.displayName);
    this.rowField = 'model';
    this.modelsMode = 'row';
  }

  private commitRow(): void {
    this.models[this.selectedRow] = {
      model: this.rowModelInput.getValue(),
      maxContextSize: this.rowContextInput.getValue(),
      displayName: this.rowDisplayNameInput.getValue(),
    };
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
      this.rowField = step(ROW_FIELD_ORDER, this.rowField, 1, true) ?? this.rowField;
      return;
    }
    if (matchesKey(data, Key.shift('tab'))) {
      this.rowField = step(ROW_FIELD_ORDER, this.rowField, -1, true) ?? this.rowField;
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.rowField = step(ROW_FIELD_ORDER, this.rowField, -1, false) ?? this.rowField;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.rowField = step(ROW_FIELD_ORDER, this.rowField, 1, false) ?? this.rowField;
      return;
    }
    this.hint = null;
    this.rowInput(this.rowField).handleInput(data);
  }

  private rowInput(field: RowFieldId): Input {
    switch (field) {
      case 'model':
        return this.rowModelInput;
      case 'context':
        return this.rowContextInput;
      case 'displayName':
        return this.rowDisplayNameInput;
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
