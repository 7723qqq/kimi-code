import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { t } from '#/i18n';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { printableChar } from '#/tui/utils/printable-key';
import {
  ASTRON_DEFAULT_SETTINGS,
  type AstronSettings,
  loadTuiConfig,
  saveTuiConfig,
} from '#/tui/config';

const ELLIPSIS = '…';

export interface AstronSettingsOptions {
  readonly onCancel: () => void;
}

type FieldName = 'stream' | 'temperature' | 'maxTokens' | 'searchDisable';

interface FieldDef {
  readonly name: FieldName;
  readonly type: 'bool' | 'number';
}

const FIELDS: readonly FieldDef[] = [
  { name: 'stream', type: 'bool' },
  { name: 'temperature', type: 'number' },
  { name: 'maxTokens', type: 'number' },
  { name: 'searchDisable', type: 'bool' },
];

function fieldLabel(field: FieldName): string {
  const labels: Record<FieldName, string> = {
    stream: t('tui.dialogs.astronSettings.fieldStream'),
    temperature: t('tui.dialogs.astronSettings.fieldTemperature'),
    maxTokens: t('tui.dialogs.astronSettings.fieldMaxTokens'),
    searchDisable: t('tui.dialogs.astronSettings.fieldSearchDisable'),
  };
  return labels[field];
}

function maxFieldLabelWidth(): number {
  let max = 0;
  for (const f of FIELDS) {
    const w = fieldLabel(f.name).length;
    if (w > max) max = w;
  }
  return max;
}

export class AstronSettingsComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: AstronSettingsOptions;
  private readonly draft: AstronSettings;
  private selectedIndex = 0;
  private editingIndex: number | null = null;
  private editBuffer = '';
  private saved = false;

  constructor(opts: AstronSettingsOptions) {
    super();
    this.opts = opts;
    this.draft = { ...ASTRON_DEFAULT_SETTINGS };

    // Load current settings from tui.toml.
    loadTuiConfig()
      .then((cfg) => {
        if (cfg.astron) {
          this.draft.stream = cfg.astron.stream;
          this.draft.temperature = cfg.astron.temperature;
          this.draft.maxTokens = cfg.astron.maxTokens;
          this.draft.searchDisable = cfg.astron.searchDisable;
        }
        this.invalidate();
      })
      .catch(() => {
        // Keep defaults.
      });
  }

  handleInput(data: string): void {
    if (this.editingIndex !== null) {
      this.handleEditInput(data);
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }

    if (matchesKey(data, Key.ctrl('s'))) {
      this.save();
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(FIELDS.length - 1, this.selectedIndex + 1);
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const field = FIELDS[this.selectedIndex];
      if (!field) return;
      if (field.type === 'bool') {
        this.toggleBool(field.name);
      } else {
        this.enterEditMode(this.selectedIndex);
      }
      return;
    }
  }

  private handleEditInput(data: string): void {
    if (this.editingIndex === null) return;
    const field = FIELDS[this.editingIndex];
    if (!field || field.type !== 'number') return;

    if (matchesKey(data, Key.escape)) {
      this.exitEditMode(false);
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.exitEditMode(true);
      return;
    }

    if (matchesKey(data, Key.backspace)) {
      this.editBuffer = this.editBuffer.slice(0, -1);
      return;
    }

    const ch = printableChar(data);
    if (ch.length === 1) {
      // For maxTokens, only accept digits.
      if (field.name === 'maxTokens' && !/^\d$/.test(ch)) return;
      // For temperature, accept digits, dot, and minus.
      if (field.name === 'temperature' && !/^[\d.-]$/.test(ch)) return;
      this.editBuffer += ch;
    }
  }

  override render(width: number): string[] {
    const editable = this.editingIndex !== null;
    const hintParts = [t('tui.dialogs.astronSettings.hintNavigate')];
    if (editable) {
      hintParts.push(t('tui.dialogs.astronSettings.hintBackspace'));
    } else {
      hintParts.push(t('tui.dialogs.astronSettings.hintEnter'));
    }
    hintParts.push(t('tui.dialogs.astronSettings.hintSave'), t('tui.dialogs.astronSettings.hintCancel'));

    const labelWidth = maxFieldLabelWidth();

    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', ` ${t('tui.dialogs.astronSettings.title')}`),
      currentTheme.fg('textMuted', ` ${hintParts.join(' · ')}`),
      '',
    ];

    for (let i = 0; i < FIELDS.length; i++) {
      const field = FIELDS[i]!;
      const selected = i === this.selectedIndex;
      const isEditing = i === this.editingIndex;
      lines.push(this.renderField(field, selected, isEditing, labelWidth));
    }

    lines.push('');
    lines.push(this.renderSaveButton());
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));

    return lines.map((line) => truncateToWidth(line, width, ELLIPSIS));
  }

  private renderField(
    field: FieldDef,
    selected: boolean,
    isEditing: boolean,
    labelWidth: number,
  ): string {
    const pointer = selected ? SELECT_POINTER : ' ';
    const prefix = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
    const name = selected
      ? currentTheme.boldFg('primary', fieldLabel(field.name).padEnd(labelWidth))
      : currentTheme.fg('text', fieldLabel(field.name).padEnd(labelWidth));

    if (field.type === 'bool') {
      const value = this.draft[field.name] as boolean;
      const status = value
        ? t('tui.dialogs.astronSettings.statusEnabled')
        : t('tui.dialogs.astronSettings.statusDisabled');
      const statusStyled = value
        ? currentTheme.fg('success', `  ${status}`)
        : currentTheme.fg('textDim', `  ${status}`);
      return `${prefix}${name}${statusStyled}`;
    }

    // Number field
    const numValue = this.draft[field.name] as number;
    const displayValue = isEditing ? this.editBuffer : String(numValue);
    const cursor = isEditing ? '█' : '';
    return `${prefix}${name}  ${currentTheme.fg('text', displayValue)}${cursor}`;
  }

  private renderSaveButton(): string {
    if (this.saved) {
      return ` ${currentTheme.fg('success', t('tui.dialogs.astronSettings.saved'))}`;
    }
    const label = t('tui.dialogs.astronSettings.saveButton');
    return ` ${currentTheme.boldFg('primary', label)}`;
  }

  private toggleBool(name: FieldName): void {
    if (name === 'stream' || name === 'searchDisable') {
      this.draft[name] = !this.draft[name];
      this.saved = false;
    }
  }

  private enterEditMode(index: number): void {
    const field = FIELDS[index];
    if (!field || field.type !== 'number') return;
    this.editingIndex = index;
    this.editBuffer = String(this.draft[field.name]);
  }

  private exitEditMode(commit: boolean): void {
    if (this.editingIndex === null) return;
    const field = FIELDS[this.editingIndex];
    if (!field) return;

    if (commit) {
      if (field.name === 'temperature') {
        const parsed = parseFloat(this.editBuffer);
        if (!Number.isNaN(parsed)) {
          this.draft.temperature = Math.max(0, Math.min(2, parsed));
        }
      } else if (field.name === 'maxTokens') {
        const parsed = parseInt(this.editBuffer, 10);
        if (!Number.isNaN(parsed) && parsed >= 1) {
          this.draft.maxTokens = parsed;
        }
      }
      this.saved = false;
    }

    this.editingIndex = null;
    this.editBuffer = '';
  }

  private async save(): Promise<void> {
    try {
      const cfg = await loadTuiConfig();
      cfg.astron = {
        stream: this.draft.stream,
        temperature: this.draft.temperature,
        maxTokens: this.draft.maxTokens,
        searchDisable: this.draft.searchDisable,
      };
      await saveTuiConfig(cfg);
      this.saved = true;
    } catch {
      // Silently ignore save failures.
    }
  }
}
