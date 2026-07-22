/**
 * Astron settings panel — toggle stream, temperature, max_tokens, search_disable.
 *
 * The panel is presentation-only: it seeds from `opts.initial` and hands the
 * edited values back through `opts.onSave`. The host owns persistence to the
 * `[providers.astron]` section of ~/.kimi-code/config.toml (via the SDK), so
 * this component never touches config or the SDK directly.
 */

import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { t } from '#/i18n';
import { printableChar } from '#/tui/utils/printable-key';

export interface AstronSettings {
  stream: boolean;
  temperature: number;
  maxTokens: number;
  searchDisable: boolean;
}

// searchDisable defaults to true because coding sessions rarely benefit from
// web search and disabling it avoids unnecessary latency and cost.
export const ASTRON_DEFAULT_SETTINGS: AstronSettings = {
  stream: true,
  temperature: 1.0,
  maxTokens: 32768,
  searchDisable: true,
};

const ASTRON_TEMPERATURE_RANGE = { min: 0, max: 2 } as const;
const ASTRON_MAX_TOKENS_MIN = 1;

type FieldName = keyof AstronSettings;

interface FieldDef {
  name: FieldName;
  type: 'bool' | 'number';
}

const FIELDS: readonly FieldDef[] = [
  { name: 'stream', type: 'bool' },
  { name: 'temperature', type: 'number' },
  { name: 'maxTokens', type: 'number' },
  { name: 'searchDisable', type: 'bool' },
];

const ELLIPSIS = '\u2026';

export interface AstronSettingsOptions {
  readonly initial: AstronSettings;
  readonly onSave: (settings: AstronSettings) => void;
  readonly onCancel: () => void;
}

export class AstronSettingsComponent extends Container implements Focusable {
  focused = false;

  private readonly opts: AstronSettingsOptions;
  private settings: AstronSettings;
  private index = 0;
  private editing = false;
  private editBuffer = '';
  private errorMessage: string | null = null;

  constructor(opts: AstronSettingsOptions) {
    super();
    this.opts = opts;
    this.settings = { ...opts.initial };
  }

  private currentField(): FieldDef {
    return FIELDS[this.index]!;
  }

  handleInput(data: string): void {
    const item = this.currentField();

    if (this.editing && item.type === 'number') {
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
        if (matchesKey(data, Key.enter) && this.editBuffer.length > 0) {
          const val = Number(this.editBuffer);
          if (Number.isFinite(val)) {
            if (item.name === 'temperature') {
              if (val < ASTRON_TEMPERATURE_RANGE.min || val > ASTRON_TEMPERATURE_RANGE.max) {
                this.errorMessage = `Value must be between ${ASTRON_TEMPERATURE_RANGE.min} and ${ASTRON_TEMPERATURE_RANGE.max}`;
                return;
              }
            } else if (item.name === 'maxTokens') {
              if (val < ASTRON_MAX_TOKENS_MIN) {
                this.errorMessage = `Value must be at least ${ASTRON_MAX_TOKENS_MIN}`;
                return;
              }
            }
            this.setField(item.name, val);
          }
        }
        this.editing = false;
        this.editBuffer = '';
        return;
      }
      if (matchesKey(data, Key.backspace)) {
        this.editBuffer = this.editBuffer.slice(0, -1);
        return;
      }
      const ch = printableChar(data);
      if (ch !== undefined && /[0-9.]/.test(ch)) {
        this.editBuffer += ch;
        return;
      }
      return;
    }

    if (matchesKey(data, Key.up)) {
      this.index = (this.index - 1 + FIELDS.length) % FIELDS.length;
      this.errorMessage = null;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.index = (this.index + 1) % FIELDS.length;
      this.errorMessage = null;
      return;
    }
    if (matchesKey(data, Key.enter)) {
      if (item.type === 'bool') {
        this.setField(item.name, !this.settings[item.name]);
      } else {
        this.editing = true;
        this.editBuffer = String(this.settings[item.name]);
        this.errorMessage = null;
      }
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.ctrl('s'))) {
      this.opts.onSave(this.settings);
      return;
    }
  }

  override render(width: number): string[] {
    const lines: string[] = [
      currentTheme.fg('primary', '\u2500'.repeat(width)),
      currentTheme.boldFg('primary', ` ${t('tui.dialogs.astronSettings.title')}`),
      currentTheme.fg('textMuted', ` ${t('tui.dialogs.astronSettings.hint')}`),
      '',
    ];

    for (let i = 0; i < FIELDS.length; i++) {
      const item = FIELDS[i]!;
      const selected = i === this.index;
      const pointer = selected ? SELECT_POINTER : ' ';
      const label = t(`tui.dialogs.astronSettings.${item.name}` as `${string}`);

      const prefix = currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `);
      const labelText = selected
        ? currentTheme.boldFg('primary', label)
        : currentTheme.fg('text', label);

      if (item.type === 'bool') {
        const enabled = this.settings[item.name];
        const status = enabled
          ? t('tui.dialogs.astronSettings.on')
          : t('tui.dialogs.astronSettings.off');
        const valueText = enabled
          ? currentTheme.fg('success', ` ${status}`)
          : currentTheme.fg('textDim', ` ${status}`);
        lines.push(truncateToWidth(`${prefix}${labelText}:${valueText}`, width, ELLIPSIS));
      } else if (this.editing && selected) {
        lines.push(truncateToWidth(`${prefix}${labelText}: ${this.editBuffer}\u2588`, width, ELLIPSIS));
      } else {
        const valueText = currentTheme.fg('text', ` ${String(this.settings[item.name])}`);
        lines.push(truncateToWidth(`${prefix}${labelText}:${valueText}`, width, ELLIPSIS));
      }
    }

    if (this.errorMessage !== null) {
      lines.push('');
      lines.push(currentTheme.fg('error', `  ${this.errorMessage}`));
    }

    lines.push('');
    lines.push(currentTheme.fg('primary', '\u2500'.repeat(width)));
    return lines;
  }

  private setField<K extends FieldName>(name: K, value: AstronSettings[K]): void {
    this.settings = { ...this.settings, [name]: value };
  }
}