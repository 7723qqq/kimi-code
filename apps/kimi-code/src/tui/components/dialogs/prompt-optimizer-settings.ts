/**
 * PromptOptimizerSettingsPanel — pick the rewrite's thinking effort and its
 * deadline.
 *
 * Mirrors the Astron settings panel's contract: it seeds from the stored
 * `[prompt_optimizer]` section, edits two fields in place, and hands the whole
 * draft back through `onSave`; the host owns reading and writing config.toml.
 * `effort` unset means the rewrite follows the main agent's level, which is
 * also what the picker's "follow" row restores.
 */

import { Key, matchesKey, truncateToWidth, type Focusable } from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { SELECT_POINTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';

export interface PromptOptimizerSettings {
  /** Milliseconds; `undefined` restores the engine default of 90s. */
  readonly timeoutMs: number | undefined;
  /** `undefined` means "follow the main agent's thinking level". */
  readonly effort: string | undefined;
}

export interface PromptOptimizerSettingsOptions {
  readonly initial: PromptOptimizerSettings;
  /** Efforts the current model supports, in its own order. */
  readonly efforts: readonly string[];
  readonly onSave: (settings: PromptOptimizerSettings) => void;
  readonly onCancel: () => void;
}

/** The picker row that restores "follow the main agent" (effort unset). */
const EFFORT_ANY = '__follow__';

const TIMEOUT_MIN_SECONDS = 10;
const TIMEOUT_MAX_SECONDS = 3600;

export class PromptOptimizerSettingsComponent implements Focusable {
  focused = false;
  private readonly opts: PromptOptimizerSettingsOptions;
  private readonly rows: readonly string[];
  private rowIndex: number;
  /** Seconds as typed; empty means the engine default. */
  private timeoutText: string;
  private error: string | null = null;

  invalidate(): void {}

  constructor(opts: PromptOptimizerSettingsOptions) {
    this.opts = opts;
    this.rows = [...opts.efforts, EFFORT_ANY];
    const current = opts.initial.effort;
    this.rowIndex =
      current === undefined ? this.rows.length - 1 : Math.max(0, this.rows.indexOf(current));
    this.timeoutText =
      opts.initial.timeoutMs === undefined ? '' : String(Math.round(opts.initial.timeoutMs / 1000));
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.rowIndex = (this.rowIndex - 1 + this.rows.length) % this.rows.length;
      this.error = null;
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.rowIndex = (this.rowIndex + 1) % this.rows.length;
      this.error = null;
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.save();
      return;
    }
    const ch = printableChar(data);
    if (/[0-9]/.test(ch)) {
      this.timeoutText = (this.timeoutText + ch).slice(0, 5);
      this.error = null;
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.timeoutText = this.timeoutText.slice(0, -1);
      this.error = null;
    }
  }

  private save(): void {
    const raw = this.timeoutText.trim();
    const effort = this.rows[this.rowIndex];
    if (raw === '') {
      this.opts.onSave({ timeoutMs: undefined, effort });
      return;
    }
    const seconds = Number(raw);
    if (
      !Number.isFinite(seconds) ||
      seconds < TIMEOUT_MIN_SECONDS ||
      seconds > TIMEOUT_MAX_SECONDS
    ) {
      this.error = t('tui.dialogs.promptOptimizerSettings.timeoutOutOfRange', {
        min: TIMEOUT_MIN_SECONDS,
        max: TIMEOUT_MAX_SECONDS,
      });
      return;
    }
    this.opts.onSave({ timeoutMs: Math.round(seconds) * 1000, effort });
  }

  render(width: number): string[] {
    const rule = currentTheme.fg('primary', '─'.repeat(width));
    const lines: string[] = [
      rule,
      currentTheme.boldFg('primary', ` ${t('tui.dialogs.promptOptimizerSettings.title')}`),
      currentTheme.fg('textMuted', ` ${t('tui.dialogs.promptOptimizerSettings.hint')}`),
      '',
    ];

    const label = (value: string): string =>
      value === EFFORT_ANY ? t('tui.dialogs.promptOptimizerSettings.followMain') : value;
    for (let i = 0; i < this.rows.length; i++) {
      const selected = i === this.rowIndex;
      const pointer = selected ? SELECT_POINTER : ' ';
      const text = label(this.rows[i]!);
      lines.push(
        currentTheme.fg(selected ? 'primary' : 'textDim', `  ${pointer} `) +
          (selected ? currentTheme.boldFg('primary', text) : currentTheme.fg('text', text)),
      );
    }

    lines.push('');
    lines.push(
      currentTheme.fg('textMuted', ` ${t('tui.dialogs.promptOptimizerSettings.timeoutLabel')} `) +
        currentTheme.fg('text', this.timeoutText) +
        (this.timeoutText === ''
          ? currentTheme.fg(
              'textMuted',
              ` (${t('tui.dialogs.promptOptimizerSettings.timeoutDefault')})`,
            )
          : currentTheme.fg('textMuted', 's')),
    );
    if (this.error !== null) {
      lines.push(currentTheme.fg('warning', ` ${this.error}`));
    }
    lines.push('');
    lines.push(rule);
    return lines.map((line) => truncateToWidth(line, width));
  }
}
